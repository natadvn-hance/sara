import SwiftUI

/// The talk as a voice assistant (Boris, 08.11), one language with the PWA (talk-design-language.md): the logo and
/// her status on top; her face big in the middle, which is the button; her name, her role and one line under it; the
/// hint and the call of the other one below. No feed of messages: her answer comes as a plate that grows out of the
/// Dynamic Island and lights up word by word as she says it.
struct TalkScreen: View {
    @EnvironmentObject private var engine: TalkEngine
    @Environment(\.colorScheme) private var scheme
    @State private var under: HanceAgent = .lora
    @State private var reveal: CGFloat = 1
    @State private var faceAt: CGPoint = .zero
    @State private var typing = false
    @State private var showTimings = false

    private var palette: Palette { .of(engine.agent, dark: scheme == .dark) }

    var body: some View {
        GeometryReader { geo in
            let face = min(geo.size.width * 0.64, 260, geo.size.height * 0.34)
            ZStack(alignment: .top) {
                Backdrop(
                    under: Palette.of(under, dark: scheme == .dark), over: palette, reveal: reveal, center: faceAt)

                VStack(spacing: 0) {
                    topBar
                    Spacer(minLength: 0)
                    Button {
                        engine.press()
                    } label: {
                        // Her clouds spread wider than the screen; only the face and a little air take room.
                        AvatarStage(
                            agent: engine.agent, phase: engine.phase, meter: engine.meter, palette: palette, size: face)
                            .frame(width: face, height: face * 1.3)
                    }
                    .buttonStyle(FacePress())
                    .disabled(engine.phase == .sending || engine.phase == .thinking)
                    .background(
                        GeometryReader { g in
                            Color.clear.onAppear {
                                faceAt = CGPoint(x: g.frame(in: .global).midX, y: g.frame(in: .global).midY)
                            }
                        }
                    )
                    who
                        .padding(.top, 10)
                    line
                        .padding(.top, 14)
                        .frame(minHeight: 84, alignment: .top)
                    Spacer(minLength: 0)
                    bottom
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 8)

                if let card = engine.card {
                    AnswerBanner(
                        card: card, palette: Palette.of(card.agent, dark: scheme == .dark),
                        speaking: engine.phase == .speaking, since: engine.since,
                        onClose: { withAnimation(Motion.ease(0.5)) { engine.dismissCard() } },
                        onReplay: { engine.replay() }
                    )
                    .id(card.id)
                    .padding(.horizontal, 10)
                    .padding(.top, 4)
                    .transition(.asymmetric(insertion: .identity, removal: .move(edge: .top).combined(with: .opacity)))
                    .zIndex(2)
                }
            }
            .animation(Motion.ease(0.6), value: engine.card)
        }
        .foregroundStyle(palette.ink)
        .animation(Motion.ease(0.9), value: engine.agent)
        .onChange(of: engine.agent) { old, _ in
            // The new colour opens as a circle from her face.
            under = old
            reveal = 0
            withAnimation(Motion.ease(0.9)) { reveal = 1 }
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
            HanceLogo(height: 22, mark: palette.accent, word: palette.ink)
                .knightHop(trigger: engine.agent, step: 6)
            Spacer()
            HStack(spacing: 7) {
                Circle()
                    .fill(engine.phase.isBusy ? palette.accent : palette.muted)
                    .frame(width: 7, height: 7)
                    .phaseAnimator([1.0, 0.3]) { dot, x in
                        dot.opacity(engine.phase.isBusy ? x : 1)
                    } animation: { _ in .easeInOut(duration: 0.7) }
                Text("\(engine.agent.name) · \(engine.phase.label)")
                    .monoLabel(11)
                    .foregroundStyle(palette.muted)
                    .contentTransition(.interpolate)
                if engine.phase == .thinking {
                    Text(engine.since, style: .timer)
                        .font(HanceFont.mono(11))
                        .monospacedDigit()
                        .foregroundStyle(palette.accentInk)
                }
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
                .font(HanceFont.text(44, .semibold))
                .tracking(-1.54)
                .id(engine.agent)
                .transition(.push(from: .bottom).combined(with: .opacity))
            Text(engine.agent.role)
                .monoLabel(11)
                .foregroundStyle(palette.muted)
                .id("role-\(engine.agent.rawValue)")
                .transition(.opacity)
        }
    }

    /// One line under her name: what she heard while she thinks, or what went wrong.
    @ViewBuilder private var line: some View {
        Group {
            if let note = engine.note {
                Text(note)
                    .foregroundStyle(palette.accentInk)
            } else if engine.phase == .sending || engine.phase == .thinking, let heard = engine.heard {
                Text("«\(heard)»")
                    .foregroundStyle(palette.ink)
            } else {
                Text(" ")
            }
        }
        .font(HanceFont.text(19))
        .lineLimit(3)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 8)
        .transition(.opacity)
        .animation(Motion.ease(0.4), value: engine.note)
        .animation(Motion.ease(0.4), value: engine.phase)
    }

