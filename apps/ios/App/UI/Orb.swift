import SwiftUI

/// The middle of the screen, as a voice assistant: her face in a living drop of her colour. The drop breathes at rest,
/// swells and ripples with Boris's voice while she listens, swirls with orbiting comets while she thinks, and pulses
/// with her own voice while she speaks. Everything moves with the clock, so phases flow into each other.
struct Orb: View {
    let agent: HanceAgent
    let phase: TalkPhase
    let meter: LevelMeter
    let palette: Palette
    let size: CGFloat

    var body: some View {
        ZStack {
            TimelineView(.animation) { tl in
                let t = tl.date.timeIntervalSinceReferenceDate
                let e = energy(t)
                ZStack {
                    Canvas { ctx, canvas in halo(ctx, canvas, t, e) }
                    MeshGradient(width: 3, height: 3, points: points(t, e), colors: colors)
                        .mask(Blob(time: t, energy: e))
                        .frame(width: size, height: size)
                        .rotationEffect(.degrees(t * 9))
                        .scaleEffect(1 + 0.12 * e)
                        .shadow(color: palette.accent.opacity(0.28 + 0.25 * e), radius: 24 + 30 * e, y: 12)
                    Canvas { ctx, canvas in orbit(ctx, canvas, t) }
                }
                .frame(width: size * 1.75, height: size * 1.75)
            }
            Face(agent: agent, palette: palette, size: size * 0.62)
        }
        .frame(width: size * 1.75, height: size * 1.75)
        .accessibilityElement()
        .accessibilityLabel("\(agent.name) \(phase.label)")
    }

    private var colors: [Color] {
        [
            palette.accentLine, palette.accent, palette.accentInk,
            palette.accent, palette.accentLine.opacity(0.95), palette.accent,
            palette.accentInk, palette.accent, palette.accentLine,
        ]
    }

    /// How alive the drop is now, 0...1.
    private func energy(_ t: Double) -> Double {
        switch phase {
        case .listening: return 0.22 + 0.85 * meter.value
        case .speaking: return 0.22 + 0.8 * meter.value
        case .thinking: return 0.34 + 0.07 * sin(t * 2.6)
        case .sending: return 0.3 + 0.08 * sin(t * 6)
        default: return 0.1 + 0.05 * sin(t * 1.3)
        }
    }

    private func points(_ t: Double, _ e: Double) -> [SIMD2<Float>] {
        let w = 0.08 + 0.12 * e
        func p(_ x: Double, _ y: Double) -> SIMD2<Float> { SIMD2<Float>(Float(x), Float(y)) }
        let top = 0.5 + w * sin(t * 0.9)
        let left = 0.5 + w * sin(t * 1.1 + 2)
        let midX = 0.5 + w * sin(t * 1.3 + 1)
        let midY = 0.5 + w * sin(t * 1.7)
        let right = 0.5 + w * sin(t * 0.8 + 2)
        let bottom = 0.5 + w * sin(t * 1.2 + 3)
        return [
            p(0, 0), p(top, 0), p(1, 0),
            p(0, left), p(midX, midY), p(1, right),
            p(0, 1), p(bottom, 1), p(1, 1),
        ]
    }

    /// The glow under the drop and, while someone speaks, rings going out from it.
    private func halo(_ ctx: GraphicsContext, _ canvas: CGSize, _ t: Double, _ e: Double) {
        let c = CGPoint(x: canvas.width / 2, y: canvas.height / 2)
        let r = size / 2
        let glow = Path(ellipseIn: CGRect(x: c.x - r * 1.7, y: c.y - r * 1.7, width: r * 3.4, height: r * 3.4))
        ctx.fill(
            glow,
            with: .radialGradient(
                Gradient(colors: [palette.accent.opacity(0.22 + 0.25 * e), palette.accent.opacity(0)]),
                center: c, startRadius: r * 0.5, endRadius: r * 1.7))
        guard phase == .listening || phase == .speaking else { return }
        for i in 0..<3 {
            let f = (t * 0.55 + Double(i) / 3).truncatingRemainder(dividingBy: 1)
            let rr = r * (0.98 + 0.62 * f)
            let ring = Path(ellipseIn: CGRect(x: c.x - rr, y: c.y - rr, width: rr * 2, height: rr * 2))
            let a = pow(1 - f, 1.6) * (0.12 + 0.7 * e)
            ctx.stroke(ring, with: .color(palette.accent.opacity(a)), lineWidth: 1.2 + 2.4 * e * (1 - f))
        }
    }

    /// While she thinks: three comets around her; while the voice goes up: one quick arc.
    private func orbit(_ ctx: GraphicsContext, _ canvas: CGSize, _ t: Double) {
        let c = CGPoint(x: canvas.width / 2, y: canvas.height / 2)
        let r = size / 2 * 1.16
        if phase == .thinking {
            for k in 0..<3 {
                let head = t * 1.9 + Double(k) * 2 * .pi / 3
                for j in 0..<10 {
                    let a = head - Double(j) * 0.07
                    let wobble = 1 + 0.05 * sin(t * 3 + Double(k))
                    let p = CGPoint(x: c.x + cos(a) * r * wobble, y: c.y + sin(a) * r * wobble)
                    let d = 6.5 * (1 - Double(j) / 11)
                    ctx.fill(
                        Path(ellipseIn: CGRect(x: p.x - d / 2, y: p.y - d / 2, width: d, height: d)),
                        with: .color(palette.accent.opacity(0.9 * (1 - Double(j) / 10))))
                }
            }
        } else if phase == .sending {
            let start = Angle.radians(t * 7)
            var arc = Path()
            arc.addArc(center: c, radius: r, startAngle: start, endAngle: start + .degrees(80), clockwise: false)
            ctx.stroke(arc, with: .color(palette.accent), style: StrokeStyle(lineWidth: 4, lineCap: .round))
        }
    }
}

/// The drop's outline: a circle that wobbles more the more alive it is.
struct Blob: Shape {
    var time: Double
    var energy: Double

    func path(in rect: CGRect) -> Path {
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let r = min(rect.width, rect.height) / 2 * 0.9
        let amp = 0.025 + 0.08 * energy
        var p = Path()
        let n = 120
        for i in 0...n {
            let a = Double(i) / Double(n) * 2 * .pi
            let w1: Double = 0.55 * sin(3 * a + time * 1.6)
            let w2: Double = 0.3 * sin(5 * a - time * 2.3 + 1.3)
            let w3: Double = 0.15 * sin(2 * a + time * 0.9 + 0.4)
            let k: Double = 1 + amp * (w1 + w2 + w3)
            let pt = CGPoint(x: c.x + cos(a) * r * k, y: c.y + sin(a) * r * k)
            if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
        }
        p.closeSubpath()
        return p
    }
}

/// Her face, which makes a knight's move when the other one comes: up two, across one, and lands.
struct Face: View {
    let agent: HanceAgent
    let palette: Palette
    let size: CGFloat

    var body: some View {
        ZStack {
            Image(agent.photo)
                .resizable()
                .scaledToFill()
                .frame(width: size, height: size)
                .clipShape(Circle())
                .overlay(Circle().stroke(palette.paper.opacity(0.95), lineWidth: 3))
                .id(agent)
                .transition(
                    .asymmetric(
                        insertion: .scale(scale: 0.5).combined(with: .opacity),
                        removal: .scale(scale: 1.25).combined(with: .opacity)))
        }
        .animation(.spring(response: 0.55, dampingFraction: 0.72), value: agent)
        .knightHop(trigger: agent, step: size * 0.16)
    }
}
