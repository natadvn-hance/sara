import SwiftUI

// The pieces of the talk's language (hance.pro/ekaterina_kp, Boris 09.11) that the app, the island, the notification
// and the widget share: square pixels for the voice, corner marks, the agent's index and her square face.

/// A strip of square pixels from levels 0...1: each value a column, lit from the bottom, or from the middle for her
/// voice. Unlit cells stay as a faint grid.
struct PixelBars: View {
    let values: [Double]
    var rows = 4
    var cell: CGFloat = 3
    var gap: CGFloat = 1.5
    let color: Color
    let empty: Color
    var centered = false

    var body: some View {
        HStack(alignment: .bottom, spacing: gap) {
            ForEach(Array(values.enumerated()), id: \.offset) { _, v in
                let h = Int((min(1, max(0, v)) * Double(rows)).rounded(.up))
                VStack(spacing: gap) {
                    ForEach(0..<rows, id: \.self) { r in
                        Rectangle()
                            .fill(lit(r, h) ? color : empty)
                            .frame(width: cell, height: cell)
                    }
                }
            }
        }
        .animation(.easeOut(duration: 0.18), value: values)
    }

    private func lit(_ r: Int, _ h: Int) -> Bool {
        if centered {
            return abs(Double(r) - Double(rows - 1) / 2) < Double(h) / 2 + 0.01
        }
        return rows - 1 - r < h
    }

    /// A few levels spread over more columns, each between its neighbours, so a wide strip still follows the voice.
    static func spread(_ v: [Double], to n: Int) -> [Double] {
        guard v.count > 1, n > 1 else { return Array(repeating: v.first ?? 0, count: max(n, 1)) }
        return (0..<n).map { i in
            let x = Double(i) / Double(n - 1) * Double(v.count - 1)
            let a = Int(x)
            let b = min(a + 1, v.count - 1)
            let f = x - Double(a)
            // A small even-odd step keeps neighbouring columns from looking the same.
            return (v[a] * (1 - f) + v[b] * f) * (i % 2 == 0 ? 1 : 0.82)
        }
    }
}

/// Four corner marks, like the frame of a viewfinder.
struct CornerMarks: Shape {
    let arm: CGFloat
    let inset: CGFloat

    func path(in rect: CGRect) -> Path {
        let r = rect.insetBy(dx: inset, dy: inset)
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.minY + arm))
        p.addLine(to: CGPoint(x: r.minX, y: r.minY))
        p.addLine(to: CGPoint(x: r.minX + arm, y: r.minY))
        p.move(to: CGPoint(x: r.maxX - arm, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.minY + arm))
        p.move(to: CGPoint(x: r.maxX, y: r.maxY - arm))
        p.addLine(to: CGPoint(x: r.maxX, y: r.maxY))
        p.addLine(to: CGPoint(x: r.maxX - arm, y: r.maxY))
        p.move(to: CGPoint(x: r.minX + arm, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX, y: r.maxY - arm))
        return p
    }
}

/// Three squares in an L, the knight of the pixel strip.
struct PixelKnight: View {
    let color: Color
    var cell: CGFloat = 4
    var gap: CGFloat = 1

    var body: some View {
        VStack(alignment: .leading, spacing: gap) {
            HStack(spacing: gap) {
                Rectangle().fill(color).frame(width: cell, height: cell)
                Rectangle().fill(color).frame(width: cell, height: cell)
            }
            Rectangle().fill(color).frame(width: cell, height: cell)
        }
        .accessibilityHidden(true)
    }
}

extension HanceAgent {
    /// Her index on the pages of Hance: [01] Lora, [02] Sara.
    var index: String { self == .lora ? "[01]" : "[02]" }
}

/// Her square photo with rounded corners, the face of the talk everywhere; corner marks while she works.
struct SquareFace: View {
    let agent: HanceAgent
    let size: CGFloat
    var radius: CGFloat? = nil
    var busy = false
    var stroke: Color? = nil

    var body: some View {
        let r = radius ?? size * 0.22
        Image(agent.cardPhoto)
            .resizable()
            .scaledToFill()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: r, style: .continuous))
            .overlay {
                if busy && size >= 40 {
                    CornerMarks(arm: size * 0.16, inset: size * 0.1)
                        .stroke(.white, style: StrokeStyle(lineWidth: 1.6, lineCap: .square))
                }
            }
            .overlay {
                if let stroke {
                    RoundedRectangle(cornerRadius: r, style: .continuous).stroke(stroke, lineWidth: size > 30 ? 2 : 1.4)
                }
            }
    }
}
