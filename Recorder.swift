import AppKit
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
    // Windows the policy says must never be captured. Handed to ScreenCaptureKit so
    // they are absent from the frame, rather than blurred or cropped afterwards: the
    // pixels never exist, so nothing sensitive is ever written to disk.
    var excludeWindowIDs: [CGWindowID] = []
    var fps: Int32 = 60
    var hevc = false
    var systemAudio = false
    var mic = false
    var micDeviceID: String?
    var showsCursor = true
    var bitrate: Int?          // bits per second; derived from the frame size when absent
    // A generated take instead of the screen, for measuring sync without a speaker
    // (TestSource below). "lead=2.3,gap=4.5-5.5": sound starts 2.3 s after the picture
    // and stalls for a second, the two things a capture stream really does.
    var testSource: String?
}

func parseArgs() -> Options {
    var o = Options()
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        switch a {
        case "--out":       o.out = it.next() ?? ""
        case "--display":   if let v = it.next(), let n = UInt32(v) { o.displayID = n }
        case "--window":    if let v = it.next(), let n = UInt32(v) { o.windowID = n }
        case "--exclude":   if let v = it.next() { o.excludeWindowIDs = v.split(separator: ",").compactMap { UInt32($0) } }
        case "--fps":       if let v = it.next(), let n = Int32(v) { o.fps = max(1, min(120, n)) }
        case "--hevc":      o.hevc = true
        case "--system-audio": o.systemAudio = true
        case "--mic":       o.mic = true
        case "--mic-device": o.micDeviceID = it.next()
        case "--no-cursor": o.showsCursor = false
        case "--bitrate":   if let v = it.next(), let n = Int(v) { o.bitrate = n }
        case "--test-source": o.testSource = it.next() ?? ""
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
    var config: SCStreamConfiguration?
    // A window take's sound, on a stream of its own (see start)
    var soundStream: SCStream?
    private var soundFilter: SCContentFilter?
    var writer: AVAssetWriter!
    var videoIn: AVAssetWriterInput!
    var sysAudioIn: AVAssetWriterInput?
    var micIn: AVAssetWriterInput?

    private let lock = NSLock()
    // start() has returned, one way or the other. finish() waits for it (waitForStart),
    // so a Stop, a closed stdin or main.js's SIGTERM while a capture is still starting
    // never exits under a startCapture replayd has not answered yet.
    private var startDone = false
    private var started = false
    private var paused = false
    private var finished = false
    // Paused by a lost capture rather than by the person, so it ends when capture returns
    private var interrupted = false
    private var autoPaused = false
    private var frames = 0
    private var dropped = 0

    // Pausing works by not appending, then shifting every later timestamp back by
    // however long the pause lasted, so the file has no silent gap in it.
    private var sessionStart: CMTime = .invalid
    private var pausedAt: CMTime = .invalid
    private var pausedTotal: CMTime = .zero

    // ScreenCaptureKit sends nothing at all while a window is covered or nothing on
    // screen changes, so without these the file would end at the last change instead
    // of at Stop. The last picture is re-appended through a still stretch and held to
    // the stop time. Touched only on sampleQueue, which serialises every video append.
    private var lastPixel: CVPixelBuffer?
    private var lastVideoPTS: CMTime = .invalid     // last appended, real or held
    private var lastFreshPTS: CMTime = .invalid     // last picture that actually arrived
    private var stillMax = 0.0                      // longest stretch with nothing new, seconds
    private var holdTimer: DispatchSourceTimer?

    // Where each sound track has been written up to, on the file's clock, keyed by the
    // stream output type. A track is written from zero to Stop with no holes, because
    // AAC in a .mov is a run of packets and not a list of times: a track that starts
    // 2.3 s late is only in sync for a reader that honours the edit list, and every
    // ffmpeg graph that trims it (asetpts=PTS-STARTPTS) or decodes it to a wav (the
    // transcript, the waveform) puts its first sample at zero instead. A stall in the
    // middle is the same fault arriving later. So silence is written into every gap,
    // and a sample's place in the file is its place in time. Touched on sampleQueue.
    //
    // The stalls were ours. The writer interleaves, so while a still window sends no
    // pictures its audio input reports not ready, and every buffer that arrived then was
    // dropped: 20 ms at a time, three to five times in a 7 s take, and each one moved
    // all the sound after it earlier. Sound now waits in a queue for the picture to
    // catch up, and silence stands in only for what never arrived.
    private var soundNext: [Int: CMTime] = [:]
    private var soundFormat: [Int: CMFormatDescription] = [:]
    private var soundQueue: [Int: [(CMSampleBuffer, CMTime)]] = [:]
    private var soundHeard: Set<Int> = []
    private var soundLead: [Int: Double] = [:]
    private var soundGaps: [Int: (n: Int, s: Double)] = [:]
    private var soundTail: [Int: Double] = [:]
    private var soundLost: [Int: Double] = [:]
    private var soundTrim: [Int: Double] = [:]
    // A gap shorter than this is timestamp jitter, not a stall: SCK hands audio over in
    // 10 to 21 ms buffers, and filling a jitter would push the sound late by it.
    // soundNext is the sum of what was written, never a buffer's own stamp, so a sound
    // clock that runs slow or fast against the host clock builds up past this slack and
    // is corrected in either direction: silence when the file falls behind, the head
    // of a buffer let go when it runs ahead. Reset to each stamp, drift of 300 ppm was
    // 17 ms off by a minute and 2000 ppm 116 ms, with nothing reported.
    private let soundSlack = 0.005
    // How much sound may wait for the picture. A window still for longer than this
    // loses its oldest sound to silence rather than growing without bound.
    private let soundWait = 3.0
    private var testSource: TestSource?

    init(opts: Options) { self.opts = opts }

    func start() async {
        defer { markStartDone() }
        // A generated take needs no screen and no permission: it goes through the same
        // route, writer and padding as a real one, which is the part being measured
        if let spec = opts.testSource {
            setUpWriter(width: 64, height: 64)
            testSource = TestSource(spec: spec, fps: Int(opts.fps), queue: sampleQueue) { [weak self] sb, type in self?.route(sb, type) }
            testSource?.run()
            startHolding()
            emit(["event": "started", "startedAt": Int(Date().timeIntervalSince1970 * 1000),
                  "width": 64, "height": 64, "fps": Int(opts.fps), "codec": "h264", "systemAudio": true, "mic": false])
            return
        }
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        } catch {
            fail("could not read shareable content: \(error.localizedDescription). Screen Recording permission is probably not granted.")
        }
        // stopped while that was being read: nothing has been started, so nothing to stop
        if isFinished() { return }

        var filter: SCContentFilter
        var width = 0, height = 0

        if let wid = opts.windowID {
            guard let win = content.windows.first(where: { $0.windowID == wid }) else {
                fail("window \(wid) is not on screen any more")
            }
            filter = SCContentFilter(desktopIndependentWindow: win)
            // A window filter hears only its app's own process, and a browser (Chrome,
            // Electron, Safari) plays every page from a helper process that belongs to
            // no app, so a browser window's take came out digitally silent. Its sound
            // comes from the display instead, on a stream of its own.
            //
            // That filter names no application, and this is load bearing. A filter that
            // names apps, to hear them or to leave them out, has replayd watch every
            // process of every one of them and rebuild its audio queue whenever one
            // starts, quits or changes state. Rebuilt while a buffer is in flight, the
            // queue calls back into a capture it has already freed, and replayd, which
            // does all screen capture on this Mac, goes down with it: 25 times between
            // Sep 18 and Sep 21, every one in _SCAudioCapture_handleInputBuffer, and the
            // newest with the process monitor freeing the capture session on another
            // thread. Leaving the other apps out cost the whole Mac its screen capture
            // for up to 20 minutes at a time. So a window take with sound hears what the
            // display plays, the same as a display take does.
            if opts.systemAudio, let d = content.displays.first(where: { $0.frame.intersects(win.frame) }) ?? content.displays.first {
                soundFilter = SCContentFilter(display: d, excludingWindows: [])
            }
            // A window's frame is in points. Derive the backing scale from the display
            // it sits on by comparing that display's pixel mode against its point size,
            // rather than assuming 2x: a non-Retina external monitor is 1x.
            // CGDisplayScreenSize is deliberately not used here, it needs a GUI
            // connection this process does not have and aborts with CGS_REQUIRE_INIT.
            var scale = 2.0
            if let d = content.displays.first(where: { $0.frame.intersects(win.frame) }),
               let mode = CGDisplayCopyDisplayMode(d.displayID), d.width > 0 {
                scale = Double(mode.pixelWidth) / Double(d.width)
            }
            width = Int((win.frame.width * scale).rounded())
            height = Int((win.frame.height * scale).rounded())
        } else {
            let display: SCDisplay
            if let did = opts.displayID {
                // Falling back to displays.first here would silently record the wrong
                // screen on a multi-display Mac. Failing lets the app drop to the
                // Chromium path, which does honour the chosen display.
                guard let d = content.displays.first(where: { $0.displayID == did }) else {
                    fail("display \(did) is not attached any more")
                }
                display = d
            } else if let d = content.displays.first {
                display = d
            } else {
                fail("no displays available to capture")
            }
            // Ids that are no longer on screen simply drop out here, which is the right
            // behaviour: a closed window cannot be captured anyway.
            let excluded = content.windows.filter { opts.excludeWindowIDs.contains($0.windowID) }
            if !excluded.isEmpty {
                FileHandle.standardError.write("excluding \(excluded.count) protected window(s)\n".data(using: .utf8)!)
            }
            filter = SCContentFilter(display: display, excludingWindows: excluded)
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
        // One stream captures sound, never two. A window take's sound is the sound
        // stream's, so the picture's stream captures none: it used to capture it anyway
        // with nowhere to send it, a second audio queue in replayd whose filter names
        // the window's app and is watched for it (see above). A window take whose sound
        // stream could not be set up is silent rather than heard through the window.
        cfg.capturesAudio = opts.systemAudio && opts.windowID == nil
        if cfg.capturesAudio {
            cfg.sampleRate = 48000
            cfg.channelCount = 2
            cfg.excludesCurrentProcessAudio = false   // see soundOnly()
        }
        if opts.mic, #available(macOS 15.0, *) {
            cfg.captureMicrophone = true
            if let id = opts.micDeviceID, !id.isEmpty { cfg.microphoneCaptureDeviceID = id }
        }

        setUpWriter(width: width, height: height)
        config = cfg

        // The sound stream first, so it is already running when the first picture starts
        // the clock. Opened second, the 0.7 to 2.3 s it takes to start was sound that was
        // never captured at all, and a narrator's first words went with it.
        //
        // Stop can land while either one is still starting. finish() waits for this to
        // return, and this stops whatever it opened, each awaited, sound first, before
        // it does: a stream is never left starting or running under an exit.
        if let sf = soundFilter { await openSoundStream(sf) }
        if isFinished() { await stopSound(); return }
        let s: SCStream
        do {
            s = try await openStream(filter)
        } catch {
            // the sound is already running, and a process that exits under a live capture
            // leaves replayd to tear it down on its own
            await stopSound()
            fail("could not start capture: \(error.localizedDescription)")
        }
        if isFinished() {
            await stopSound()
            await stop(s, "picture", outputs: pictureOutputs)
            return
        }
        stream = s
        startHolding()

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
        route(sb, type)
    }

    func route(_ sb: CMSampleBuffer, _ type: SCStreamOutputType) {
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
            // The wall-clock moment of frame zero, back-dated from the host clock by
            // however long this sample took to arrive. The app starts its cursor and
            // camera clocks here, not at "started", which lands before any frame.
            let lag = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), pts))
            emit(["event": "firstFrame",
                  "at": Int((Date().timeIntervalSince1970 - max(0, lag)) * 1000)])
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
            // A held copy can be stamped a few ms after this frame was captured, and the
            // writer fails on a timestamp that goes backwards. Nudge it just past instead
            // of dropping it: it may be the only change for a while.
            var at = shifted
            if lastVideoPTS.isValid, at <= lastVideoPTS { at = CMTimeAdd(lastVideoPTS, CMTime(value: 1, timescale: 1000)) }
            if let out = retimed(sb, to: at), videoIn.append(out) {
                if lastFreshPTS.isValid { stillMax = max(stillMax, CMTimeGetSeconds(CMTimeSubtract(at, lastFreshPTS))) }
                lastPixel = CMSampleBufferGetImageBuffer(sb)
                lastVideoPTS = at; lastFreshPTS = at
                lock.lock(); frames += 1; lock.unlock()
            }
            drainSound()
        default:
            queueSound(sb, at: shifted, key: type.rawValue)
        }
        _ = isVideo
    }

    // ---------- sound on the picture's clock ----------
    private func soundInput(_ key: Int) -> AVAssetWriterInput? {
        key == SCStreamOutputType.audio.rawValue ? sysAudioIn : micIn
    }

    private func queueSound(_ sb: CMSampleBuffer, at t: CMTime, key: Int) {
        guard soundInput(key) != nil, let fmt = CMSampleBufferGetFormatDescription(sb) else { return }
        soundFormat[key] = fmt
        var q = soundQueue[key] ?? []
        q.append((sb, t))
        while let head = q.first, q.count > 1, CMTimeGetSeconds(CMTimeSubtract(t, head.1)) > soundWait {
            soundLost[key, default: 0] += CMTimeGetSeconds(soundLength(head.0, fmt))
            q.removeFirst()
        }
        soundQueue[key] = q
        drainSound(key)
    }

    private func drainSound() { for k in soundQueue.keys { drainSound(k) } }

    // Writes what is waiting, in order, each sample at its own time: a hole before it is
    // filled first, so the packets that follow cannot slide into it
    private func drainSound(_ key: Int) {
        guard let input = soundInput(key), let fmt = soundFormat[key] else { return }
        while let (sb, t) = soundQueue[key]?.first, input.isReadyForMoreMediaData {
            let next = soundNext[key] ?? .zero        // every track starts with the picture
            if CMTimeGetSeconds(CMTimeSubtract(t, next)) > soundSlack {
                let filled = fillSilence(input, fmt, from: next, to: t)
                soundNext[key] = CMTimeAdd(next, CMTime(seconds: filled, preferredTimescale: 48000))
                if !soundHeard.contains(key) { soundLead[key, default: 0] += filled }
                else { let g = soundGaps[key] ?? (0, 0); soundGaps[key] = (g.n + 1, g.s + filled) }
                if filled <= 0 { return }
                continue
            }
            soundQueue[key]?.removeFirst()
            soundHeard.insert(key)
            var piece = sb
            let over = CMTimeGetSeconds(CMTimeSubtract(next, t))
            if over > soundSlack {
                // the file already reaches past this buffer's start, so its head goes
                guard let cut = headCut(sb, fmt, seconds: over, key: key) else { continue }
                piece = cut
            }
            if let out = retimed(piece, to: next), input.append(out) { soundNext[key] = CMTimeAdd(next, soundLength(piece, fmt)) }
        }
    }

    // A buffer without its first `seconds`, or nil when all of it is behind the file
    private func headCut(_ sb: CMSampleBuffer, _ fmt: CMFormatDescription, seconds: Double, key: Int) -> CMSampleBuffer? {
        let rate = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee.mSampleRate ?? 48000
        let n = CMSampleBufferGetNumSamples(sb)
        let drop = min(n, Int((seconds * rate).rounded()))
        soundTrim[key, default: 0] += Double(drop) / rate
        if drop >= n { return nil }
        var out: CMSampleBuffer?
        guard CMSampleBufferCopySampleBufferForRange(allocator: kCFAllocatorDefault, sampleBuffer: sb,
                                                     sampleRange: CFRange(location: drop, length: n - drop),
                                                     sampleBufferOut: &out) == noErr else { return nil }
        return out
    }

    private func soundLength(_ sb: CMSampleBuffer, _ fmt: CMFormatDescription) -> CMTime {
        let rate = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee.mSampleRate ?? 48000
        return CMTime(value: CMTimeValue(CMSampleBufferGetNumSamples(sb)), timescale: CMTimeScale(rate))
    }

    // Silence from one time to another, in the source's own format so the encoder sees
    // one stream. Written in pieces of at most a second, stopping if the writer is full:
    // a shorter pad is the old behaviour, never a failed take. Returns seconds written.
    @discardableResult
    private func fillSilence(_ input: AVAssetWriterInput, _ fmt: CMFormatDescription, from: CMTime, to: CMTime) -> Double {
        guard let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee,
              asbd.mFormatID == kAudioFormatLinearPCM, asbd.mBytesPerFrame > 0, asbd.mSampleRate > 0 else { return 0 }
        let rate = asbd.mSampleRate
        let planes = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0 ? Int(asbd.mChannelsPerFrame) : 1
        var left = Int((CMTimeGetSeconds(CMTimeSubtract(to, from)) * rate).rounded())
        var at = from
        var written = 0
        while left > 0, input.isReadyForMoreMediaData {
            let n = min(left, Int(rate))
            let bytes = n * Int(asbd.mBytesPerFrame) * planes
            var block: CMBlockBuffer?
            var sb: CMSampleBuffer?
            guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: bytes,
                                                     blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
                                                     offsetToData: 0, dataLength: bytes,
                                                     flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr,
                  let block, CMBlockBufferFillDataBytes(with: 0, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes) == noErr,
                  CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: kCFAllocatorDefault, dataBuffer: block,
                                                                       formatDescription: fmt, sampleCount: n,
                                                                       presentationTimeStamp: at, packetDescriptions: nil,
                                                                       sampleBufferOut: &sb) == noErr,
                  let sb, input.append(sb) else { break }
            at = CMTimeAdd(at, CMTime(value: CMTimeValue(n), timescale: CMTimeScale(rate)))
            left -= n; written += n
        }
        return Double(written) / rate
    }

    // What each track needed, so a take whose sound arrived late says so rather than
    // hiding it in a clean file
    private func soundReport() -> [[String: Any]] {
        let ms = { (s: Double?) in Int(((s ?? 0) * 1000).rounded()) }
        return soundNext.keys.sorted().map { k in
            let g = soundGaps[k] ?? (0, 0)
            return ["track": k == SCStreamOutputType.audio.rawValue ? "system" : "mic",
                    "leadMs": ms(soundLead[k]), "gaps": g.n, "gapMs": ms(g.s),
                    "lostMs": ms(soundLost[k]), "tailMs": ms(soundTail[k]), "trimMs": ms(soundTrim[k])]
        }
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

    // ---------- holding the picture ----------
    // Re-appends the last picture twice a second through a still stretch, so the file
    // is continuous (players and ffmpeg both handle a dense track better than one frame
    // lasting ten seconds) and a take whose window was covered still runs to Stop.
    private func startHolding() {
        let t = DispatchSource.makeTimerSource(queue: sampleQueue)
        t.schedule(deadline: .now() + 0.25, repeating: 0.25)
        t.setEventHandler { [weak self] in self?.holdIfStill() }
        t.resume()
        holdTimer = t
    }

    private func holdIfStill() {
        lock.lock()
        guard started, !paused, !finished else { lock.unlock(); return }
        let now = CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), CMTimeAdd(sessionStart, pausedTotal))
        lock.unlock()
        guard lastVideoPTS.isValid, CMTimeGetSeconds(CMTimeSubtract(now, lastVideoPTS)) >= 0.5 else { return }
        appendHeld(at: now)
        drainSound()
    }

    @discardableResult
    private func appendHeld(at pts: CMTime) -> Bool {
        guard let px = lastPixel, videoIn.isReadyForMoreMediaData,
              !lastVideoPTS.isValid || pts > lastVideoPTS else { return false }
        var fmt: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: px,
                                                           formatDescriptionOut: &fmt) == noErr, let fmt else { return false }
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: pts, decodeTimeStamp: .invalid)
        var sb: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: px,
                                                       formatDescription: fmt, sampleTiming: &timing,
                                                       sampleBufferOut: &sb) == noErr, let sb,
              videoIn.append(sb) else { return false }
        lastVideoPTS = pts
        return true
    }

    // Called on sampleQueue once capture has stopped: the last picture runs to the stop
    // time rather than to the last moment something changed.
    private func holdToEnd(_ end: CMTime) {
        holdTimer?.cancel(); holdTimer = nil
        guard end.isValid, lastVideoPTS.isValid, end > lastVideoPTS else { return }
        let frame = CMTime(value: 1, timescale: opts.fps)
        let last = CMTimeSubtract(end, frame)
        if last > lastVideoPTS { appendHeld(at: last) }
        if lastFreshPTS.isValid { stillMax = max(stillMax, CMTimeGetSeconds(CMTimeSubtract(end, lastFreshPTS))) }
        // The picture is complete, so whatever sound waited on it can go in now. The writer
        // frees its audio input as the encoder catches up, so this gives it a moment.
        for _ in 0..<200 {
            drainSound()
            if soundQueue.values.allSatisfy({ $0.isEmpty }) { break }
            usleep(5000)
        }
        // and the sound runs to Stop too: the last buffers still in flight are lost with
        // the stream, and a short track is what cut an app preview to its length
        for (k, next) in soundNext {
            guard let fmt = soundFormat[k], CMTimeGetSeconds(CMTimeSubtract(end, next)) > soundSlack,
                  let input = soundInput(k) else { continue }
            soundTail[k] = fillSilence(input, fmt, from: next, to: end)
        }
        writer.endSession(atSourceTime: end)
    }

    private let sampleQueue = DispatchQueue(label: "fetch.recorder.samples", qos: .userInitiated)
    private func openStream(_ filter: SCContentFilter) async throws -> SCStream {
        guard let cfg = config else { throw CocoaError(.featureUnsupported) }
        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        if cfg.capturesAudio { try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue) }
        if opts.mic, #available(macOS 15.0, *) {
            try s.addStreamOutput(self, type: .microphone, sampleHandlerQueue: sampleQueue)
        }
        try await s.startCapture()
        return s
    }

    // Sound only: its pictures have no output and are dropped, so they are kept tiny.
    // Same host clock as the picture, so its samples line up through the one writer.
    // Losing it loses the sound, never the take.
    private func openSoundStream(_ f: SCContentFilter) async {
        let s = SCStream(filter: f, configuration: soundOnly(), delegate: self)
        do {
            try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
            try await s.startCapture()
            soundStream = s
        } catch {
            FileHandle.standardError.write("no system audio for this window: \(error.localizedDescription)\n".data(using: .utf8)!)
        }
    }

    // excludesCurrentProcessAudio stays off. This helper never plays a sound, so there
    // is nothing of ours to leave out, and asking for it has replayd add this process to
    // an excluded list and watch it, which is the same watched path a filter naming
    // apps takes: the one that ends in replayd's crash (see start).
    private func soundOnly() -> SCStreamConfiguration {
        let c = SCStreamConfiguration()
        c.width = 2; c.height = 2
        c.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        c.showsCursor = false
        c.capturesAudio = true
        c.sampleRate = 48000
        c.channelCount = 2
        c.excludesCurrentProcessAudio = false
        return c
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let message = error.localizedDescription
        // The sound stream going is the sound going, never the take. It is not reopened:
        // a capture that just failed is not started again straight away.
        if stream === soundStream {
            soundStream = nil
            FileHandle.standardError.write("system audio stopped mid take: \(message)\n".data(using: .utf8)!)
            return
        }
        Task { await recover(from: error) }
    }

    // Stops one stream and waits for it. ScreenCaptureKit delivers nothing to an output
    // once stopCapture has returned, so the outputs come off after it, not before: taken
    // off a running stream, a buffer already on its way has nowhere to land. A failure is
    // written down, never swallowed, and the take still finishes.
    private func stop(_ s: SCStream?, _ name: String, outputs: [SCStreamOutputType]) async {
        guard let s else { return }
        do { try await s.stopCapture() } catch {
            FileHandle.standardError.write("the \(name) stream did not stop cleanly: \(error.localizedDescription)\n".data(using: .utf8)!)
        }
        for type in outputs {
            do { try s.removeStreamOutput(self, type: type) } catch {
                FileHandle.standardError.write("the \(name) stream kept an output: \(error.localizedDescription)\n".data(using: .utf8)!)
            }
        }
    }

    // The sound stream stopped and let go of, so nothing stops it a second time
    private func stopSound() async {
        let s = soundStream
        soundStream = nil
        await stop(s, "sound", outputs: [.audio])
    }

    // What openStream added, so exactly that comes off again
    private var pictureOutputs: [SCStreamOutputType] {
        var o: [SCStreamOutputType] = [.screen]
        if config?.capturesAudio == true { o.append(.audio) }
        if opts.mic, #available(macOS 15.0, *) { o.append(.microphone) }
        return o
    }

    // A window can drop out of capture for a moment (a Space change, a display
    // reconfiguring) and come straight back with the same id. That is held as a pause
    // and the same window picked up again. Only a window that stays gone ends the take,
    // and what was captured up to then is still finished into a playable file.
    //
    // It is picked up again with one start, never a run of them. When the capture
    // service itself went away (replayd crashed or dropped the connection, or the
    // person stopped sharing from the menu bar) nothing is reopened at all: a start
    // straight after the service fell over is the start after start that keeps it down,
    // and launchd holds it off for up to 20 minutes after repeated crashes.
    private func recover(from error: Error) async {
        let message = error.localizedDescription
        guard let wid = opts.windowID, !Recorder.serviceGone(error), beginInterruption() else {
            emit(["event": "error", "message": "capture stopped: \(message)"])
            await finish()
            return
        }
        emit(["event": "interrupted", "message": message])
        // Wait for the window to be back by asking what is on screen, which starts no
        // capture, and then start once.
        var win: SCWindow?
        for wait in [1.0, 1.0, 1.5] {
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            if isFinished() { return }
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
                win = content.windows.first(where: { $0.windowID == wid })
            } catch {
                FileHandle.standardError.write("could not read what is on screen while the window was gone: \(error.localizedDescription)\n".data(using: .utf8)!)
                break
            }
            if win != nil { break }
        }
        if let win, !isFinished() {
            do {
                let s = try await openStream(SCContentFilter(desktopIndependentWindow: win))
                if isFinished() { await stop(s, "picture", outputs: pictureOutputs); return }
                stream = s
                endInterruption()
                emit(["event": "recovered"])
                return
            } catch {
                FileHandle.standardError.write("the window came back and its capture did not start: \(error.localizedDescription)\n".data(using: .utf8)!)
            }
        }
        if isFinished() { return }
        emit(["event": "error", "message": "capture stopped: \(message)"])
        await finish()
    }

    // The capture service is gone, not the window: the connection to replayd was cut or
    // is invalid, it failed inside, the system stopped the stream, or the person stopped
    // sharing. Codes are SCStreamError's (-3804 connection invalid, -3805 connection
    // interrupted, -3811 internal, -3817 user stopped, -3821 system stopped), and an XPC
    // connection interrupted or invalidated (4097, 4099) is the same thing a layer down.
    static func serviceGone(_ error: Error) -> Bool {
        let e = error as NSError
        if e.domain == SCStreamErrorDomain { return [-3804, -3805, -3811, -3817, -3821].contains(e.code) }
        if e.domain == NSCocoaErrorDomain { return [4097, 4099].contains(e.code) }
        return false
    }

    private func isFinished() -> Bool { lock.lock(); defer { lock.unlock() }; return finished }
    private func isStartDone() -> Bool { lock.lock(); defer { lock.unlock() }; return startDone }
    private func markStartDone() { lock.lock(); startDone = true; lock.unlock() }

    private func beginInterruption() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard started, !finished, !interrupted else { return false }
        interrupted = true
        if !paused {
            paused = true; autoPaused = true
            pausedAt = CMClockGetTime(CMClockGetHostTimeClock())
        }
        return true
    }

    private func endInterruption() {
        lock.lock()
        defer { lock.unlock() }
        interrupted = false
        guard autoPaused else { return }
        autoPaused = false
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        if pausedAt.isValid { pausedTotal = CMTimeAdd(pausedTotal, CMTimeSubtract(now, pausedAt)) }
        pausedAt = .invalid
        paused = false
    }

    // ---------- clicks ----------
    // Auto-zoom wants to know where the person clicked, on the same clock as the
    // video. Polling the button state needs no permission, unlike an event tap, and
    // 60 Hz is fast enough to catch a normal click.
    private var lastButtons = 0
    func pollClick() {
        let buttons = NSEvent.pressedMouseButtons
        let pressed = buttons & ~lastButtons
        lastButtons = buttons
        guard pressed != 0 else { return }
        lock.lock()
        guard started, !paused, !finished else { lock.unlock(); return }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        let t = CMTimeGetSeconds(CMTimeSubtract(now, CMTimeAdd(sessionStart, pausedTotal)))
        lock.unlock()
        guard t >= 0 else { return }
        // Cocoa puts the origin at the bottom left of the primary screen; everything
        // else in Fetch (Electron, WindowList) measures from the top left.
        let p = NSEvent.mouseLocation
        let primaryH = NSScreen.screens.first?.frame.height ?? 0
        let button = pressed & 1 != 0 ? 0 : (pressed & 2 != 0 ? 1 : 2)
        emit(["event": "click", "t": Int((t * 1000).rounded()),
              "x": Int(p.x.rounded()), "y": Int((primaryH - p.y).rounded()), "button": button])
    }

    // ---------- control ----------
    func pause() {
        lock.lock()
        defer { lock.unlock() }
        // already held by a lost capture: the person's pause simply outlasts it
        if paused, autoPaused { autoPaused = false; emit(["event": "paused"]); return }
        guard started, !paused, !finished else { return }
        paused = true
        pausedAt = CMClockGetTime(CMClockGetHostTimeClock())
        emit(["event": "paused"])
    }

    func resume() {
        lock.lock()
        defer { lock.unlock() }
        guard paused, !finished else { return }
        autoPaused = false
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        if pausedAt.isValid { pausedTotal = CMTimeAdd(pausedTotal, CMTimeSubtract(now, pausedAt)) }
        pausedAt = .invalid
        paused = false
        emit(["event": "resumed"])
    }

    // The state flip is deliberately synchronous: NSLock must not be held across an
    // await, and this is the one place two callers can race to end the take.
    // The end is taken here, the moment Stop landed, on the file's clock: a take that
    // is paused ends where the pause began.
    private func claimFinish() -> (Bool, Int, Int, CMTime) {
        lock.lock()
        defer { lock.unlock() }
        if finished { return (false, 0, 0, .invalid) }
        finished = true
        guard started else { return (true, frames, dropped, .invalid) }
        let at = paused && pausedAt.isValid ? pausedAt : CMClockGetTime(CMClockGetHostTimeClock())
        return (true, frames, dropped, CMTimeSubtract(at, CMTimeAdd(sessionStart, pausedTotal)))
    }

    // Waits for start() to return, so nothing it is opening is left starting. Checked on
    // a short tick rather than awaited on the task, so a start replayd never answers
    // cannot hold the take open for ever: after 10 s the file is finished without it,
    // and that is written down.
    private func waitForStart() async {
        for _ in 0..<200 {
            if isStartDone() { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        FileHandle.standardError.write("the capture was still starting 10 s after Stop; finishing without waiting for it\n".data(using: .utf8)!)
    }

    func finish() async {
        let (proceed, f, d, end) = claimFinish()
        guard proceed else { return }
        await waitForStart()
        // Stop can land before start has opened the file (capture is slow to answer while
        // the screen is locked), and the writer is not there to finish: say so, not trap
        guard writer != nil else { fail("stopped before capture started") }

        // One at a time, each awaited, the sound first: it is the stream with an audio
        // queue in replayd, and it goes quiet while the picture is still running rather
        // than the two coming down together. The picture's own clock claimed the end
        // above, and the sound's last few milliseconds are filled to it.
        await stopSound()
        let s = stream
        stream = nil
        await stop(s, "picture", outputs: pictureOutputs)
        testSource?.stop()
        // after any sample still being handled, so the held frame is the last one
        sampleQueue.sync { holdToEnd(end) }
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
              "stillMs": Int((stillMax * 1000).rounded()), "sound": soundReport(),
              "stoppedAt": Int(Date().timeIntervalSince1970 * 1000)])
        stdoutQueue.sync {}
        exit(0)
    }
}

