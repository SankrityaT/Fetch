import AppKit

// Menu bar icons, built from the painted mascot rather than drawn geometry.
// nativeImage cannot decode SVG, so these ship as PNG at 1x and 2x.
// Recording state keeps the same face and adds a red badge, which reads faster
// at 22 points than recolouring the whole head.
func tray(_ px: CGFloat, recording: Bool) -> Data {
    let canvas = NSImage(size: NSSize(width: px, height: px))
    canvas.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .high

    if let art = NSImage(contentsOfFile: "assets/mascot/idle.png") {
        // crop to the head: the source art is head plus chest, and the chest
        // eats the pixels the face needs at this size
        let s = art.size
        let src = NSRect(x: s.width * 0.06, y: s.height * 0.33, width: s.width * 0.88, height: s.height * 0.62)
        let fit = px * 0.94                       // leave a little air, menu bars are tight
        let scale = min(fit / src.width, fit / src.height)
        let w = src.width * scale, h = src.height * scale
        let dst = NSRect(x: (px - w) / 2, y: (px - h) / 2, width: w, height: h)
        art.draw(in: dst, from: src, operation: .sourceOver, fraction: 1)
    }

    if recording {
        let d = px * 0.30                        // small enough not to cover the face
        let badge = NSRect(x: px - d - px * 0.01, y: px * 0.01, width: d, height: d)
        // a dark ring keeps the badge legible on a light menu bar
        NSColor(srgbRed: 0.04, green: 0.035, blue: 0.03, alpha: 0.85).setFill()
        NSBezierPath(ovalIn: badge.insetBy(dx: -px * 0.028, dy: -px * 0.028)).fill()
        NSColor(srgbRed: 1.0, green: 0.27, blue: 0.22, alpha: 1).setFill()
        NSBezierPath(ovalIn: badge).fill()
    }

    canvas.unlockFocus()
    let rep = NSBitmapImageRep(data: canvas.tiffRepresentation!)!
    return rep.representation(using: .png, properties: [:])!
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "assets"
for (name, rec) in [("tray-idle", false), ("tray-rec", true)] {
    try! tray(22, recording: rec).write(to: URL(fileURLWithPath: "\(out)/\(name).png"))
    try! tray(44, recording: rec).write(to: URL(fileURLWithPath: "\(out)/\(name)@2x.png"))
}
print("tray icons written from the painted mascot")
