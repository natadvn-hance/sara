import SwiftUI

/// The Hance knight (Сайт/assets/logo.svg): a bar, a column and the rounded chest, in its own 450 by 450 box, fitted
/// into the rect without stretching.
struct KnightMark: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.addRect(CGRect(x: 0, y: 0, width: 450, height: 196.579))
        p.addRect(CGRect(x: 225, y: 0, width: 225, height: 448.421))
        p.move(to: CGPoint(x: 0, y: 410.283))
        p.addCurve(
            to: CGPoint(x: 160, y: 250.283),
            control1: CGPoint(x: 0, y: 321.918),
            control2: CGPoint(x: 71.6344, y: 250.283))
        p.addLine(to: CGPoint(x: 450, y: 250.283))
        p.addLine(to: CGPoint(x: 450, y: 450.02))
        p.addLine(to: CGPoint(x: 0, y: 450.02))
        p.closeSubpath()
        let s = min(rect.width, rect.height) / 450.02
        let tx = rect.midX - 225 * s
        let ty = rect.midY - 225.01 * s
        return p.applying(CGAffineTransform(a: s, b: 0, c: 0, d: s, tx: tx, ty: ty))
    }
}

/// The logo as on the site's header: the knight in the colour of the one who speaks, the word in ink.
struct HanceLogo: View {
    var height: CGFloat = 20
    var mark: Color
    var word: Color

    var body: some View {
        HStack(alignment: .center, spacing: height * 0.42) {
            KnightMark().fill(mark).frame(width: height, height: height)
            Wordmark().fill(word).frame(width: height * 3.95 * 0.86, height: height * 0.86)
        }
        .accessibilityElement()
        .accessibilityLabel("Hance")
    }
}
