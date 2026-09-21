import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// A still, captured the way Recorder.swift captures video: ScreenCaptureKit, the same
// content filter, the same exclusion list. A screenshot is a take of one frame, so
// there is no second capture stack here and nothing that draws: this writes the raw
// pixels at full backing scale and stops. Everything a styled screenshot needs on top
// of it is already in the compositor.
//
//   Shot --out <path> --display <id>
//   Shot --out <path> --window <id>
//   Shot --out <path> --region x,y,w,h [--display <id>]
//
// Options: --exclude a,b,c (window ids kept out of the frame), --exclude-app <name>
// (every window of that app, matched the way ui/record-policy.js matches, repeatable),
// --cursor (the pointer is out by default, a still of a page should not carry the
// person's mouse), --window-shadow (keep the window's own drop shadow, which the
// compositor otherwise draws itself), and --by agent|human, which decides whether the
// Screen Recording grant is preflighted or met.
//
// The app form is the one that holds. A window id can only name a window somebody
// listed, and the list Fetch draws for a person is filtered for readability: a small
// quick-access panel or a second window with the same title and size is not in it. So
// the never-record list arrives here as names and this process, which sees every window
// there is, decides which ones are left out.
//
// One JSON object on stdout, always, so the caller never reads a log to find out what
// happened. Exit 1 carries {"ok":false,"error":...}.

struct Fail: Error { let why: String }

struct Options {
    var out = ""
    var displayID: CGDirectDisplayID?
    var windowID: CGWindowID?
    var region: CGRect?
    var badRegion = false
    // Windows the never-record list says must never be captured. Handed to
    // ScreenCaptureKit so they are absent from the frame rather than cropped out of a
    // file that already holds them.
    var exclude: [CGWindowID] = []
    // Never-record app names. Matched against every window this process can see, not
    // against a list somebody filtered for a picker.
    var excludeApps: [String] = []
    var cursor = false
    var keepShadow = false
    // Who asked. An agent cannot answer macOS's own permission prompt, so for an agent
    // the grant is read before any content is and a missing one is a refusal. A person
    // can answer it, and meeting it is the shortest route to a granted Mac, so for a
    // person the read goes ahead and the system asks. Nothing here ever asks for them.
    var byAgent = false
}

func parseArgs() -> Options {
    var o = Options()
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        switch a {
        case "--out":     o.out = it.next() ?? ""
        case "--display": if let v = it.next(), let n = UInt32(v) { o.displayID = n }
        case "--window":  if let v = it.next(), let n = UInt32(v) { o.windowID = n }
        case "--region":
            let n = (it.next() ?? "").split(separator: ",")
                .compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            if n.count == 4 { o.region = CGRect(x: n[0], y: n[1], width: n[2], height: n[3]) }
            else { o.badRegion = true }
        case "--exclude": if let v = it.next() { o.exclude = v.split(separator: ",").compactMap { UInt32($0) } }
        case "--exclude-app": if let v = it.next(), !v.isEmpty { o.excludeApps.append(v) }
        case "--cursor":  o.cursor = true
        case "--window-shadow": o.keepShadow = true
        case "--by": o.byAgent = (it.next() ?? "") == "agent"
        default: break
        }
    }
    return o
}

// ---------- reporting ----------
func say(_ dict: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: dict),
          let s = String(data: d, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
}
func stop(_ why: String) -> Never {
    say(["ok": false, "error": why])
    exit(1)
}

// ---------- the never-record list ----------
// Substring both ways on the trimmed lowercase name, the same rule ui/record-policy.js
// uses, so "1Password" matches the window owner "1Password 8" and the other way round.
// Said twice on purpose: the rule has to hold in the process that reads the pixels.
func nameMatches(_ appName: String, _ entry: String) -> Bool {
    let a = appName.trimmingCharacters(in: .whitespaces).lowercased()
    let e = entry.trimmingCharacters(in: .whitespaces).lowercased()
    if a.isEmpty || e.isEmpty { return false }
    return a == e || a.contains(e) || e.contains(a)
}

// ---------- pixels ----------
// Points to pixels for the display a thing sits on. CGDisplayScreenSize is deliberately
// not used: it needs a GUI connection this process does not have. Same derivation as
// Recorder.swift, so a still and a take of the same window come out the same size.
@available(macOS 14.0, *)
func backingScale(_ d: SCDisplay) -> Double {
    guard let mode = CGDisplayCopyDisplayMode(d.displayID), d.width > 0 else { return 2 }
    let s = Double(mode.pixelWidth) / Double(d.width)
    return s > 0 ? s : 2
}

