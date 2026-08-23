import AppKit
import Foundation
import ScreenCaptureKit

// Lists every on-screen window and grabs single-frame previews.
// ScreenCaptureKit is used throughout: the old CGWindowList image API was
// removed in macOS 15, and desktopCapturer only ever returns a couple of windows.
//   WindowList            -> JSON list of windows
//   WindowList <id> <px>  -> base64 JPEG preview of that window

func jpeg(_ img: CGImage, maxW: CGFloat) -> String? {
    let w = CGFloat(img.width), h = CGFloat(img.height)
    guard w > 0, h > 0 else { return nil }
    let scale = min(1, maxW / w)
    let size = NSSize(width: max(1, w * scale), height: max(1, h * scale))
    let out = NSImage(size: size)
    out.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .high
    NSImage(cgImage: img, size: .zero).draw(in: NSRect(origin: .zero, size: size))
    out.unlockFocus()
    guard let tiff = out.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
          let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.72])
    else { return nil }
    return "data:image/jpeg;base64," + data.base64EncodedString()
}

// Full-size app icons are ~100KB each of base64; at 40 windows that overruns the
// pipe. 32px is all the picker draws anyway.
func iconFor(_ pid: pid_t) -> String {
    guard let app = NSRunningApplication(processIdentifier: pid), let img = app.icon else { return "" }
    let size = NSSize(width: 32, height: 32)
    let small = NSImage(size: size)
    small.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .high
    img.draw(in: NSRect(origin: .zero, size: size))
    small.unlockFocus()
    guard let tiff = small.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { return "" }
    return "data:image/png;base64," + png.base64EncodedString()
}

// System chrome and background helpers a user would never want to record.
// Matched against the owning app's name (ScreenCaptureKit's applicationName).
let SKIP: Set<String> = [
    "Window Server", "Dock", "Fetch", "CamBubble", "Electron",
    "Control Centre", "Control Center", "Notification Center", "Spotlight",
    "UserNotificationCenter", "CoreServicesUIAgent", "TextInputMenuAgent",
    "TextInputSwitcher", "universalAccessAuthWarn", "Emoji & Symbols",
    "LinkedNotesUIService", "SystemUIServer", "WallpaperAgent",
    "ScreenSaverEngine", "Wallpaper", "Menubar",
]
// Prefix match: per-app Password AutoFill popovers, named "AutoFill (Host App)".
let SKIP_PREFIX = ["AutoFill ("]
// Placeholder titles some helper windows report instead of real content.
let JUNK_TITLES: Set<String> = ["Item-0", "Window", "Menubar", "Desktop"]

@available(macOS 14.0, *)
func listWindows() async throws -> [[String: Any]] {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    let mine = ProcessInfo.processInfo.processIdentifier
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    var seen = Set<String>()
    var out: [[String: Any]] = []

    for w in content.windows {
        guard let owner = w.owningApplication else { continue }
        guard owner.processID != mine,
              !SKIP.contains(owner.applicationName),
              !SKIP_PREFIX.contains(where: { owner.applicationName.hasPrefix($0) })
        else { continue }
        let r = w.frame
        guard r.width >= 140, r.height >= 120 else { continue }
        let title = w.title ?? ""
        if JUNK_TITLES.contains(title) { continue }

        // Many background/system helper windows share a suspiciously generic
        // frame (a common default, or an exact square) and carry no title at
        // all: real content windows almost never look like this.
        let isSquareHelper = title.isEmpty && r.width == r.height && r.width <= 512
        let aspect = max(r.width, r.height) / max(1, min(r.width, r.height))
        let isStripHelper = title.isEmpty && aspect > 5
        if isSquareHelper || isStripHelper { continue }

        let key = "\(owner.applicationName)|\(title)|\(Int(r.width))x\(Int(r.height))"
        if seen.contains(key) { continue }
        seen.insert(key)

        let app = NSRunningApplication(processIdentifier: owner.processID)
        let isRegular = app?.activationPolicy == .regular
        let isFront = owner.processID == front

        out.append([
            "id": Int(w.windowID),
            "app": owner.applicationName,
            "title": title,
            "icon": iconFor(owner.processID),
            "width": Int(r.width), "height": Int(r.height),
            "_front": isFront, "_regular": isRegular,
        ])
    }
    // Frontmost app first, then real (Dock-visible) app windows over background
    // helpers, then largest area as the final tiebreaker.
    out.sort {
        let a = $0, b = $1
        let aFront = a["_front"] as! Bool, bFront = b["_front"] as! Bool
        if aFront != bFront { return aFront }
        let aReg = a["_regular"] as! Bool, bReg = b["_regular"] as! Bool
        if aReg != bReg { return aReg }
        return ((a["width"] as! Int) * (a["height"] as! Int)) > ((b["width"] as! Int) * (b["height"] as! Int))
    }
    return out.map { w in
        var w = w
        w.removeValue(forKey: "_front")
        w.removeValue(forKey: "_regular")
        return w
    }
}

@available(macOS 14.0, *)
func shot(_ id: UInt32, _ maxW: CGFloat) async throws -> String? {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    guard let win = content.windows.first(where: { $0.windowID == id }) else { return nil }
    let cfg = SCStreamConfiguration()
    cfg.width = Int(win.frame.width)
    cfg.height = Int(win.frame.height)
    cfg.showsCursor = false
    let filter = SCContentFilter(desktopIndependentWindow: win)
    let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    return jpeg(img, maxW: maxW)
}

_ = NSApplication.shared            // CoreGraphics asserts without an app context
NSApplication.shared.setActivationPolicy(.prohibited)

let args = CommandLine.arguments
let sem = DispatchSemaphore(value: 0)

if #available(macOS 14.0, *) {
    Task {
        do {
            if args.count >= 2, let id = UInt32(args[1]) {
                let px = args.count >= 3 ? CGFloat(Double(args[2]) ?? 600) : 600
                print(try await shot(id, px) ?? "")
            } else {
                let data = try JSONSerialization.data(withJSONObject: try await listWindows())
                print(String(data: data, encoding: .utf8)!)
            }
        } catch {
            FileHandle.standardError.write("WindowList: \(error)\n".data(using: .utf8)!)
            print(args.count >= 2 ? "" : "[]")
        }
        sem.signal()
    }
    sem.wait()
} else {
    print("[]")
}