    private var hint: String {
        switch engine.phase {
        case .listening: return "Говори, я слушаю. Пауза закончит запись"
        case .sending: return "Распознаю голос"
        case .thinking: return "\(engine.agent.name) думает"
        case .speaking: return "Нажми, чтобы остановить"
        default: return "Нажми и говори · «позови \(engine.agent.other.accusative)»"
        }
    }

    private var bottom: some View {
        VStack(spacing: 16) {
            Text(hint)
                .font(HanceFont.text(15))
                .foregroundStyle(palette.muted)
                .multilineTextAlignment(.center)
                .contentTransition(.opacity)
                .animation(Motion.ease(0.3), value: engine.phase)
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
                CallOther(agent: engine.agent.other, palette: palette) {
                    engine.call(engine.agent.other)
                }
                .disabled(engine.phase == .listening || engine.phase == .sending || engine.phase == .thinking)
            }
            .foregroundStyle(palette.muted)
        }
    }
}

/// Her face gives a little under the finger.
struct FacePress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.95 : 1)
            .animation(Motion.spring(0.35), value: configuration.isPressed)
    }
}

/// The pill «Позвать Сару» with her small picture: a tap calls her.
struct CallOther: View {
    let agent: HanceAgent
    let palette: Palette
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Text("Позвать \(agent.accusative)")
                    .monoLabel(10)
                    .foregroundStyle(palette.ink)
                Image(agent.photo)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 40, height: 40)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(palette.paper, lineWidth: 2))
                    .id(agent)
                    .transition(.modifier(active: Flip(angle: -80, opacity: 0), identity: Flip(angle: 0, opacity: 1)))
            }
            .padding(.leading, 16)
            .padding(.trailing, 4)
            .padding(.vertical, 4)
            .background(Capsule().fill(palette.paper.opacity(0.85)))
            .overlay(Capsule().stroke(palette.line, lineWidth: 0.5))
        }
        .accessibilityLabel("Позвать \(agent.accusative)")
    }
}

/// The page's colour: the one before, and the new one opening as a circle from her face; over it a soft glow of her
/// colour (9%) round the face.
struct Backdrop: View {
    let under: Palette
    let over: Palette
    let reveal: CGFloat
    let center: CGPoint

    var body: some View {
        GeometryReader { g in
            let frame = g.frame(in: .global)
            let local = CGPoint(x: center.x - frame.minX, y: center.y - frame.minY)
            let far = hypot(max(local.x, g.size.width - local.x), max(local.y, g.size.height - local.y)) + 40
            let glowAt = UnitPoint(x: local.x / max(1, g.size.width), y: local.y / max(1, g.size.height))
            ZStack {
                layer(under, g.size, glowAt)
                layer(over, g.size, glowAt)
                    .mask(
                        Circle()
                            .frame(width: far * 2 * reveal, height: far * 2 * reveal)
                            .position(local)
                    )
            }
        }
        .ignoresSafeArea()
    }

    private func layer(_ p: Palette, _ size: CGSize, _ at: UnitPoint) -> some View {
        ZStack {
            p.bg
            RadialGradient(
                colors: [p.accent.opacity(0.09), p.accent.opacity(0)], center: at, startRadius: 0,
                endRadius: max(size.width, size.height) * 0.6)
        }
    }
}