// The lowest alpha at the four corners, 0 to 255. The compositor needs to know whether
// the window's own rounded corners are cut out of this file before it decides whether
// to draw its own, so it is measured rather than assumed.
func cornerAlpha(_ img: CGImage) -> Int {
    let info = img.alphaInfo
    guard info == .premultipliedFirst || info == .premultipliedLast || info == .first || info == .last,
          img.bitsPerPixel == 32, img.width > 1, img.height > 1,
          let data = img.dataProvider?.data, let p = CFDataGetBytePtr(data) else { return 255 }
    // Alpha is "first" in the word, and a little endian word puts the first component
    // in the last byte, so the two flags cancel.
    let firstInWord = (info == .premultipliedFirst || info == .first)
    let little = img.bitmapInfo.contains(.byteOrder32Little)
    let at = (firstInWord != little) ? 0 : 3
    let bpr = img.bytesPerRow
    var lo = 255
    for (x, y) in [(0, 0), (img.width - 1, 0), (0, img.height - 1), (img.width - 1, img.height - 1)] {
        let o = y * bpr + x * 4 + at
        if o >= 0 && o < CFDataGetLength(data) { lo = min(lo, Int(p[o])) }
    }
    return lo
}

func writePNG(_ img: CGImage, to path: String) throws -> Int {
    let url = URL(fileURLWithPath: path)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { throw Fail(why: "could not open \(path) for writing") }
    CGImageDestinationAddImage(dest, img, nil)
    guard CGImageDestinationFinalize(dest) else { throw Fail(why: "could not write \(path)") }
    let attrs = try? FileManager.default.attributesOfItem(atPath: path)
    return (attrs?[.size] as? Int) ?? 0
}

@available(macOS 14.0, *)
func baseConfig(_ o: Options, width: Int, height: Int) -> SCStreamConfiguration {
    let cfg = SCStreamConfiguration()
    cfg.width = width
    cfg.height = height
    cfg.showsCursor = o.cursor
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    // sRGB because that is the space the compositor grades in; anything else would
    // make the styled file disagree with the stage that previewed it.
    cfg.colorSpaceName = CGColorSpace.sRGB
    cfg.captureResolution = .best
    return cfg
}

