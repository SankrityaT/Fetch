import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

// Native screen recorder: ScreenCaptureKit in, AVAssetWriter out.
//
// The Chromium path (getDisplayMedia + MediaRecorder) tops out at whatever the
// renderer can encode in software, which on a 5.9MP Retina panel means dropped
// frames and a starved bitrate. This captures at an explicit size and frame rate
// and encodes on the media engine, so the app being recorded keeps the CPU.
//
// Video, system audio and microphone all arrive on one stream, already sharing a
// clock, which is the other thing the old path could not do: it had to mix audio
// in the renderer and hope the drift stayed small.
//
// Protocol: newline commands on stdin (pause / resume / stop), newline JSON events
// on stdout. Everything the app needs to know comes back as an event, so the caller
// never has to guess whether a take actually started.

// ---------- arguments ----------
struct Options {
    var out = ""
    var displayID: CGDirectDisplayID?
    var windowID: CGWindowID?
    var fps: Int32 = 60
    var hevc = false
    var systemAudio = false
    var mic = false
    var micDeviceID: String?
    var showsCursor = true
    var bitrate: Int?          // bits per second; derived from the frame size when absent
}

func parseArgs() -> Options {
    var o = Options()
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        switch a {
        case "--out":       o.out = it.next() ?? ""
        case "--display":   if let v = it.next(), let n = UInt32(v) { o.displayID = n }
        case "--window":    if let v = it.next(), let n = UInt32(v) { o.windowID = n }
        case "--fps":       if let v = it.next(), let n = Int32(v) { o.fps = max(1, min(120, n)) }
        case "--hevc":      o.hevc = true
        case "--system-audio": o.systemAudio = true
        case "--mic":       o.mic = true
        case "--mic-device": o.micDeviceID = it.next()
        case "--no-cursor": o.showsCursor = false
        case "--bitrate":   if let v = it.next(), let n = Int(v) { o.bitrate = n }
        default: break
        }
    }
    return o
}

// ---------- events ----------
let stdoutQueue = DispatchQueue(label: "fetch.recorder.stdout")
func emit(_ dict: [String: Any]) {
    stdoutQueue.async {
        guard let d = try? JSONSerialization.data(withJSONObject: dict),
              var s = String(data: d, encoding: .utf8) else { return }
        s += "\n"
        FileHandle.standardOutput.write(s.data(using: .utf8)!)
    }
}
func fail(_ message: String) -> Never {
    emit(["event": "error", "message": message])
    // give the async write a moment to land before the process goes away
    stdoutQueue.sync {}
    exit(1)
}