// ---------- a generated take ----------
// Picture and sound with a sharp event in both at the same instant, stamped on the host
// clock the way ScreenCaptureKit stamps them: a white frame and a 1 ms full-scale click
// at 3 s and 7 s of the picture. The sound starts `lead` seconds late and skips `gap`,
// so the written file shows whether the two stay together. `drift` in ppm runs the
// sound's sample clock slow (+) or fast (-) against the host clock, as a real device's
// can, and `flash=3:7:11` moves the events. Nothing is played aloud.
@available(macOS 13.0, *)
final class TestSource {
    let fps: Int, queue: DispatchQueue, sink: (CMSampleBuffer, SCStreamOutputType) -> Void
    var lead = 0.0, gap: (Double, Double)? = nil, k = 1.0
    var flashes = [3.0, 7.0]
    let rate = 48000.0, chunk = 1024
    private var timer: DispatchSourceTimer?
    private var t0 = CMTime.invalid
    private var frame = 0, packet = 0
    private var videoFmt: CMVideoFormatDescription?
    private var audioFmt: CMAudioFormatDescription?
    private var black: CVPixelBuffer?, white: CVPixelBuffer?

    init(spec: String, fps: Int, queue: DispatchQueue, sink: @escaping (CMSampleBuffer, SCStreamOutputType) -> Void) {
        self.fps = fps; self.queue = queue; self.sink = sink
        for kv in spec.split(separator: ",") {
            let p = kv.split(separator: "=").map(String.init)
            guard p.count == 2 else { continue }
            if p[0] == "lead" { lead = Double(p[1]) ?? 0 }
            if p[0] == "drift" { k = 1 + (Double(p[1]) ?? 0) / 1e6 }
            if p[0] == "flash" { let f = p[1].split(separator: ":").compactMap { Double($0) }; if !f.isEmpty { flashes = f } }
            if p[0] == "gap" {
                let r = p[1].split(separator: "-").compactMap { Double($0) }
                if r.count == 2 { gap = (r[0], r[1]) }
            }
        }
    }

