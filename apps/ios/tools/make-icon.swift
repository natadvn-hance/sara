// The app icon: the Hance knight in warm paper on the orange of Hance, as the PWA's talk-icon.svg.
// Run: swift tools/make-icon.swift App/Assets.xcassets/AppIcon.appiconset/icon-1024.png
import AppKit

let size = 1024.0
let out = CommandLine.arguments[1]
let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext
ctx.setFillColor(CGColor(srgbRed: 1, green: 0x3D / 255.0, blue: 0, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))
// The knight in a 450 box, 48% of the icon, centred; the context is flipped to the SVG's y-down.
let s = size * 0.48 / 450
ctx.translateBy(x: (size - 450 * s) / 2, y: size - (size - 450 * s) / 2)
ctx.scaleBy(x: s, y: -s)
let p = CGMutablePath()
p.addRect(CGRect(x: 0, y: 0, width: 450, height: 196.579))
p.addRect(CGRect(x: 225, y: 0, width: 225, height: 448.421))
p.move(to: CGPoint(x: 0, y: 410.283))
p.addCurve(to: CGPoint(x: 160, y: 250.283), control1: CGPoint(x: 0, y: 321.918), control2: CGPoint(x: 71.6344, y: 250.283))
p.addLine(to: CGPoint(x: 450, y: 250.283))
p.addLine(to: CGPoint(x: 450, y: 450.02))
p.addLine(to: CGPoint(x: 0, y: 450.02))
p.closeSubpath()
ctx.addPath(p)
ctx.setFillColor(CGColor(srgbRed: 0xF3 / 255.0, green: 0xF2 / 255.0, blue: 0xEF / 255.0, alpha: 1))
ctx.fillPath()
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