// ---------- recorder ----------
@available(macOS 13.0, *)
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let opts: Options
    var stream: SCStream?
    var writer: AVAssetWriter!
    var videoIn: AVAssetWriterInput!
    var sysAudioIn: AVAssetWriterInput?
    var micIn: AVAssetWriterInput?

    private let lock = NSLock()
    private var started = false
    private var paused = false
    private var finished = false
    private var frames = 0
    private var dropped = 0

    // Pausing works by not appending, then shifting every later timestamp back by
    // however long the pause lasted, so the file has no silent gap in it.
    private var sessionStart: CMTime = .invalid
    private var pausedAt: CMTime = .invalid
    private var pausedTotal: CMTime = .zero

    init(opts: Options) { self.opts = opts }

    func start() async {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        } catch {
            fail("could not read shareable content: \(error.localizedDescription). Screen Recording permission is probably not granted.")
        }

        var filter: SCContentFilter
        var width = 0, height = 0

        if let wid = opts.windowID {
            guard let win = content.windows.first(where: { $0.windowID == wid }) else {
                fail("window \(wid) is not on screen any more")
            }
            filter = SCContentFilter(desktopIndependentWindow: win)
            width = Int(win.frame.width); height = Int(win.frame.height)
            // a window's frame is in points, so scale to the backing store
            let scale = content.displays.first(where: { $0.frame.intersects(win.frame) })
                .map { d -> Int in Int((CGDisplayScreenSize(d.displayID).width > 0) ? 2 : 2) } ?? 2
            width *= scale; height *= scale
        } else {
            let display: SCDisplay
            if let did = opts.displayID, let d = content.displays.first(where: { $0.displayID == did }) {
                display = d
            } else if let d = content.displays.first {
                display = d
            } else {
                fail("no displays available to capture")
            }
            filter = SCContentFilter(display: display, excludingWindows: [])
            // SCDisplay width/height are points; mode gives the real pixels
            let mode = CGDisplayCopyDisplayMode(display.displayID)
            width = mode?.pixelWidth ?? display.width
            height = mode?.pixelHeight ?? display.height
        }

        // even dimensions keep every H.264/HEVC encoder happy
        width -= width % 2; height -= height % 2
        guard width > 0, height > 0 else { fail("could not work out the capture size") }

        let cfg = SCStreamConfiguration()
        cfg.width = width
        cfg.height = height
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: opts.fps)
        cfg.showsCursor = opts.showsCursor
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.colorSpaceName = CGColorSpace.sRGB
        cfg.queueDepth = 8
        cfg.capturesAudio = opts.systemAudio
        if opts.systemAudio {
            cfg.sampleRate = 48000
            cfg.channelCount = 2
            cfg.excludesCurrentProcessAudio = true    // never record our own UI sounds
        }
        if opts.mic, #available(macOS 15.0, *) {
            cfg.captureMicrophone = true
            if let id = opts.micDeviceID, !id.isEmpty { cfg.microphoneCaptureDeviceID = id }
        }

        setUpWriter(width: width, height: height)

        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        let q = DispatchQueue(label: "fetch.recorder.samples", qos: .userInitiated)
        do {
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: q)
            if opts.systemAudio { try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: q) }
            if opts.mic, #available(macOS 15.0, *) {
                try s.addStreamOutput(self, type: .microphone, sampleHandlerQueue: q)
            }
            try await s.startCapture()
        } catch {
            fail("could not start capture: \(error.localizedDescription)")
        }
        stream = s

        emit(["event": "started",
              "startedAt": Int(Date().timeIntervalSince1970 * 1000),
              "width": width, "height": height, "fps": Int(opts.fps),
              "codec": opts.hevc ? "hevc" : "h264",
              "systemAudio": opts.systemAudio, "mic": opts.mic])
    }

    private func setUpWriter(width: Int, height: Int) {
        let url = URL(fileURLWithPath: opts.out)
        try? FileManager.default.removeItem(at: url)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        do {
            writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        } catch {
            fail("could not open \(opts.out) for writing: \(error.localizedDescription)")
        }

        // Screen content is mostly static with hard edges, so it wants a much larger
        // budget than camera footage of the same size would.
        let bitrate = opts.bitrate ?? min(120_000_000, max(16_000_000,
            Int(Double(width * height * Int(opts.fps)) * 0.11)))

        var props: [String: Any] = [
            AVVideoAverageBitRateKey: bitrate,
            AVVideoExpectedSourceFrameRateKey: Int(opts.fps),
            AVVideoMaxKeyFrameIntervalKey: Int(opts.fps) * 2,
            AVVideoAllowFrameReorderingKey: false,
        ]
        if !opts.hevc { props[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel }

        videoIn = AVAssetWriterInput(mediaType: .video,
                                     outputSettings: [
                                        AVVideoCodecKey: opts.hevc ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
                                        AVVideoWidthKey: width,
                                        AVVideoHeightKey: height,
                                        AVVideoCompressionPropertiesKey: props,
                                     ])
        videoIn.expectsMediaDataInRealTime = true
        guard writer.canAdd(videoIn) else { fail("the writer rejected the video settings") }
        writer.add(videoIn)

        let audioSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 192_000,
        ]
        if opts.systemAudio {
            let a = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            a.expectsMediaDataInRealTime = true
            if writer.canAdd(a) { writer.add(a); sysAudioIn = a }
        }
        if opts.mic {
            let m = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            m.expectsMediaDataInRealTime = true
            if writer.canAdd(m) { writer.add(m); micIn = m }
        }

        guard writer.startWriting() else {
            fail("the writer would not start: \(writer.error?.localizedDescription ?? "unknown")")
        }
    }

    // ---------- sample routing ----------
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard CMSampleBufferDataIsReady(sb) else { return }

        // A screen sample with nothing new in it still arrives; writing those would
        // inflate the file for no picture.
        if type == .screen, let attach = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let raw = attach.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw), status != .complete {
            return
        }

        lock.lock()
        if finished { lock.unlock(); return }

        let pts = CMSampleBufferGetPresentationTimeStamp(sb)

        if !started {
            guard type == .screen else { lock.unlock(); return }   // start the clock on a picture
            started = true
            sessionStart = pts
            writer.startSession(atSourceTime: .zero)
        }
        if paused { lock.unlock(); return }

        let offset = CMTimeAdd(sessionStart, pausedTotal)
        let shifted = CMTimeSubtract(pts, offset)
        let isVideo = type == .screen
        lock.unlock()

        guard shifted >= .zero else { return }

        switch type {
        case .screen:
            guard videoIn.isReadyForMoreMediaData else { lock.lock(); dropped += 1; lock.unlock(); return }
            if let out = retimed(sb, to: shifted) {
                videoIn.append(out)
                lock.lock(); frames += 1; lock.unlock()
            }
        case .audio:
            guard let a = sysAudioIn, a.isReadyForMoreMediaData else { return }
            if let out = retimed(sb, to: shifted) { a.append(out) }
        default:
            guard let m = micIn, m.isReadyForMoreMediaData else { return }
            if let out = retimed(sb, to: shifted) { m.append(out) }
        }
        _ = isVideo
    }

    private func retimed(_ sb: CMSampleBuffer, to pts: CMTime) -> CMSampleBuffer? {
        var timing = CMSampleTimingInfo(duration: CMSampleBufferGetDuration(sb),
                                        presentationTimeStamp: pts,
                                        decodeTimeStamp: .invalid)
        var out: CMSampleBuffer?
        guard CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault,
                                                    sampleBuffer: sb, sampleTimingEntryCount: 1,
                                                    sampleTimingArray: &timing,
                                                    sampleBufferOut: &out) == noErr else { return nil }
        return out
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["event": "error", "message": "capture stopped: \(error.localizedDescription)"])
        Task { await finish() }
    }

    // ---------- control ----------
    func pause() {
        lock.lock()
        defer { lock.unlock() }
        guard started, !paused, !finished else { return }
        paused = true
        pausedAt = CMClockGetTime(CMClockGetHostTimeClock())
        emit(["event": "paused"])
    }

    func resume() {
        lock.lock()
        defer { lock.unlock() }
        guard paused, !finished else { return }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        if pausedAt.isValid { pausedTotal = CMTimeAdd(pausedTotal, CMTimeSubtract(now, pausedAt)) }
        pausedAt = .invalid
        paused = false
        emit(["event": "resumed"])
    }

    // The state flip is deliberately synchronous: NSLock must not be held across an
    // await, and this is the one place two callers can race to end the take.
    private func claimFinish() -> (Bool, Int, Int) {
        lock.lock()
        defer { lock.unlock() }
        if finished { return (false, 0, 0) }
        finished = true
        return (true, frames, dropped)
    }

    func finish() async {
        let (proceed, f, d) = claimFinish()
        guard proceed else { return }

        try? await stream?.stopCapture()
        videoIn?.markAsFinished()
        sysAudioIn?.markAsFinished()
        micIn?.markAsFinished()

        await writer.finishWriting()

        if writer.status == .failed {
            emit(["event": "error", "message": writer.error?.localizedDescription ?? "writing failed"])
            stdoutQueue.sync {}
            exit(1)
        }
        emit(["event": "stopped", "file": opts.out, "frames": f, "dropped": d,
              "stoppedAt": Int(Date().timeIntervalSince1970 * 1000)])
        stdoutQueue.sync {}
        exit(0)
    }
}

// ---------- main ----------
let opts = parseArgs()
guard !opts.out.isEmpty else { fail("--out is required") }
guard #available(macOS 13.0, *) else { fail("ScreenCaptureKit needs macOS 13 or newer") }

let recorder = Recorder(opts: opts)

// stdin is the control channel: one command per line
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        switch line.trimmingCharacters(in: .whitespaces) {
        case "pause":  recorder.pause()
        case "resume": recorder.resume()
        case "stop":   Task { await recorder.finish() }
        default:       break
        }
    }
    // stdin closed: the parent went away, so do not leave a half-written file
    Task { await recorder.finish() }
}

// SIGTERM should still produce a playable file
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
term.setEventHandler { Task { await recorder.finish() } }
term.resume()
signal(SIGTERM, SIG_IGN)

Task { await recorder.start() }
RunLoop.main.run()
