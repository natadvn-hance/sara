import SwiftUI

/// The talk, as a voice assistant (Boris, 08.11): her in the middle, big; no feed of messages. Her answer comes as a
/// plate that grows out of the Dynamic Island and lights up word by word as she says it.
struct TalkScreen: View {
    @EnvironmentObject private var engine: TalkEngine
    @Environment(\.colorScheme) private var scheme
    @State private var under: HanceAgent = .lora
    @State private var reveal: CGFloat = 1
    @State private var revealAt: CGPoint = .zero
    @State private var orbAt: CGPoint = .zero
    @State private var typing = false
    @State private var showTimings = false

    private var palette: Palette { .of(engine.agent, dark: scheme == .dark) }

    var body: some View {
        GeometryReader { geo in
            let orbSize = min(geo.size.width * 0.6, geo.size.height * 0.3, 280)
            ZStack(alignment: .top) {
                Backdrop(
                    under: Palette.of(under, dark: scheme == .dark), over: palette, reveal: reveal, center: revealAt)

                VStack(spacing: 0) {
                    topBar
                    Spacer(minLength: 0)
                    Button {
                        engine.press()
                    } label: {
                        Orb(agent: engine.agent, phase: engine.phase, meter: engine.meter, palette: palette, size: orbSize)
                    }
                    .buttonStyle(OrbPress())
                    .disabled(engine.phase == .sending || engine.phase == .thinking)
                    .background(
                        GeometryReader { g in
                            Color.clear.onAppear { orbAt = CGPoint(x: g.frame(in: .global).midX, y: g.frame(in: .global).midY) }
                        }
                    )
                    .padding(.vertical, -orbSize * 0.1)
                    who
                        .padding(.top, 6)
                    status
                        .padding(.top, 14)
                        .frame(minHeight: 96, alignment: .top)
                    Spacer(minLength: 0)
                    bottomBar
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 8)

                if let card = engine.card {
                    AnswerBanner(
                        card: card, palette: Palette.of(card.agent, dark: scheme == .dark),
                        speaking: engine.phase == .speaking, since: engine.since,
                        onClose: { withAnimation(.spring(response: 0.4)) { engine.dismissCard() } },
                        onReplay: { engine.replay() }
                    )
                    .id(card.id)
                    .padding(.horizontal, 10)
                    .padding(.top, 4)
                    .transition(.asymmetric(insertion: .identity, removal: .move(edge: .top).combined(with: .opacity)))
                    .zIndex(2)
                }
            }
            .animation(.spring(response: 0.45, dampingFraction: 0.8), value: engine.card)
        }
        .foregroundStyle(palette.ink)
        .animation(.easeInOut(duration: 0.8), value: engine.agent)
        .onChange(of: engine.agent) { old, _ in
            under = old
            revealAt = engine.revealFrom ?? orbAt
            reveal = 0
            withAnimation(.easeInOut(duration: 0.85)) { reveal = 1 }
        }
        .onAppear { under = engine.agent }
        .sheet(isPresented: $typing) {
            TypeSheet(agent: engine.agent, palette: palette) { text in
                typing = false
                engine.send(text: text)
            }
            .presentationDetents([.height(190)])
        }
        .sheet(isPresented: $showTimings) {
            TimingsSheet(palette: palette)
                .environmentObject(engine)
                .presentationDetents([.medium, .large])
        }
        .sensoryFeedback(.impact(weight: .light), trigger: engine.phase == .listening)
        .sensoryFeedback(.selection, trigger: engine.agent)
    }

