import AVFoundation
import Cocoa

// Circular always-on-top webcam bubble. Drag to move, scroll to resize, ⌘Q to quit.
final class BubbleView: NSView {
    override var acceptsFirstResponder: Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)   // drag from anywhere on the circle
    }

    override func rightMouseDown(with event: NSEvent) {
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Quit bubble", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }

    override func scrollWheel(with event: NSEvent) {
        guard let w = window else { return }
        let f = w.frame
        let d = event.scrollingDeltaY * 2
        let size = min(700, max(120, f.width + d))
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        w.setFrame(NSRect(x: f.midX - size / 2, y: f.midY - size / 2, width: size, height: size),
                   display: true, animate: false)
        (w.contentView as? BubbleView)?.reshape()
        CATransaction.commit()
    }

    func reshape() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)     // no implicit fade/resize, no black frame
        layer?.cornerRadius = bounds.width / 2
        layer?.sublayers?.forEach {
            let t = $0.affineTransform()          // keep the mirror/zoom transform intact
            $0.setAffineTransform(.identity)
            $0.frame = bounds
            $0.cornerRadius = bounds.width / 2
            $0.setAffineTransform(t)
        }
        CATransaction.commit()
    }

    override func layout() {
        super.layout()
        reshape()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, AVCaptureFileOutputRecordingDelegate {
    var window: NSWindow!
    let session = AVCaptureSession()
    let movieOut = AVCaptureMovieFileOutput()
    var lastRecord = false
    var camStartPath = ""

    func applicationDidFinishLaunching(_ note: Notification) {
        let size: CGFloat = 260
        let screen = NSScreen.main!.visibleFrame
        window = NSWindow(
            contentRect: NSRect(x: screen.maxX - size - 40, y: screen.minY + 40, width: size, height: size),
            styleMask: [.borderless, .resizable],
            backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .screenSaver                      // floats over everything, gets recorded
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.isMovableByWindowBackground = true
        // The bubble is recorded to its own file and composited at export, so it must
        // not also be burned into the screen capture or there would be two of them.
        window.sharingType = .none

        let view = BubbleView(frame: NSRect(origin: .zero, size: CGSize(width: size, height: size)))
        view.wantsLayer = true
        view.layer?.masksToBounds = true
        view.layer?.backgroundColor = NSColor(calibratedRed: 0.07, green: 0.06, blue: 0.05, alpha: 1).cgColor
        view.layer?.borderWidth = 4
        view.layer?.borderColor = NSColor.white.withAlphaComponent(0.9).cgColor
        window.contentView = view

        startCamera(in: view)
        // controls from the Fetch window arrive through a tiny JSON file
        Timer.scheduledTimer(withTimeInterval: 0.04, repeats: true) { _ in self.applyState() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    var preview: AVCaptureVideoPreviewLayer?
    var lastSize: CGFloat = 0
    var lastZoom: CGFloat = 0
    var lastAnchor = ""
    var lastCamera = ""
    var currentInput: AVCaptureDeviceInput?
    let statePath = NSString(string: "~/.cambubble.json").expandingTildeInPath

    // nine placement slots, expressed as fractions of the visible screen
    func anchorPoint(_ code: String, size: CGFloat) -> NSPoint? {
        let vf = NSScreen.main?.visibleFrame ?? .zero
        let pad: CGFloat = 34
        let cols: [Character: CGFloat] = ["l": vf.minX + pad,
                                          "c": vf.midX - size / 2,
                                          "r": vf.maxX - size - pad]
        let rows: [Character: CGFloat] = ["t": vf.maxY - size - pad,
                                          "m": vf.midY - size / 2,
                                          "b": vf.minY + pad]
        guard code.count == 2,
              let row = rows[code.first!], let col = cols[code.last!] else { return nil }
        return NSPoint(x: col, y: row)
    }

    func applyState() {
        guard let data = FileManager.default.contents(atPath: statePath),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        if let size = j["size"] as? Double, CGFloat(size) != lastSize {
            lastSize = CGFloat(size)
            let f = window.frame
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            window.setFrame(NSRect(x: f.midX - lastSize / 2, y: f.midY - lastSize / 2,
                                   width: lastSize, height: lastSize),
                            display: true, animate: false)
            (window.contentView as? BubbleView)?.reshape()
            CATransaction.commit()
        }
        if let zoom = j["zoom"] as? Double, CGFloat(zoom) != lastZoom {
            lastZoom = CGFloat(zoom)
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            preview?.setAffineTransform(CGAffineTransform(scaleX: -lastZoom, y: lastZoom))
            CATransaction.commit()
        }
        if let cam = j["camera"] as? String, cam != lastCamera {
            lastCamera = cam
            switchCamera(to: cam)
        }
        if let rec = j["record"] as? Bool, rec != lastRecord {
            lastRecord = rec
            if rec {
                if let out = j["out"] as? String, !out.isEmpty { startFileRecording(to: out) }
            } else {
                if movieOut.isRecording { movieOut.stopRecording() }
            }
        }
        if let anchor = j["anchor"] as? String, anchor != lastAnchor {
            lastAnchor = anchor
            if let p = anchorPoint(anchor, size: window.frame.width) {
                window.setFrameOrigin(p)
            }
        }
    }

    // The wizard sends a WebRTC device id, which is not an AVFoundation unique id.
    // Match on the human readable name instead, which is stable across both.
    func switchCamera(to identifier: String) {
        guard !identifier.isEmpty else { return }
        let devices = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera],
            mediaType: .video, position: .unspecified).devices
        guard let device = devices.first(where: { $0.uniqueID == identifier })
                ?? devices.first(where: { identifier.hasPrefix($0.uniqueID.prefix(16)) })
        else { return }
        guard let input = try? AVCaptureDeviceInput(device: device) else { return }
        session.beginConfiguration()
        if let old = currentInput { session.removeInput(old) }
        if session.canAddInput(input) { session.addInput(input); currentInput = input }
        session.commitConfiguration()
        NSLog("camera switched: \(device.localizedName)")
    }

    func startFileRecording(to path: String) {
        guard !movieOut.isRecording else { return }
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.removeItem(at: url)
        camStartPath = (path as NSString).deletingPathExtension + ".start.json"
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        movieOut.startRecording(to: url, recordingDelegate: self)
    }

    func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL,
                    from connections: [AVCaptureConnection]) {
        // epoch milliseconds: the app pairs this with the screen take's own start
        let ms = Int(Date().timeIntervalSince1970 * 1000)
        // where the bubble sits right now, so the editor can start it in the same
        // place it appeared on screen. Cocoa's origin is bottom-left; flip it.
        let f = window.frame
        let sf = (window.screen ?? NSScreen.main)?.frame ?? .zero
        let top = sf.height - (f.origin.y + f.height)
        let js = "{\"startedAt\":\(ms),\"size\":\(Int(f.width))," +
                 "\"x\":\(Int(f.origin.x)),\"y\":\(Int(top))," +
                 "\"screenW\":\(Int(sf.width)),\"screenH\":\(Int(sf.height))}"
        try? js.write(toFile: camStartPath, atomically: true, encoding: .utf8)
        NSLog("cam recording started: \(fileURL.path)")
    }

    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL,
                    from connections: [AVCaptureConnection], error: Error?) {
        if let e = error { NSLog("cam recording error: \(e.localizedDescription)") }
        else { NSLog("cam recording finished: \(outputFileURL.path)") }
    }

    func startCamera(in view: BubbleView) {
        AVCaptureDevice.requestAccess(for: .video) { ok in
            guard ok else { NSLog("camera access denied"); return }
            DispatchQueue.main.async {
                guard let device = AVCaptureDevice.default(for: .video),
                      let input = try? AVCaptureDeviceInput(device: device) else {
                    NSLog("no camera device")
                    return
                }
                self.session.beginConfiguration()
                self.session.sessionPreset = .high
                if self.session.canAddInput(input) { self.session.addInput(input); self.currentInput = input }
                if self.session.canAddOutput(self.movieOut) { self.session.addOutput(self.movieOut) }
                self.session.commitConfiguration()

                let preview = AVCaptureVideoPreviewLayer(session: self.session)
                preview.videoGravity = .resizeAspectFill
                preview.frame = view.bounds
                preview.cornerRadius = view.bounds.width / 2
                preview.masksToBounds = true
                preview.setAffineTransform(CGAffineTransform(scaleX: -1, y: 1))   // mirror
                view.layer?.addSublayer(preview)
                self.preview = preview
                view.reshape()

                DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
                NSLog("camera started: \(device.localizedName)")
            }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)          // no dock icon, no menu bar clutter
let delegate = AppDelegate()
app.delegate = delegate
app.run()