// ---------- the shot ----------
@available(macOS 14.0, *)
func capture(_ o: Options) async throws -> [String: Any] {
    if o.out.isEmpty { throw Fail(why: "no --out path given") }
    if o.badRegion { throw Fail(why: "--region wants x,y,w,h in screen points") }

    // Asked before any content is read, because reading content is what raises macOS's
    // permission dialog, and for an agent that dialog is a stall rather than a failure:
    // whoever is driving is not at this Mac to answer it and waits on a question it
    // cannot see. For a person it is the opposite. Preflight is boolean, so it cannot
    // tell a Mac that was never asked from one that said no, and refusing on it deleted
    // the first-run prompt: Fetch may not even be listed in that pane yet, so the
    // refusal named a switch that did not exist. A person meets the prompt. Preflight
    // only reads; requesting the grant is their own act and this process never does it.
    if o.byAgent && !CGPreflightScreenCaptureAccess() {
        throw Fail(why: "Screen Recording permission has not been granted to Fetch, so there is nothing to capture. " +
                        "Ask the person to grant it in System Settings, Privacy and Security, Screen Recording, and then restart Fetch.")
    }

    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    } catch {
        // Where a person met the prompt and said no, this is the answer, and it has to
        // carry the same two sentences the preflight refusal does.
        throw Fail(why: "could not read shareable content: \(error.localizedDescription). " +
                        "Screen Recording permission is most likely not granted to Fetch. " +
                        "Grant it in System Settings, Privacy and Security, Screen Recording, and then restart Fetch.")
    }

    var out: [String: Any] = ["ok": true, "path": o.out, "cursor": o.cursor]
    let img: CGImage
    var scale = 2.0

    if let wid = o.windowID {
        guard let win = content.windows.first(where: { $0.windowID == wid }) else {
            throw Fail(why: "window \(wid) is not on screen any more")
        }
        let frame = win.frame
        guard frame.width >= 1, frame.height >= 1 else { throw Fail(why: "window \(wid) has no size") }
        // The display the window is mostly on, not the first one it happens to touch. A
        // Retina window overlapping a 1x monitor by a few points was captured at half
        // its pixels and reported scale 1 as if that were a measurement.
        let overlap: (SCDisplay) -> Double = { d in
            let r = d.frame.intersection(frame)
            return r.isNull ? 0 : Double(r.width * r.height)
        }
        let display = content.displays.filter { overlap($0) > 0 }.max(by: { overlap($0) < overlap($1) })
            ?? content.displays.first
        scale = display.map(backingScale) ?? 2
        let cfg = baseConfig(o, width: Int((frame.width * scale).rounded()), height: Int((frame.height * scale).rounded()))
        // The compositor draws its own shadow under its own device frame, so the Mac's
        // shadow would be a second one baked into the picture. Off unless asked for.
        cfg.ignoreShadowsSingleWindow = !o.keepShadow
        // A window hanging off the edge of the screen is still a whole window in its
        // backing store. Taking the clipped version would put a hard straight edge, and
        // then a band of nothing, into a file the compositor is about to frame.
        cfg.ignoreGlobalClipSingleWindow = true
        let filter = SCContentFilter(desktopIndependentWindow: win)
        img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        out["kind"] = "window"
        out["window"] = Int(wid)
        out["app"] = win.owningApplication?.applicationName ?? ""
        out["title"] = win.title ?? ""
        out["display"] = display.map { Int($0.displayID) } ?? 0
        out["bounds"] = ["x": Int(frame.minX), "y": Int(frame.minY),
                         "width": Int(frame.width.rounded()), "height": Int(frame.height.rounded())]
        out["shadow"] = o.keepShadow
        out["excluded"] = [Int]()
    } else {
        let display: SCDisplay
        if let did = o.displayID {
            guard let d = content.displays.first(where: { $0.displayID == did }) else {
                throw Fail(why: "display \(did) is not attached any more")
            }
            display = d
        } else if let r = o.region, let d = content.displays.first(where: { $0.frame.intersects(r) }) {
            display = d
        } else if let d = content.displays.first {
            display = d
        } else {
            throw Fail(why: "no displays available to capture")
        }
        scale = backingScale(display)
        let mode = CGDisplayCopyDisplayMode(display.displayID)
        let px = mode?.pixelWidth ?? Int((Double(display.width) * scale).rounded())
        let py = mode?.pixelHeight ?? Int((Double(display.height) * scale).rounded())
        // Every window of a never-record app, found here rather than named by the caller,
        // plus whatever ids the caller did name. content.windows is the unfiltered
        // enumeration, so a window no picker would list is still left out of the frame.
        let excluded = content.windows.filter { w in
            if o.exclude.contains(w.windowID) { return true }
            guard let owner = w.owningApplication?.applicationName, !owner.isEmpty else { return false }
            return o.excludeApps.contains { nameMatches(owner, $0) }
        }
        let filter = SCContentFilter(display: display, excludingWindows: excluded)
        let cfg = baseConfig(o, width: px, height: py)
        let whole = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)

        if let asked = o.region {
            // Cropped here rather than through SCStreamConfiguration.sourceRect: a crop
            // in pixels is exact and its origin is unambiguously the top left, where a
            // rect in points rounds and inherits whichever corner the capture API calls
            // the origin. A still is asked for by a person pointing at a rectangle, so
            // landing on the wrong pixels is the one failure that cannot be noticed.
            let on = asked.intersection(display.frame)
            guard !on.isNull, on.width >= 1, on.height >= 1 else {
                throw Fail(why: "that region is not on display \(display.displayID)")
            }
            let local = CGRect(x: (on.minX - display.frame.minX) * scale, y: (on.minY - display.frame.minY) * scale,
                               width: on.width * scale, height: on.height * scale).integral
            let clamped = local.intersection(CGRect(x: 0, y: 0, width: whole.width, height: whole.height))
            guard let cut = whole.cropping(to: clamped), cut.width >= 1, cut.height >= 1 else {
                throw Fail(why: "that region came out empty")
            }
            img = cut
            out["kind"] = "region"
            out["bounds"] = ["x": Int(on.minX), "y": Int(on.minY),
                             "width": Int(on.width.rounded()), "height": Int(on.height.rounded())]
            // The caller asked for a rectangle and may have been given less of it.
            out["clipped"] = on != asked
        } else {
            img = whole
            out["kind"] = "display"
            out["bounds"] = ["x": Int(display.frame.minX), "y": Int(display.frame.minY),
                             "width": display.width, "height": display.height]
        }
        out["display"] = Int(display.displayID)
        out["excluded"] = excluded.map { Int($0.windowID) }
        out["shadow"] = true      // a desktop's windows cast theirs onto the desktop
    }

    let alpha = cornerAlpha(img)
    out["corners"] = alpha < 8 ? "rounded" : "square"
    out["cornerAlpha"] = alpha
    out["width"] = img.width
    out["height"] = img.height
    out["scale"] = scale
    out["bytes"] = try writePNG(img, to: o.out)
    return out
}

// CoreGraphics asserts without an app context, and Fetch never steals focus: no dock
// icon, no window, nothing activated.
_ = NSApplication.shared
NSApplication.shared.setActivationPolicy(.prohibited)

let sem = DispatchSemaphore(value: 0)
if #available(macOS 14.0, *) {
    let opts = parseArgs()
    Task {
        do { say(try await capture(opts)) }
        catch let f as Fail { stop(f.why) }
        catch { stop("\(error.localizedDescription)") }
        sem.signal()
    }
    sem.wait()
} else {
    // SCScreenshotManager is macOS 14. Older Macs still record: only stills are out.
    stop("stills need macOS 14 or later")
}
