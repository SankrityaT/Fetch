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
            // A window filter hears only its app's own process, and a browser (Chrome,
            // Electron, Safari) plays every page from a helper process that belongs to
            // no app, so a browser window's take came out digitally silent. Its sound
            // comes from the display instead, with every other app that has a window
            // left out: the app, its helpers and system sounds, not the person's music.
            if opts.systemAudio, let d = content.displays.first(where: { $0.frame.intersects(win.frame) }) ?? content.displays.first {
                let others = content.applications.filter { $0.processID != win.owningApplication?.processID }
                soundFilter = SCContentFilter(display: d, excludingApplications: others, exceptingWindows: [])
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
        config = cfg

        do {
            stream = try await openStream(filter)
        } catch {
            fail("could not start capture: \(error.localizedDescription)")
        }
        if let sf = soundFilter { await openSoundStream(sf) }
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
        writer.endSession(atSourceTime: end)
    }

    private let sampleQueue = DispatchQueue(label: "fetch.recorder.samples", qos: .userInitiated)
    private func openStream(_ filter: SCContentFilter) async throws -> SCStream {
        guard let cfg = config else { throw CocoaError(.featureUnsupported) }
        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        if opts.systemAudio, soundFilter == nil { try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue) }
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
        let c = SCStreamConfiguration()
        c.width = 2; c.height = 2
        c.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        c.showsCursor = false
        c.capturesAudio = true
        c.sampleRate = 48000
        c.channelCount = 2
        c.excludesCurrentProcessAudio = true
        let s = SCStream(filter: f, configuration: c, delegate: nil)
        do {
            try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
            try await s.startCapture()
            soundStream = s
        } catch {
            FileHandle.standardError.write("no system audio for this window: \(error.localizedDescription)\n".data(using: .utf8)!)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let message = error.localizedDescription
        Task { await recover(from: message) }
    }

    // A window can drop out of capture for a moment (a Space change, a display
    // reconfiguring) and come straight back with the same id. That is held as a pause
    // and the same window picked up again. Only a window that stays gone ends the take,
    // and what was captured up to then is still finished into a playable file.
    private func recover(from message: String) async {
        guard let wid = opts.windowID, beginInterruption() else {
            emit(["event": "error", "message": "capture stopped: \(message)"])
            await finish()
            return
        }
        emit(["event": "interrupted", "message": message])
        for _ in 0..<6 {
            try? await Task.sleep(nanoseconds: 500_000_000)
            if isFinished() { return }
            guard let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false),
                  let win = content.windows.first(where: { $0.windowID == wid }),
                  let s = try? await openStream(SCContentFilter(desktopIndependentWindow: win)) else { continue }
            stream = s
            if isFinished() { try? await s.stopCapture(); return }
            endInterruption()
            emit(["event": "recovered"])
            return
        }
        emit(["event": "error", "message": "capture stopped: \(message)"])
        await finish()
    }

    private func isFinished() -> Bool { lock.lock(); defer { lock.unlock() }; return finished }

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

    func finish() async {
        let (proceed, f, d, end) = claimFinish()
        guard proceed else { return }

        try? await stream?.stopCapture()
        try? await soundStream?.stopCapture()
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
              "stillMs": Int((stillMax * 1000).rounded()),
              "stoppedAt": Int(Date().timeIntervalSince1970 * 1000)])
        stdoutQueue.sync {}
        exit(0)
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