    private func pixels(_ v: UInt8) -> CVPixelBuffer? {
        var px: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, 64, 64, kCVPixelFormatType_32BGRA, nil, &px)
        guard let px else { return nil }
        CVPixelBufferLockBaseAddress(px, [])
        memset(CVPixelBufferGetBaseAddress(px), Int32(v), CVPixelBufferGetDataSize(px))
        CVPixelBufferUnlockBaseAddress(px, [])
        return px
    }

    func run() {
        black = pixels(0); white = pixels(255)
        var asbd = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved,
            mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0)
        CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
                                       magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &audioFmt)
        t0 = CMClockGetTime(CMClockGetHostTimeClock())
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: 0.004)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }
    func stop() { queue.sync { timer?.cancel(); timer = nil } }

    private func tick() {
        let now = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), t0))
        while Double(frame) / Double(fps) <= now {
            let at = Double(frame) / Double(fps)
            let lit = flashes.contains { at >= $0 && at < $0 + 1 / Double(fps) }
            if let px = lit ? white : black { sendVideo(px, at: at) }
            frame += 1
        }
        while lead + (Double(packet * chunk) / rate + Double(chunk) / rate) * k <= now {
            let at = lead + Double(packet * chunk) / rate * k
            if let g = gap, at + Double(chunk) / rate > g.0, at < g.1 { packet += 1; continue }
            sendAudio(at: at)
            packet += 1
        }
    }

    private func stamp(_ s: Double) -> CMTime { CMTimeAdd(t0, CMTime(seconds: s, preferredTimescale: 48000)) }

    private func sendVideo(_ px: CVPixelBuffer, at: Double) {
        if videoFmt == nil { CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: px, formatDescriptionOut: &videoFmt) }
        guard let fmt = videoFmt else { return }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(fps)), presentationTimeStamp: stamp(at), decodeTimeStamp: .invalid)
        var sb: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: px, formatDescription: fmt,
                                                 sampleTiming: &timing, sampleBufferOut: &sb)
        if let sb { sink(sb, .screen) }
    }

    private func sendAudio(at: Double) {
        guard let fmt = audioFmt else { return }
        var data = [Float](repeating: 0, count: chunk * 2)
        // counted in the sound's own samples, which a drifting clock stretches on the host's
        let sample = { (s: Double) in Int(((s - self.lead) / self.k * self.rate).rounded()) + Int((self.lead * self.rate).rounded()) }
        let first = sample(at)
        for f in flashes {
            let click = sample(f)
            for i in 0..<48 where click + i >= first && click + i < first + chunk {
                data[click + i - first] = 1; data[chunk + click + i - first] = 1    // both planes
            }
        }
        let bytes = data.count * 4
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: bytes,
                                           blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
                                           dataLength: bytes, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
        guard let block else { return }
        data.withUnsafeBytes { _ = CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes) }
        var sb: CMSampleBuffer?
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: fmt,
                                                             sampleCount: chunk, presentationTimeStamp: stamp(at),
                                                             packetDescriptions: nil, sampleBufferOut: &sb)
        if let sb { sink(sb, .audio) }
    }
}

// ---------- main ----------
// SCContentFilter(desktopIndependentWindow:) talks to the window server, and a plain
// command line tool has no connection to it: without this it aborts inside
// CGS_REQUIRE_INIT the moment you capture a window rather than a display. Touching
// NSApplication sets that connection up. .prohibited keeps it out of the Dock and
// the menu bar, since this is a helper and should never look like an app.
_ = NSApplication.shared
NSApplication.shared.setActivationPolicy(.prohibited)

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

let clickTimer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { _ in recorder.pollClick() }
RunLoop.main.add(clickTimer, forMode: .common)

Task { await recorder.start() }
RunLoop.main.run()
