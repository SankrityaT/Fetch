import AppKit
import Foundation
import ScreenCaptureKit

// Lists every on-screen window and grabs single-frame previews.
// ScreenCaptureKit is used throughout: the old CGWindowList image API was
// removed in macOS 15, and desktopCapturer only ever returns a couple of windows.
//   WindowList            -> JSON list of windows
//   WindowList <id> <px>  -> base64 JPEG preview of that window
//   WindowList --owners   -> every normal window with its owner's pid, CoreGraphics only
//   WindowList --cwd <pids> -> each process's working directory, proc_pidinfo only

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
// Not "Electron": that name is every app run from a development checkout, and skipping it
// hid them all from list_windows, so "@majuro record a demo" could never name its window.
// The Fetch that ran this helper, installed or a development build, is skipped by its pid
// instead (SELF_PIDS), and the installed one by its name as well.
let SKIP: Set<String> = [
    "Window Server", "Dock", "Fetch", "CamBubble",
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

// This helper and the Fetch that started it (main.js runs every WindowList itself, so the
// parent is Fetch's main process, which owns all its windows: the control window, the
// halo, the agent's cursor). FETCH_SELF_PID names it too, for a caller that is not the
// parent.
let SELF_PIDS: Set<Int> = {
    var s: Set<Int> = [Int(ProcessInfo.processInfo.processIdentifier), Int(getppid())]
    if let v = ProcessInfo.processInfo.environment["FETCH_SELF_PID"], let n = Int(v) { s.insert(n) }
    return s
}()

@available(macOS 14.0, *)
func listWindows() async throws -> [[String: Any]] {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    let mine = ProcessInfo.processInfo.processIdentifier
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    var seen = Set<String>()
    var out: [[String: Any]] = []

    for w in content.windows {
        guard let owner = w.owningApplication else { continue }
        guard owner.processID != mine, !SELF_PIDS.contains(Int(owner.processID)),
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

        // Keyed on the window id alone. The old key was app, title and size, which is
        // the same string for two booted simulators of one model with no app in front,
        // so one of them vanished from the list and "film two devices side by side" was
        // broken. A window id is unique already, so the same window reported twice is
        // still dropped and two different windows are never confused for one.
        let key = String(w.windowID)
        if seen.contains(key) { continue }
        seen.insert(key)

        let app = NSRunningApplication(processIdentifier: owner.processID)
        let isRegular = app?.activationPolicy == .regular
        let isFront = owner.processID == front

        out.append([
            "id": Int(w.windowID),
            // the owning process, so a window can be tied to what runs from a project
            // (ui/project-windows.js matches a process's working directory to a folder)
            "pid": Int(owner.processID),
            "app": owner.applicationName,
            "title": title,
            "icon": iconFor(owner.processID),
            "width": Int(r.width), "height": Int(r.height),
            // Where it sits, so the caller can ask which display it is on. A window on a
            // 1x screen beside a Retina main display has a different scale factor, and a
            // density measured against the wrong one refuses a good store shot or ships
            // a soft one.
            "x": Int(r.origin.x), "y": Int(r.origin.y),
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

// `--follow <id>`: print the window's frame as JSON whenever it changes, until killed,
// and `null` once it is gone. For the recording halo, which has to sit on exactly the
// window being recorded and move with it. CoreGraphics bounds are cheap and need no
// Screen Recording permission, unlike listing windows through ScreenCaptureKit.
if args.count >= 3, args[1] == "--follow", let id = UInt32(args[2]) {
    setvbuf(stdout, nil, _IOLBF, 0)
    var last = ""
    while true {
        var line = "null"
        if let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]],
           let w = info.first, let b = w[kCGWindowBounds as String] as? [String: CGFloat] {
            let onScreen = (w[kCGWindowIsOnscreen as String] as? Bool) ?? false
            line = "{\"x\":\(Int(b["X"] ?? 0)),\"y\":\(Int(b["Y"] ?? 0)),\"width\":\(Int(b["Width"] ?? 0)),\"height\":\(Int(b["Height"] ?? 0)),\"onScreen\":\(onScreen)}"
        }
        if line != last { print(line); last = line }
        if line == "null" { exit(0) }
        usleep(80_000)
    }
}

// `--covered <id>`: how much of the window others in front of it hide, as JSON
// {"covered":0.4,"by":["Safari"],"x":..,"y":..,"width":..,"height":..}, or null when it
// is not on screen. macOS sends no frames for a covered window, so an agent's take of
// one freezes; this lets record_start say so before anything is recorded. CoreGraphics
// lists on-screen windows front to back and needs no Screen Recording permission.
if args.count >= 3, args[1] == "--covered", let id = UInt32(args[2]) {
    let all = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    func frame(_ w: [String: Any]) -> CGRect? {
        guard let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
        return CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
    }
    guard let at = all.firstIndex(where: { ($0[kCGWindowNumber as String] as? Int) == Int(id) }),
          let target = frame(all[at]), target.width > 0, target.height > 0 else { print("null"); exit(0) }
    // ordinary windows in front of it; Fetch's own (the halo, the agent's cursor) and
    // system chrome are never in the recording
    let above: [(CGRect, String)] = all[..<at].compactMap { w in
        let owner = w[kCGWindowOwnerName as String] as? String ?? ""
        guard (w[kCGWindowLayer as String] as? Int ?? 0) == 0,
              (w[kCGWindowAlpha as String] as? Double ?? 1) > 0.05,
              !SELF_PIDS.contains(w[kCGWindowOwnerPID as String] as? Int ?? 0),
              !SKIP.contains(owner), let r = frame(w), r.intersects(target) else { return nil }
        return (r, owner)
    }
    // sampled on a grid, so overlapping windows in front are not counted twice
    let n = 48
    var hidden = 0
    var by = [String]()
    for i in 0..<n { for j in 0..<n {
        let p = CGPoint(x: target.minX + (CGFloat(i) + 0.5) * target.width / CGFloat(n),
                        y: target.minY + (CGFloat(j) + 0.5) * target.height / CGFloat(n))
        if let hit = above.first(where: { $0.0.contains(p) }) {
            hidden += 1
            if !by.contains(hit.1) { by.append(hit.1) }
        }
    } }
    let out: [String: Any] = ["covered": Double(hidden) / Double(n * n), "by": by,
        "x": Int(target.minX), "y": Int(target.minY), "width": Int(target.width), "height": Int(target.height)]
    let data = try! JSONSerialization.data(withJSONObject: out)
    print(String(data: data, encoding: .utf8)!)
    exit(0)
}

// `--front [seconds] [<id> | @x,y,w,h]`: the app and window in front, as JSON
// {"id":123,"app":"Google Chrome","title":"Library | Songscription","x":..,"y":..,"width":..,"height":..},
// or null. With seconds, a line that often until killed, so a take can be named after
// what it mostly showed. With an id, that window's app and title instead (a window
// take, where the recorded window need not be in front). With @x,y,w,h (points), the
// frontmost window whose centre is on that display (a display take on a second
// screen). CoreGraphics lists on-screen windows front to back; no ScreenCaptureKit, so
// a sample costs well under a millisecond.
if args.count >= 2, args[1] == "--front" {
    setvbuf(stdout, nil, _IOLBF, 0)
    let every = args.count >= 3 ? Double(args[2]) : nil
    let target = args.count >= 4 ? UInt32(args[3]) : nil
    let area: CGRect? = {
        guard args.count >= 4, args[3].hasPrefix("@") else { return nil }
        let n = args[3].dropFirst().split(separator: ",").compactMap { Double($0) }
        return n.count == 4 ? CGRect(x: n[0], y: n[1], width: n[2], height: n[3]) : nil
    }()
    let mine = Int(ProcessInfo.processInfo.processIdentifier)
    // Apps to look past, comma separated (FETCH_FRONT_SKIP): an agent's take asks for the
    // product's window, not the terminal the agent itself runs in.
    let passOver = Set((ProcessInfo.processInfo.environment["FETCH_FRONT_SKIP"] ?? "")
        .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
    func sample() -> String {
        let list: [[String: Any]]
        if let id = target {
            list = (CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]]) ?? []
        } else {
            list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        }
        let ok = list.filter { w in
            let owner = w[kCGWindowOwnerName as String] as? String ?? ""
            guard target == nil else { return true }
            guard (w[kCGWindowLayer as String] as? Int ?? 0) == 0,
                  (w[kCGWindowAlpha as String] as? Double ?? 1) > 0.05,
                  (w[kCGWindowOwnerPID as String] as? Int ?? 0) != mine,
                  !SELF_PIDS.contains(w[kCGWindowOwnerPID as String] as? Int ?? 0),
                  !owner.isEmpty, !SKIP.contains(owner), !passOver.contains(owner),
                  !SKIP_PREFIX.contains(where: { owner.hasPrefix($0) }),
                  let b = w[kCGWindowBounds as String] as? [String: CGFloat],
                  (b["Width"] ?? 0) >= 140, (b["Height"] ?? 0) >= 120 else { return false }
            if let a = area {
                let c = CGPoint(x: (b["X"] ?? 0) + (b["Width"] ?? 0) / 2, y: (b["Y"] ?? 0) + (b["Height"] ?? 0) / 2)
                return a.contains(c)
            }
            return true
        }
        // A browser in full screen stacks untitled strips (toolbar, tab bar) over the
        // page's window: the app is the front one's, the title its first titled window's.
        let title = { (w: [String: Any]) in w[kCGWindowName as String] as? String ?? "" }
        let owner = { (w: [String: Any]) in w[kCGWindowOwnerName as String] as? String ?? "" }
        guard let first = ok.first else { return "null" }
        let w = title(first).isEmpty ? (ok.first { owner($0) == owner(first) && !title($0).isEmpty } ?? first) : first
        let b = w[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
        let out: [String: Any] = [
            "id": w[kCGWindowNumber as String] as? Int ?? 0,
            "app": w[kCGWindowOwnerName as String] as? String ?? "",
            "title": w[kCGWindowName as String] as? String ?? "",
            "x": Int(b["X"] ?? 0), "y": Int(b["Y"] ?? 0),
            "width": Int(b["Width"] ?? 0), "height": Int(b["Height"] ?? 0),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: out) else { return "null" }
        return String(data: data, encoding: .utf8) ?? "null"
    }
    guard let secs = every, secs > 0 else { print(sample()); exit(0) }
    while true {
        print(sample())
        usleep(useconds_t(secs * 1_000_000))
    }
}

// `--owners`: every window in the normal layer, on screen or not (another Space,
// minimised, behind a full-screen app), at least the size the list above keeps, as JSON
// [{"id":..,"pid":..,"app":..,"title":..,"width":..,"height":..,"onScreen":true}].
// CoreGraphics only: no ScreenCaptureKit, so the capture service is never asked anything.
// Nothing is skipped; ui/project-windows.js names the Fetch doing the recording itself.
if args.count >= 2, args[1] == "--owners" {
    let all = (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    var out: [[String: Any]] = []
    for w in all {
        guard (w[kCGWindowLayer as String] as? Int ?? -1) == 0,
              (w[kCGWindowAlpha as String] as? Double ?? 1) > 0.05,
              let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
        let width = Int((b["Width"] ?? 0).rounded()), height = Int((b["Height"] ?? 0).rounded())
        guard width >= 140, height >= 120 else { continue }
        out.append([
            "id": w[kCGWindowNumber as String] as? Int ?? 0,
            "pid": w[kCGWindowOwnerPID as String] as? Int ?? 0,
            "app": w[kCGWindowOwnerName as String] as? String ?? "",
            "title": w[kCGWindowName as String] as? String ?? "",
            "width": width, "height": height,
            "onScreen": (w[kCGWindowIsOnscreen as String] as? Bool) ?? false,
        ])
    }
    let data = (try? JSONSerialization.data(withJSONObject: out)) ?? Data("[]".utf8)
    print(String(data: data, encoding: .utf8) ?? "[]")
    exit(0)
}

// `--cwd <pid,pid,...>`: each process's working directory, as JSON {"51115":"/Users/..."}.
// proc_pidinfo answers for the person's own processes in microseconds each, which is
// what lsof asks the kernel for anyway. A process it cannot read is left out.
if args.count >= 3, args[1] == "--cwd" {
    var out: [String: String] = [:]
    for part in args[2].split(separator: ",") {
        guard let pid = Int32(part.trimmingCharacters(in: .whitespaces)), pid > 0 else { continue }
        var info = proc_vnodepathinfo()
        let size = Int32(MemoryLayout<proc_vnodepathinfo>.stride)
        guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, size) == size else { continue }
        let cwd = withUnsafePointer(to: &info.pvi_cdir.vip_path) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) }
        }
        if !cwd.isEmpty { out[String(pid)] = cwd }
    }
    let data = (try? JSONSerialization.data(withJSONObject: out)) ?? Data("{}".utf8)
    print(String(data: data, encoding: .utf8) ?? "{}")
    exit(0)
}

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
