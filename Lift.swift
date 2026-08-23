import AppKit
import CoreImage
import Foundation
import Vision

// Cuts subjects out of generated artwork using Vision's foreground instance mask,
// the same subject lifting Preview uses. Runs locally, no service.
//
//   Lift <image> <outDir> grid <rows> <cols> [names...]   slice a sheet, lift each cell
//   Lift <image> <outDir> instances [names...]            auto-detect separate subjects
//   Lift <image> <outDir> single <name>                   one subject in the image

let ci = CIContext()

func cgImage(_ path: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

func writePNG(_ img: CGImage, _ path: String) {
    let rep = NSBitmapImageRep(cgImage: img)
    rep.size = NSSize(width: img.width, height: img.height)
    try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
}

// crop to the visible pixels, then pad back out to a square with a small margin
// so every export shares one optical centre
func trimAndSquare(_ img: CGImage, margin: CGFloat = 0.06) -> CGImage? {
    guard let data = img.dataProvider?.data, let ptr = CFDataGetBytePtr(data) else { return img }
    let w = img.width, h = img.height
    let bpr = img.bytesPerRow, bpp = img.bitsPerPixel / 8
    guard bpp >= 4 else { return img }
    var minX = w, minY = h, maxX = 0, maxY = 0
    for y in 0..<h {
        for x in 0..<w {
            let a = ptr[y * bpr + x * bpp + 3]
            if a > 12 {
                if x < minX { minX = x }; if x > maxX { maxX = x }
                if y < minY { minY = y }; if y > maxY { maxY = y }
            }
        }
    }
    guard maxX > minX, maxY > minY else { return img }
    let cropped = img.cropping(to: CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1))
    guard let c = cropped else { return img }

    let side = Int(CGFloat(max(c.width, c.height)) * (1 + margin * 2))
    guard let ctx = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return c }
    ctx.interpolationQuality = .high
    ctx.draw(c, in: CGRect(x: (side - c.width) / 2, y: (side - c.height) / 2, width: c.width, height: c.height))
    return ctx.makeImage()
}

// returns one masked image per detected subject
func lift(_ img: CGImage, separate: Bool) -> [CGImage] {
    let handler = VNImageRequestHandler(cgImage: img)
    let req = VNGenerateForegroundInstanceMaskRequest()
    do { try handler.perform([req]) } catch { FileHandle.standardError.write("vision failed\n".data(using: .utf8)!); return [] }
    guard let res = req.results?.first, !res.allInstances.isEmpty else { return [] }

    let groups: [IndexSet] = separate ? res.allInstances.map { IndexSet(integer: $0) } : [res.allInstances]
    var out: [CGImage] = []
    for g in groups {
        guard let buf = try? res.generateMaskedImage(ofInstances: g, from: handler, croppedToInstancesExtent: true)
        else { continue }
        let image = CIImage(cvPixelBuffer: buf)
        if let cg = ci.createCGImage(image, from: image.extent) { out.append(cg) }
    }
    return out
}

func slice(_ img: CGImage, rows: Int, cols: Int) -> [CGImage] {
    let cw = img.width / cols, ch = img.height / rows
    var cells: [CGImage] = []
    for r in 0..<rows {
        for c in 0..<cols {
            if let cell = img.cropping(to: CGRect(x: c * cw, y: r * ch, width: cw, height: ch)) {
                cells.append(cell)
            }
        }
    }
    return cells
}

// ---- main ----
let a = CommandLine.arguments
guard a.count >= 4, let img = cgImage(a[1]) else {
    print("usage: Lift <image> <outDir> grid <rows> <cols> [names...] | instances [names...] | single <name>")
    exit(2)
}
let outDir = a[2], mode = a[3]
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

func save(_ images: [CGImage], names: [String], prefix: String) {
    for (i, im) in images.enumerated() {
        guard let final = trimAndSquare(im) else { continue }
        let name = i < names.count ? names[i] : "\(prefix)-\(i + 1)"
        writePNG(final, "\(outDir)/\(name).png")
        print("  \(name).png  \(final.width)x\(final.height)")
    }
}

switch mode {
case "grid":
    guard a.count >= 6, let rows = Int(a[4]), let cols = Int(a[5]) else { exit(2) }
    let names = Array(a.dropFirst(6))
    var lifted: [CGImage] = []
    for cell in slice(img, rows: rows, cols: cols) {
        if let one = lift(cell, separate: false).first { lifted.append(one) }
        else { print("  (no subject found in a cell)") }
    }
    print("lifted \(lifted.count) of \(rows * cols) cells")
    save(lifted, names: names, prefix: "cell")
case "instances":
    let names = Array(a.dropFirst(4))
    let all = lift(img, separate: true)
    print("found \(all.count) subjects")
    save(all, names: names, prefix: "pose")
default:
    let names = Array(a.dropFirst(4))
    let one = lift(img, separate: false)
    save(one, names: names.isEmpty ? ["subject"] : names, prefix: "subject")
}
