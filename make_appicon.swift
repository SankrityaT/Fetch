import AppKit

// Builds the macOS app icon: the painted mascot on a warm rounded tile.
// Apple's grid leaves margin around the tile, so the art does not fill the canvas.
func icon(_ px: CGFloat) -> Data {
    let img = NSImage(size: NSSize(width: px, height: px))
    img.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .high

    let inset = px * 0.055
    let rect = NSRect(x: inset, y: inset, width: px - inset * 2, height: px - inset * 2)
    let tile = NSBezierPath(roundedRect: rect, xRadius: px * 0.225, yRadius: px * 0.225)
    // dark tile: the mascot is gold, so a gold tile swallows it
    NSGradient(colors: [NSColor(srgbRed: 0.20, green: 0.16, blue: 0.13, alpha: 1),
                        NSColor(srgbRed: 0.04, green: 0.035, blue: 0.03, alpha: 1)])?
        .draw(in: tile, angle: -90)
    NSColor(srgbRed: 0.94, green: 0.66, blue: 0.24, alpha: 0.55).setStroke()
    tile.lineWidth = max(1, px * 0.006)
    tile.stroke()

    // a soft glow so the head separates from the tile
    tile.setClip()
    if let glow = NSGradient(colors: [NSColor(srgbRed: 0.94, green: 0.66, blue: 0.24, alpha: 0.22),
                                      NSColor(srgbRed: 0.94, green: 0.66, blue: 0.24, alpha: 0)]) {
        glow.draw(in: NSRect(x: px * 0.10, y: px * 0.12, width: px * 0.80, height: px * 0.80),
                  relativeCenterPosition: .zero)
    }

    if let dog = NSImage(contentsOfFile: "assets/mascot/idle.png") {
        let s = px * 0.60
        dog.draw(in: NSRect(x: (px - s) / 2, y: (px - s) / 2 + px * 0.02, width: s, height: s),
                 from: .zero, operation: .sourceOver, fraction: 1)
    }

    img.unlockFocus()
    let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
    return rep.representation(using: .png, properties: [:])!
}

let dir = "/tmp/fetch.iconset"
try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
for (px, name) in [(16, "icon_16x16"), (32, "icon_16x16@2x"), (32, "icon_32x32"), (64, "icon_32x32@2x"),
                   (128, "icon_128x128"), (256, "icon_128x128@2x"), (256, "icon_256x256"),
                   (512, "icon_256x256@2x"), (512, "icon_512x512"), (1024, "icon_512x512@2x")] {
    try! icon(CGFloat(px)).write(to: URL(fileURLWithPath: "\(dir)/\(name).png"))
}
print("iconset written")
