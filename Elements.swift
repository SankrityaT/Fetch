import AppKit
import Foundation
import Vision

// Finds the things on screen an edit can point at: every line of text, and the chip,
// button or card drawn around it. On device (Vision), no service. An agent asked to
// "zoom on the black chip" used to guess coordinates from a picture; this gives it
// boxes to choose from instead.
//
//   Elements <image>                         -> JSON {width, height, texts, rects}
//   Elements --draw <image> <out.jpg> <json> -> the image with numbered boxes on it
//
// Boxes are fractions of the image, from the top left. ui/targets.js turns the raw
// detections into ranked elements; this file only measures pixels.

func cgImage(_ path: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

// RGBA8 copy at a working size: region growing reads every pixel it touches, and a
// Retina frame has four times the pixels the decision needs.
struct Pixels {
    let w: Int, h: Int
    var data: [UInt8]
    init?(_ img: CGImage, maxW: Int) {
        let s = min(1.0, Double(maxW) / Double(img.width))
        w = max(1, Int(Double(img.width) * s)); h = max(1, Int(Double(img.height) * s))
        data = [UInt8](repeating: 0, count: w * h * 4)
        let ok = data.withUnsafeMutableBytes { buf -> Bool in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            ctx.interpolationQuality = .medium
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        if !ok { return nil }
    }
    // (0,0) is the top left, as everything else here
    func px(_ x: Int, _ y: Int) -> (Int, Int, Int) {
        let i = (y * w + x) * 4
        return (Int(data[i]), Int(data[i + 1]), Int(data[i + 2]))
    }
}

typealias RGB = (Int, Int, Int)
func dist(_ a: RGB, _ b: RGB) -> Int { abs(a.0 - b.0) + abs(a.1 - b.1) + abs(a.2 - b.2) }
func hex(_ c: RGB) -> String { String(format: "#%02X%02X%02X", c.0, c.1, c.2) }

// The colour most of these pixels share, and how many share it. Quantised so
// anti-aliasing and compression noise fall in the same bucket.
func dominant(_ pts: [RGB]) -> (RGB, Double) {
    guard !pts.isEmpty else { return ((0, 0, 0), 0) }
    var counts = [Int: [RGB]]()
    for p in pts { counts[(p.0 >> 4) << 8 | (p.1 >> 4) << 4 | (p.2 >> 4), default: []].append(p) }
    let best = counts.max { $0.value.count < $1.value.count }!.value
    // everything near the winning bucket counts toward it, then average those
    let seed = best[0]
    let near = pts.filter { dist($0, seed) <= 30 }
    let n = max(1, near.count)
    let avg = (near.reduce(0) { $0 + $1.0 } / n, near.reduce(0) { $0 + $1.1 } / n, near.reduce(0) { $0 + $1.2 } / n)
    return (avg, Double(near.count) / Double(pts.count))
}

struct Box { var x0: Int, y0: Int, x1: Int, y1: Int }   // inclusive pixel bounds

func ring(_ p: Pixels, _ b: Box, _ pad: Int) -> [RGB] {
    var out = [RGB]()
    let x0 = max(0, b.x0 - pad), x1 = min(p.w - 1, b.x1 + pad)
    let y0 = max(0, b.y0 - pad), y1 = min(p.h - 1, b.y1 + pad)
    let step = max(1, (x1 - x0) / 120)
    for x in stride(from: x0, through: x1, by: step) { out.append(p.px(x, y0)); out.append(p.px(x, y1)) }
    let vstep = max(1, (y1 - y0) / 40)
    for y in stride(from: y0, through: y1, by: vstep) { out.append(p.px(x0, y)); out.append(p.px(x1, y)) }
    return out
}

// Share of a row or column segment matching the background
func rowMatch(_ p: Pixels, y: Int, _ x0: Int, _ x1: Int, _ bg: RGB, _ tol: Int) -> Double {
    guard y >= 0, y < p.h, x1 >= x0 else { return 0 }
    var hit = 0, n = 0
    for x in stride(from: max(0, x0), through: min(p.w - 1, x1), by: 1) { n += 1; if dist(p.px(x, y), bg) <= tol { hit += 1 } }
    return n > 0 ? Double(hit) / Double(n) : 0
}
func colMatch(_ p: Pixels, x: Int, _ y0: Int, _ y1: Int, _ bg: RGB, _ tol: Int) -> Double {
    guard x >= 0, x < p.w, y1 >= y0 else { return 0 }
    var hit = 0, n = 0
    for y in stride(from: max(0, y0), through: min(p.h - 1, y1), by: 1) { n += 1; if dist(p.px(x, y), bg) <= tol { hit += 1 } }
    return n > 0 ? Double(hit) / Double(n) : 0
}

// A hairline: most of the segment a little off the background, too faint for the
// tolerance above. The 1px border between two white cards, scaled down to the working
// size, is exactly that, and without this the growth walked through it and three
// separate stat cards came back as one.
func rowFaint(_ p: Pixels, y: Int, _ x0: Int, _ x1: Int, _ bg: RGB) -> Bool {
    guard y >= 0, y < p.h, x1 > x0 else { return false }
    var hit = 0, n = 0
    for x in stride(from: max(0, x0), through: min(p.w - 1, x1), by: 1) { n += 1; if dist(p.px(x, y), bg) >= 10 { hit += 1 } }
    return n > 0 && Double(hit) / Double(n) >= 0.5
}
func colFaint(_ p: Pixels, x: Int, _ y0: Int, _ y1: Int, _ bg: RGB) -> Bool {
    guard x >= 0, x < p.w, y1 > y0 else { return false }
    var hit = 0, n = 0
    for y in stride(from: max(0, y0), through: min(p.h - 1, y1), by: 1) { n += 1; if dist(p.px(x, y), bg) >= 10 { hit += 1 } }
    return n > 0 && Double(hit) / Double(n) >= 0.5
}

// Grow outward from the text over pixels of its background until the colour changes:
// that edge is the chip, button or card the text sits on. Text straight on the page
// grows until it is most of the page, and has no container.
func container(_ p: Pixels, text: Box, bg: RGB) -> (Box, RGB)? {
    let th = text.y1 - text.y0 + 1
    let tol = 26
    var b = Box(x0: text.x0 - th / 4, y0: text.y0 - th / 5, x1: text.x1 + th / 4, y1: text.y1 + th / 5)
    b.x0 = max(0, b.x0); b.y0 = max(0, b.y0); b.x1 = min(p.w - 1, b.x1); b.y1 = min(p.h - 1, b.y1)
    let maxW = Int(Double(p.w) * 0.62), maxH = Int(Double(p.h) * 0.5)
    // strict first, so growth does not leak round a rounded corner
    var grew = true
    var steps = 0
    while grew && steps < 4000 {
        grew = false; steps += 1
        if b.y0 > 0, rowMatch(p, y: b.y0 - 1, b.x0, b.x1, bg, tol) >= 0.9, !rowFaint(p, y: b.y0 - 1, b.x0, b.x1, bg) { b.y0 -= 1; grew = true }
        if b.y1 < p.h - 1, rowMatch(p, y: b.y1 + 1, b.x0, b.x1, bg, tol) >= 0.9, !rowFaint(p, y: b.y1 + 1, b.x0, b.x1, bg) { b.y1 += 1; grew = true }
        if b.x0 > 0, colMatch(p, x: b.x0 - 1, b.y0, b.y1, bg, tol) >= 0.9, !colFaint(p, x: b.x0 - 1, b.y0, b.y1, bg) { b.x0 -= 1; grew = true }
        if b.x1 < p.w - 1, colMatch(p, x: b.x1 + 1, b.y0, b.y1, bg, tol) >= 0.9, !colFaint(p, x: b.x1 + 1, b.y0, b.y1, bg) { b.x1 += 1; grew = true }
        if b.x1 - b.x0 > maxW || b.y1 - b.y0 > maxH { return nil }
    }
    // then the rounded ends of a pill, which a full column never matches: sideways
    // only, and never further than the corner radius could be
    let reach = (b.y1 - b.y0) / 2
    var l = 0, r = 0
    while l < reach, b.x0 > 0, colMatch(p, x: b.x0 - 1, b.y0, b.y1, bg, tol) >= 0.3 { b.x0 -= 1; l += 1 }
    while r < reach, b.x1 < p.w - 1, colMatch(p, x: b.x1 + 1, b.y0, b.y1, bg, tol) >= 0.3 { b.x1 += 1; r += 1 }
    // whatever lies just outside must actually differ, or this is not an edge
    let out = dominant(ring(p, b, 2)).0
    if dist(out, bg) < 24 { return nil }
    return (b, out)
}

// ── panels, from their edges ─────────────────────────────────────────────
// Vision's rectangles miss a big light panel on a light page (a details pane, a
// sidebar, a stats grid's cards), and text growth only ever finds the box right
// around one line. A panel is drawn with hairline edges, so it is found from those:
// long straight runs where brightness steps, paired into rectangles. A rounded corner
// shortens each run by its radius, which the pairing allows for.
struct Seg { let at: Int, a: Int, b: Int }   // a line at `at`, from a to b inclusive

func segments(_ p: Pixels) -> (h: [Seg], v: [Seg]) {
    var L = [Int16](repeating: 0, count: p.w * p.h)
    for y in 0..<p.h { for x in 0..<p.w { let c = p.px(x, y); L[y * p.w + x] = Int16((c.0 * 54 + c.1 * 183 + c.2 * 19) >> 8) } }
    let thr: Int16 = 5
    let minH = max(24, p.w / 28), minV = max(24, p.h / 28)
    var hs = [Seg](), vs = [Seg]()
    // gaps of a couple of pixels are compression, not the end of the line
    func runs(_ n: Int, _ edge: (Int) -> Bool, _ minLen: Int, _ emit: (Int, Int) -> Void) {
        var start = -1, last = -1
        for i in 0..<n {
            if edge(i) { if start < 0 { start = i }; last = i }
            else if start >= 0, i - last > 2 { if last - start + 1 >= minLen { emit(start, last) }; start = -1 }
        }
        if start >= 0, last - start + 1 >= minLen { emit(start, last) }
    }
    for y in 1..<p.h {
        runs(p.w, { x in abs(L[y * p.w + x] - L[(y - 1) * p.w + x]) >= thr }, minH) { hs.append(Seg(at: y, a: $0, b: $1)) }
    }
    for x in 1..<p.w {
        runs(p.h, { y in abs(L[y * p.w + x] - L[y * p.w + x - 1]) >= thr }, minV) { vs.append(Seg(at: x, a: $0, b: $1)) }
    }
    return (hs, vs)
}

func panels(_ p: Pixels) -> [Box] {
    let (hs, vs) = segments(p)
    let corner = max(6, p.h / 40)          // the most a rounded corner can take off a run
    let same = max(3, p.h / 150)
    let minW = p.w / 25, minH = p.h / 25
    // Is there a line along rows ys from corner to corner of [a, b]? Runs on nearby rows
    // join across small breaks (a 1px border on a scaled frame wobbles a row), but not
    // across a real gap: a list row's divider meeting a card beyond the list, 60px on,
    // does not close a box.
    func edge(_ ys: ClosedRange<Int>, _ a: Int, _ b: Int) -> Bool {
        let from = a + corner + 2, to = b - corner - 2
        guard to > from else { return false }
        let runs = hs.filter { ys.contains($0.at) && $0.b >= from && $0.a <= to }.sorted { $0.a < $1.a }
        let gap = max(8, p.w / 160)
        var reach = from
        for r in runs {
            if r.a > reach + gap { break }
            reach = max(reach, r.b)
            if reach >= to { return true }
        }
        return false
    }
    var out = [Box]()
    for l in vs {
        // the nearest edge that closes a box, so a row of cards is cards, not every
        // span from one card's left edge to a later one's right
        for r in vs.filter({ $0.at - l.at >= minW }).sorted(by: { $0.at < $1.at }) {
            // Both sides usually run the same length. One breaks where something sits on
            // it (a header image flush with a panel's side), so a pair whose shorter side
            // covers most of the longer is tried at the longer one's ends as well.
            let lo = min(l.b, r.b) - max(l.a, r.a), hi = max(l.b, r.b) - min(l.a, r.a)
            guard lo > 0, (abs(r.a - l.a) <= same && abs(r.b - l.b) <= same) || Double(lo) >= Double(hi) * 0.6 else { continue }
            // a panel running off the top or bottom of the frame (cut by the crop) is
            // closed by the frame's edge
            var found: (Int, Int, Bool, Bool)? = nil
            for ya in Set([min(l.a, r.a), max(l.a, r.a)]).sorted() {
                for yb in Set([max(l.b, r.b), min(l.b, r.b)]).sorted(by: >) where found == nil && yb - ya >= minH {
                    let t = ya <= corner + 2, b = yb >= p.h - corner - 3
                    if (t || edge(max(1, ya - corner - 2)...(ya + 2), l.at, r.at)) &&
                        (b || edge((yb - 1)...min(p.h - 1, yb + corner + 2), l.at, r.at)) { found = (ya, yb, t, b) }
                }
            }
            guard let (y0, y1, atTop, atBottom) = found else { continue }
            // A grid or a picture is crossed edge to edge by line after line all the way
            // through; a panel by a divider, or by lines only within a header image, with
            // a long clear stretch (the cards inside it stop short of its edges).
            let across = hs.filter { $0.at > y0 + corner && $0.at < y1 - corner && Double(min($0.b, r.at) - max($0.a, l.at)) >= Double(r.at - l.at) * 0.97 }.map { $0.at }
            let down = vs.filter { $0.at > l.at + 2 && $0.at < r.at - 2 && Double(min($0.b, y1) - max($0.a, y0)) >= Double(y1 - y0) * 0.97 }.map { $0.at }
            func clear(_ cuts: [Int], _ a: Int, _ b: Int) -> Bool {
                if cuts.count <= 4 { return true }
                let at = ([a] + cuts.sorted() + [b])
                return zip(at, at.dropFirst()).map { $1 - $0 }.max()! >= (b - a) * 2 / 5
            }
            if !clear(across, y0, y1) || !clear(down, l.at, r.at) { break }
            // the edge rows themselves, found again, so the box sits on the line: the
            // nearest ones, since the next card's edge can be within a corner's reach
            let wide = { (s: Seg) in Double(min(s.b, r.at) - max(s.a, l.at)) >= Double(r.at - l.at) * 0.5 }
            let top = hs.filter { $0.at >= y0 - corner - 2 && $0.at <= y0 + 2 && wide($0) }.map { $0.at }.max() ?? (atTop ? 0 : y0)
            let bot = hs.filter { $0.at >= y1 - 1 && $0.at <= y1 + corner + 2 && wide($0) }.map { $0.at }.min() ?? (atBottom ? p.h : y1)
            let b = Box(x0: l.at, y0: top, x1: r.at - 1, y1: bot - 1)
            // the whole window is not a panel
            if b.x1 - b.x0 > p.w * 9 / 10 && b.y1 - b.y0 > p.h * 9 / 10 { continue }
            if !out.contains(where: { abs($0.x0 - b.x0) <= same && abs($0.x1 - b.x1) <= same && abs($0.y0 - b.y0) <= same && abs($0.y1 - b.y1) <= same }) { out.append(b) }
            break
        }
    }
    // a hairline has an edge on each side, and a card's edge can pair with its
    // neighbour's: of two near copies the inner one is the thing itself
    let areaOf = { (b: Box) in (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) }
    var kept = [Box]()
    for b in out.sorted(by: { areaOf($0) < areaOf($1) }) {
        let dup = kept.contains { k in
            let iw = min(k.x1, b.x1) - max(k.x0, b.x0) + 1, ih = min(k.y1, b.y1) - max(k.y0, b.y0) + 1
            guard iw > 0, ih > 0 else { return false }
            let i = iw * ih
            return Double(i) / Double(areaOf(k) + areaOf(b) - i) > 0.85
        }
        if !dup { kept.append(b) }
    }
    return kept
}

func detect(_ path: String) throws -> [String: Any] {
    guard let img = cgImage(path) else { throw NSError(domain: "Elements", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot read image"]) }
    guard let p = Pixels(img, maxW: 1600) else { throw NSError(domain: "Elements", code: 2, userInfo: [NSLocalizedDescriptionKey: "cannot decode image"]) }

    let text = VNRecognizeTextRequest()
    text.recognitionLevel = .accurate
    text.usesLanguageCorrection = true
    text.minimumTextHeight = 0.008
    let rects = VNDetectRectanglesRequest()
    rects.maximumObservations = 24
    rects.minimumAspectRatio = 0.05
    rects.minimumSize = 0.04
    rects.quadratureTolerance = 12
    rects.minimumConfidence = 0.6
    try VNImageRequestHandler(cgImage: img, options: [:]).perform([text, rects])

    let W = Double(p.w), H = Double(p.h)
    func frac(_ b: Box) -> [String: Double] {
        let r = { (v: Double) in (v * 10000).rounded() / 10000 }
        return ["x": r(Double(b.x0) / W), "y": r(Double(b.y0) / H),
                "w": r(Double(b.x1 - b.x0 + 1) / W), "h": r(Double(b.y1 - b.y0 + 1) / H)]
    }

    var texts = [[String: Any]]()
    for o in text.results ?? [] {
        guard let c = o.topCandidates(1).first else { continue }
        let s = c.string.trimmingCharacters(in: .whitespaces)
        if s.isEmpty { continue }
        let bb = o.boundingBox          // normalised, origin bottom left
        let tb = Box(x0: max(0, Int(bb.minX * W)), y0: max(0, Int((1 - bb.maxY) * H)),
                     x1: min(p.w - 1, Int(bb.maxX * W)), y1: min(p.h - 1, Int((1 - bb.minY) * H)))
        let th = max(2, tb.y1 - tb.y0)
        let (bg, share) = dominant(ring(p, tb, max(2, th / 3)))
        var e: [String: Any] = ["text": s, "conf": (Double(c.confidence) * 100).rounded() / 100,
                                "box": frac(tb), "bg": hex(bg), "bgShare": (share * 100).rounded() / 100]
        if share >= 0.55, let (cb, outside) = container(p, text: tb, bg: bg) {
            e["container"] = frac(cb)
            e["outside"] = hex(outside)
        }
        texts.append(e)
    }

    var boxes = [[String: Any]]()
    for r in rects.results ?? [] {
        let bb = r.boundingBox
        let b = Box(x0: Int(bb.minX * W), y0: Int((1 - bb.maxY) * H), x1: Int(bb.maxX * W) - 1, y1: Int((1 - bb.minY) * H) - 1)
        // the fill a little inside the edge, which is what someone calls it by
        let inner = Box(x0: b.x0 + 4, y0: b.y0 + 4, x1: b.x1 - 4, y1: b.y1 - 4)
        boxes.append(["box": frac(b), "bg": hex(dominant(ring(p, inner, 0)).0),
                      "conf": (Double(r.confidence) * 100).rounded() / 100])
    }
    for b in panels(p) {
        let inner = Box(x0: b.x0 + 4, y0: b.y0 + 4, x1: b.x1 - 4, y1: b.y1 - 4)
        boxes.append(["box": frac(b), "bg": hex(dominant(ring(p, inner, 0)).0), "conf": 0.9, "edges": true])
    }
    return ["width": img.width, "height": img.height, "texts": texts, "rects": boxes]
}

// Set-of-marks: each box outlined and numbered, so a model picks by number rather
// than by describing pixels back. Warm gold outline on a dark edge, readable on
// light and dark UI alike.
func draw(_ path: String, _ out: String, _ json: String) throws {
    guard let img = cgImage(path) else { throw NSError(domain: "Elements", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot read image"]) }
    let marks = (try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]]) ?? []
    let W = CGFloat(img.width), H = CGFloat(img.height)
    guard let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return }
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
    let ns = NSGraphicsContext(cgContext: ctx, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ns
    let unit = max(1, H / 900)
    let gold = NSColor(srgbRed: 0.941, green: 0.663, blue: 0.235, alpha: 1)
    let ink = NSColor(srgbRed: 0.102, green: 0.090, blue: 0.078, alpha: 1)
    for m in marks {
        guard let label = m["label"] as? String, let b = m["box"] as? [String: Double] else { continue }
        // CoreGraphics is bottom up
        let r = CGRect(x: CGFloat(b["x"] ?? 0) * W, y: H - CGFloat((b["y"] ?? 0) + (b["h"] ?? 0)) * H,
                       width: CGFloat(b["w"] ?? 0) * W, height: CGFloat(b["h"] ?? 0) * H).insetBy(dx: -2 * unit, dy: -2 * unit)
        let path = NSBezierPath(roundedRect: r, xRadius: 4 * unit, yRadius: 4 * unit)
        ink.withAlphaComponent(0.85).setStroke(); path.lineWidth = 5 * unit; path.stroke()
        gold.setStroke(); path.lineWidth = 2.5 * unit; path.stroke()
        let font = NSFont.systemFont(ofSize: 15 * unit, weight: .bold)
        let s = NSAttributedString(string: label, attributes: [.font: font, .foregroundColor: ink])
        let sz = s.size()
        let tagW = max(sz.width + 10 * unit, sz.height + 4 * unit), tagH = sz.height + 4 * unit
        // the tag sits on the box's top left corner, pulled inside the frame at the edges
        var tx = r.minX - 1 * unit, ty = r.maxY - tagH / 2
        tx = min(max(0, tx), W - tagW); ty = min(max(0, ty), H - tagH)
        let tag = CGRect(x: tx, y: ty, width: tagW, height: tagH)
        gold.setFill(); NSBezierPath(roundedRect: tag, xRadius: tagH / 2, yRadius: tagH / 2).fill()
        s.draw(at: CGPoint(x: tag.midX - sz.width / 2, y: tag.midY - sz.height / 2))
    }
    NSGraphicsContext.restoreGraphicsState()
    guard let done = ctx.makeImage() else { return }
    let rep = NSBitmapImageRep(cgImage: done)
    try rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8])?.write(to: URL(fileURLWithPath: out))
}

let args = CommandLine.arguments
do {
    if args.count >= 5, args[1] == "--draw" {
        try draw(args[2], args[3], args[4])
        print("{\"ok\":true}")
    } else if args.count >= 2 {
        let out = try detect(args[1])
        print(String(data: try JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
    } else {
        FileHandle.standardError.write("usage: Elements <image> | Elements --draw <image> <out.jpg> <json>\n".data(using: .utf8)!)
        exit(2)
    }
} catch {
    FileHandle.standardError.write("Elements: \(error.localizedDescription)\n".data(using: .utf8)!)
    exit(1)
}
