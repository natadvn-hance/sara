import SwiftUI

/// The middle of the screen, one language with the PWA (talk-design-language.md): her face big, and behind it three
/// blurred clouds of her colour that slowly change shape and turn. Listening, the clouds and the ring grow with Boris's
/// voice; thinking, a gradient arc spins round her and three knights fly on an orbit; speaking, the clouds pulse with
/// her voice and rings go out in waves. At rest the face floats a little.
struct AvatarStage: View {
    let agent: HanceAgent
    let phase: TalkPhase
    let meter: LevelMeter
    let palette: Palette
    /// The face's diameter.
    let size: CGFloat

    var body: some View {
        ZStack {
            TimelineView(.animation) { tl in
                let t = tl.date.timeIntervalSinceReferenceDate
                let e = phase == .listening || phase == .speaking ? meter.value : 0
                ZStack {
                    clouds(t, e)
                    Canvas { ctx, canvas in marks(ctx, canvas, t, e) }
                }
            }
            Face(agent: agent, palette: palette, size: size)
                .phaseAnimator([-1.0, 1.0]) { face, y in
                    face.offset(y: phase.isBusy ? 0 : y * 3.5)
                } animation: { _ in .easeInOut(duration: 3) }
        }
        .frame(width: size * 1.9, height: size * 1.9)
        .accessibilityElement()
        .accessibilityLabel("\(agent.name), \(phase.label)")
    }

    /// Three clouds: each a wobbling drop, turning at its own pace (9, 12, 15 s), blurred together.
    private func clouds(_ t: Double, _ e: Double) -> some View {
        let grow: Double
        switch phase {
        case .listening: grow = 1 + 0.55 * e
        case .speaking: grow = 1 + 0.3 * e + 0.04 * sin(t * 5)
        case .thinking: grow = 1.06 + 0.04 * sin(t * 2.4)
        default: grow = 1 + 0.03 * sin(t * 1.1)
        }
        let periods: [Double] = [9, 12, 15]
        return ZStack {
            ForEach(0..<3, id: \.self) { i in
                let turn = t * 2 * .pi / periods[i] * (i == 1 ? -1 : 1)
                Blob(time: t * 0.35 + Double(i) * 2.1, energy: 0.9)
                    .fill(i == 1 ? palette.accentSoft : palette.accent)
                    .frame(width: size * (1.08 - 0.06 * Double(i)), height: size * (0.98 + 0.05 * Double(i)))
                    .offset(x: cos(turn) * size * 0.07, y: sin(turn) * size * 0.07)
                    .rotationEffect(.radians(turn))
                    .opacity(i == 1 ? 0.85 : 0.55)
            }
        }
        .scaleEffect(grow)
        .blur(radius: size * 0.11)
    }

    /// The ring, the waves, the thinking arc with its knights, the arc of the voice going up.
    private func marks(_ ctx: GraphicsContext, _ canvas: CGSize, _ t: Double, _ e: Double) {
        let c = CGPoint(x: canvas.width / 2, y: canvas.height / 2)
        let r = size / 2
        func circle(_ radius: CGFloat) -> Path {
            Path(ellipseIn: CGRect(x: c.x - radius, y: c.y - radius, width: radius * 2, height: radius * 2))
        }
        switch phase {
        case .listening:
            let rr = (r + 7) * (1 + 0.16 * e)
            ctx.stroke(circle(rr), with: .color(palette.accent.opacity(0.85)), lineWidth: 2.5)
        case .speaking:
            for i in 0..<3 {
                let f = ((t + Double(i) * 0.7) / 2.1).truncatingRemainder(dividingBy: 1)
                let rr = r * (1.02 + 0.62 * f)
                ctx.stroke(
                    circle(rr), with: .color(palette.accent.opacity(pow(1 - f, 1.4) * (0.35 + 0.55 * e))),
                    lineWidth: 1.5 + 2 * (1 - f))
            }
        case .thinking:
            let start = Angle.radians(t * 2 * .pi / 1.4)
            var arc = Path()
            arc.addArc(center: c, radius: r + 9, startAngle: start, endAngle: start + .degrees(120), clockwise: false)
            ctx.stroke(
                arc,
                with: .conicGradient(
                    Gradient(colors: [palette.accent.opacity(0), palette.accent]), center: c,
                    angle: start - .degrees(4)),
                style: StrokeStyle(lineWidth: 4, lineCap: .round))
            for k in 0..<3 {
                let a = t * 2 * .pi / 3.2 + Double(k) * 2 * .pi / 3
                let p = CGPoint(x: c.x + cos(a) * r * 1.3, y: c.y + sin(a) * r * 1.3)
                let s: CGFloat = 11
                var knight = ctx
                knight.translateBy(x: p.x, y: p.y)
                knight.rotate(by: .radians(a + .pi / 2))
                knight.fill(
                    KnightMark().path(in: CGRect(x: -s / 2, y: -s / 2, width: s, height: s)),
                    with: .color(palette.accent))
            }
        case .sending:
            let start = Angle.radians(t * 7)
            var arc = Path()
            arc.addArc(center: c, radius: r + 9, startAngle: start, endAngle: start + .degrees(80), clockwise: false)
            ctx.stroke(arc, with: .color(palette.accent), style: StrokeStyle(lineWidth: 4, lineCap: .round))
        default:
            ctx.stroke(circle(r + 7), with: .color(palette.accent.opacity(0.25)), lineWidth: 1.5)
        }
    }
}

/// A cloud's outline: a circle that wobbles.
struct Blob: Shape {
    var time: Double
    var energy: Double

    func path(in rect: CGRect) -> Path {
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let rx = rect.width / 2 * 0.9
        let ry = rect.height / 2 * 0.9
        let amp = 0.025 + 0.08 * energy
        var p = Path()
        let n = 96
        for i in 0...n {
            let a = Double(i) / Double(n) * 2 * .pi
            let w1: Double = 0.55 * sin(3 * a + time * 1.6)
            let w2: Double = 0.3 * sin(5 * a - time * 2.3 + 1.3)
            let w3: Double = 0.15 * sin(2 * a + time * 0.9 + 0.4)
            let k: Double = 1 + amp * (w1 + w2 + w3)
            let pt = CGPoint(x: c.x + cos(a) * rx * k, y: c.y + sin(a) * ry * k)
            if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
        }
        p.closeSubpath()
        return p
    }
}

/// Her face. When the other one comes, the new face turns in like a card (from -80 degrees, a spring of 0.9 s).
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
                .shadow(color: .black.opacity(0.12), radius: 18, y: 8)
                .id(agent)
                .transition(
                    .asymmetric(
                        insertion: .modifier(active: Flip(angle: -80, opacity: 0), identity: Flip(angle: 0, opacity: 1)),
                        removal: .modifier(active: Flip(angle: 80, opacity: 0), identity: Flip(angle: 0, opacity: 1))))
        }
        .animation(Motion.spring(0.9), value: agent)
    }
}

/// A turn round the upright axis, as the PWA's rotateY.
struct Flip: ViewModifier {
    let angle: Double
    let opacity: Double

    func body(content: Content) -> some View {
        content
            .rotation3DEffect(.degrees(angle), axis: (x: 0, y: 1, z: 0), perspective: 0.6)
            .opacity(opacity)
    }
}