    private var topBar: some View {
        HStack {
            HanceLogo(height: 20, mark: palette.accent, word: palette.ink)
                .knightHop(trigger: engine.agent, step: 5)
            Spacer()
            HStack(spacing: 7) {
                Circle()
                    .fill(engine.phase.isBusy ? palette.accent : palette.muted)
                    .frame(width: 7, height: 7)
                    .phaseAnimator([1.0, 0.35]) { v, x in
                        v.opacity(engine.phase.isBusy ? x : 1)
                    } animation: { _ in .easeInOut(duration: 0.7) }
                Text("\(engine.agent.name) · \(engine.phase.label)")
                    .monoLabel(11)
                    .foregroundStyle(palette.ink2)
                    .contentTransition(.interpolate)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(Capsule().fill(palette.paper.opacity(0.7)))
            .overlay(Capsule().stroke(palette.line, lineWidth: 0.5))
            .onLongPressGesture { showTimings = true }
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Долгое нажатие: замеры скорости")
        }
        .padding(.top, 8)
    }

    private var who: some View {
        VStack(spacing: 6) {
            Text(engine.agent.name)
                .font(HanceFont.text(46, .semibold))
                .tracking(-1.2)
                .id(engine.agent)
                .transition(.push(from: .bottom).combined(with: .opacity))
            Text(engine.agent.role)
                .monoLabel(11)
                .foregroundStyle(palette.muted)
                .id("role-\(engine.agent.rawValue)")
                .transition(.opacity)
        }
    }

    @ViewBuilder private var status: some View {
        VStack(spacing: 10) {
            switch engine.phase {
            case .listening:
                Text("Говори, я слушаю")
                    .font(HanceFont.text(19, .medium))
                Text("Пауза закончит запись. Нажми, чтобы отправить сразу")
                    .font(HanceFont.text(14))
                    .foregroundStyle(palette.muted)
            case .sending:
                Text("Разбираю голос")
                    .font(HanceFont.text(19, .medium))
            case .thinking:
                HStack(spacing: 8) {
                    Text("\(engine.agent.name) думает")
                        .font(HanceFont.text(19, .medium))
                    Text(engine.since, style: .timer)
                        .font(HanceFont.mono(13))
                        .foregroundStyle(palette.accentInk)
                        .monospacedDigit()
                }
                heardLine
            case .speaking:
                Text("Нажми, чтобы остановить")
                    .font(HanceFont.text(15))
                    .foregroundStyle(palette.muted)
            default:
                Text("Нажми и говори")
                    .font(HanceFont.text(19, .medium))
                Text("«позови \(engine.agent.other.accusative)»")
                    .font(HanceFont.text(15))
                    .foregroundStyle(palette.muted)
            }
            if let note = engine.note {
                Text(note)
                    .font(HanceFont.text(14, .medium))
                    .foregroundStyle(palette.accentInk)
                    .multilineTextAlignment(.center)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .multilineTextAlignment(.center)
        .animation(.easeInOut(duration: 0.25), value: engine.phase)
        .animation(.easeInOut(duration: 0.25), value: engine.note)
    }

    @ViewBuilder private var heardLine: some View {
        if let heard = engine.heard {
            Text("«\(heard)»")
                .font(HanceFont.text(15))
                .foregroundStyle(palette.ink2)
                .lineLimit(3)
                .padding(.horizontal, 12)
        }
    }

    private var bottomBar: some View {
        HStack(alignment: .center) {
            Button {
                typing = true
            } label: {
                Image(systemName: "keyboard")
                    .font(.system(size: 18, weight: .medium))
                    .frame(width: 52, height: 52)
                    .background(Circle().fill(palette.paper.opacity(0.8)))
                    .overlay(Circle().stroke(palette.line, lineWidth: 0.5))
            }
            .accessibilityLabel("Написать \(engine.agent.dative)")
            .disabled(engine.phase.isBusy)
            Spacer()
            CallOther(agent: engine.agent.other, palette: palette) { point in
                engine.call(engine.agent.other, from: point)
            }
            .disabled(engine.phase == .listening || engine.phase == .sending || engine.phase == .thinking)
        }
        .foregroundStyle(palette.ink2)
    }
}

/// The orb gives a little under the finger.
struct OrbPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.95 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.6), value: configuration.isPressed)
    }
}

/// The other one's picture: a tap calls her, and her colour opens from here.
struct CallOther: View {
    let agent: HanceAgent
    let palette: Palette
    let action: (CGPoint) -> Void
    @State private var at: CGPoint = .zero

    var body: some View {
        Button {
            action(at)
        } label: {
            HStack(spacing: 10) {
                Text("Позвать \(agent.accusative)")
                    .monoLabel(10)
                    .foregroundStyle(palette.ink2)
                Image(agent.photo)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 44, height: 44)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(palette.paper, lineWidth: 2))
                    .shadow(color: .black.opacity(0.12), radius: 6, y: 3)
                    .id(agent)
                    .transition(.scale.combined(with: .opacity))
            }
            .padding(.leading, 14)
            .padding(.trailing, 4)
            .padding(.vertical, 4)
            .background(Capsule().fill(palette.paper.opacity(0.8)))
            .overlay(Capsule().stroke(palette.line, lineWidth: 0.5))
        }
        .background(
            GeometryReader { g in
                Color.clear
                    .onAppear { at = CGPoint(x: g.frame(in: .global).maxX - 26, y: g.frame(in: .global).midY) }
                    .onChange(of: agent) { _, _ in
                        at = CGPoint(x: g.frame(in: .global).maxX - 26, y: g.frame(in: .global).midY)
                    }
            }
        )
        .accessibilityLabel("Позвать \(agent.accusative)")
    }
}

/// The page's colour: the one before, and the new one opening as a circle from where Boris touched.
struct Backdrop: View {
    let under: Palette
    let over: Palette
    let reveal: CGFloat
    let center: CGPoint

    var body: some View {
        GeometryReader { g in
            let local = CGPoint(x: center.x - g.frame(in: .global).minX, y: center.y - g.frame(in: .global).minY)
            let far = hypot(max(local.x, g.size.width - local.x), max(local.y, g.size.height - local.y)) + 40
            ZStack {
                layer(under, g.size)
                layer(over, g.size)
                    .mask(
                        Circle()
                            .frame(width: far * 2 * reveal, height: far * 2 * reveal)
                            .position(local)
                    )
            }
        }
        .ignoresSafeArea()
    }

    private func layer(_ p: Palette, _ size: CGSize) -> some View {
        ZStack {
            p.bg
            RadialGradient(
                colors: [p.accentSoft, p.bg.opacity(0)], center: UnitPoint(x: 0.5, y: 0.42), startRadius: 10,
                endRadius: max(size.width, size.height) * 0.62)
        }
    }
}
