import Cocoa

// renders an emoji onto a rounded gradient tile → iconset PNGs
let emoji = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "🐶"
let outDir = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "icon.iconset"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
    let size = CGFloat(px)
    let img = NSImage(size: NSSize(width: size, height: size))
    img.lockFocus()

    let inset = size * 0.06
    let rect = NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
    let path = NSBezierPath(roundedRect: rect, xRadius: size * 0.22, yRadius: size * 0.22)
    NSGradient(colors: [NSColor(calibratedRed: 1.00, green: 0.78, blue: 0.36, alpha: 1),
                        NSColor(calibratedRed: 0.98, green: 0.45, blue: 0.42, alpha: 1)])?
        .draw(in: path, angle: -90)

    let font = NSFont.systemFont(ofSize: size * 0.60)
    let attrs: [NSAttributedString.Key: Any] = [.font: font]
    let s = NSAttributedString(string: emoji, attributes: attrs)
    let b = s.size()
    s.draw(at: NSPoint(x: (size - b.width) / 2, y: (size - b.height) / 2 - size * 0.02))

    img.unlockFocus()
    let tiff = img.tiffRepresentation!
    return NSBitmapImageRep(data: tiff)!.representation(using: .png, properties: [:])!
}

for (px, name) in [(16, "icon_16x16"), (32, "icon_16x16@2x"), (32, "icon_32x32"), (64, "icon_32x32@2x"),
                   (128, "icon_128x128"), (256, "icon_128x128@2x"), (256, "icon_256x256"),
                   (512, "icon_256x256@2x"), (512, "icon_512x512"), (1024, "icon_512x512@2x")] {
    try! render(px).write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
}
print("iconset written to \(outDir)")
