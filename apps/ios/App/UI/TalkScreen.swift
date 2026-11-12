import ActivityKit
import SwiftUI

/// The talk as a voice assistant (Boris, 08.11), in the language of the Hance proposal pages (hance.pro/ekaterina_kp,
/// Boris 09.11): the logo and the call of the other one on top; her photo card with its plate, the button of the talk,
/// and the strip of pixels under it; her index, role, big name and one line, set to the left like a page; the hint and
/// the keyboard below. Her answer comes as a plate that grows out of the Dynamic Island. The other one comes in through
/// a pixel wipe of her colour.
struct TalkScreen: View {
    @EnvironmentObject private var engine: TalkEngine
    @Environment(\.colorScheme) private var scheme
    /// Who the screen shows: changes in the middle of the wipe, when the pixels cover it all.
    @State private var shown: HanceAgent = .lora
    @State private var wipe: Double = 0
    @State private var wipeOut = false
    @State private var wipeColor: Color = .clear
    @State private var wipeSeed = 1
    @State private var typing = false
    /// The finger is on her photo.
    @State private var holding = false
    @State private var offTaps = 0
    @State private var showTimings = false

    private var agent: HanceAgent { Demo.agent ?? shown }
    private var phase: TalkPhase { Demo.phase ?? engine.phase }
    private var palette: Palette { .of(agent, dark: scheme == .dark) }

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width - 40
            let cardHeight = min(width * 1.1, geo.size.height * 0.5)
            ZStack(alignment: .top) {
                palette.bg.ignoresSafeArea()

                VStack(alignment: .leading, spacing: 0) {
                    topBar
                    Spacer(minLength: 10)
                    ZStack(alignment: .topTrailing) {
                        // Her photo is the button: a tap talks (or sends, or stops her voice); held, it switches
                        // her off at any moment, even while she thinks (Boris, 12.11).
                        HeroCard(
                            agent: agent, phase: phase, palette: palette,
                            size: CGSize(width: width, height: cardHeight), arming: engine.arming
                        )
                        .scaleEffect(holding ? 0.975 : 1)
                        .animation(Motion.spring(0.35), value: holding)
                        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .onTapGesture { engine.press() }
                        .onLongPressGesture(minimumDuration: 0.5) {
                            offTaps += 1
                            engine.turnOff()
                        } onPressingChanged: { holding = $0 }
                        .sensoryFeedback(.impact(weight: .medium), trigger: offTaps)
                        .accessibilityAddTraits(.isButton)
                        .accessibilityHint("Нажми, чтобы говорить. Удержи, чтобы выключить")
                        .accessibilityAction(named: "Выключить") { engine.turnOff() }
                        HUDPlate(agent: agent, phase: phase, meter: engine.meter, since: engine.since, palette: palette)
                            .padding(12)
                            .onLongPressGesture { showTimings = true }
                            .accessibilityAddTraits(.isButton)
                            .accessibilityHint("Долгое нажатие: замеры скорости")
                    }
                    PixelBand(phase: phase, meter: engine.meter, palette: palette)
                        .frame(width: width)
                        .padding(.top, 12)
                    who
                        .padding(.top, 20)
                    line
                        .padding(.top, 8)
                        .frame(minHeight: 56, alignment: .top)
                    Spacer(minLength: 6)
                    bottom
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 8)

                if let card = engine.card {
                    AnswerBanner(
                        card: card, palette: Palette.of(card.agent, dark: scheme == .dark),
                        speaking: phase == .speaking, since: engine.since,
                        onClose: { withAnimation(Motion.ease(0.5)) { engine.dismissCard() } },
                        onReplay: { engine.replay() }
                    )
                    .id(card.id)
                    .padding(.horizontal, 10)
                    .padding(.top, 4)
                    .transition(.asymmetric(insertion: .identity, removal: .move(edge: .top).combined(with: .opacity)))
                    .zIndex(2)
                }

                PixelWipe(progress: wipe, out: wipeOut, seed: wipeSeed)
                    .fill(wipeColor)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
                    .zIndex(3)
            }
            .animation(Motion.ease(0.6), value: engine.card)
        }
        .foregroundStyle(palette.ink)
        .onChange(of: engine.agent) { _, new in change(to: new) }
        .onAppear {
            shown = engine.agent
            Demo.start(engine.meter)
        }
        .sheet(isPresented: $typing) {
            TypeSheet(agent: agent, palette: palette) { text in
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
        // One tap of the finger the moment he presses; the knocks then say the microphone is on.
        .sensoryFeedback(.impact(weight: .light), trigger: engine.arming) { _, now in now }
        .sensoryFeedback(.selection, trigger: engine.agent)
    }

    /// Her colour falls over the page in pixels, the page changes under them, and they fall away.
    private func change(to new: HanceAgent) {
        wipeColor = Palette.of(new, dark: scheme == .dark).accent
        wipeSeed += 1
        wipeOut = false
        wipe = 0
        withAnimation(Motion.wipe(0.45)) {
            wipe = 1
        } completion: {
            shown = new
            wipeOut = true
            wipe = 0
            withAnimation(Motion.wipe(0.6)) { wipe = 1 }
        }
    }

    private var topBar: some View {
        HStack {
            HanceLogo(height: 22, mark: palette.accent, word: palette.ink)
                .knightHop(trigger: agent, step: 6)
            Spacer()
            CallOther(agent: agent.other, dark: scheme == .dark) {
                engine.call(agent.other)
            }
            .disabled(phase == .listening || phase == .sending || phase == .thinking)
        }
        .padding(.top, 8)
    }

    private var who: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text(agent == .lora ? "[01]" : "[02]")
                    .foregroundStyle(palette.accentInk)
                Text(agent.role)
                    .foregroundStyle(palette.muted)
            }
            .monoLabel(10)
            Text(agent.name)
                .font(HanceFont.text(56, .semibold))
                .tracking(-2.4)
                .id(agent)
                .transition(.push(from: .bottom).combined(with: .opacity))
        }
        .animation(Motion.reveal(0.7), value: agent)
    }

    /// One line under her name: what she heard while she thinks, or what went wrong.
    @ViewBuilder private var line: some View {
        Group {
            if let note = engine.note {
                Text(note)
                    .foregroundStyle(palette.accentInk)
            } else if phase == .sending || phase == .thinking, let heard = engine.heard {
                Text("«\(heard)»")
                    .foregroundStyle(palette.ink)
            } else {
                Text(" ")
            }
        }
        .font(HanceFont.text(19))
        .lineLimit(3)
        .multilineTextAlignment(.leading)
        .transition(.opacity)
        .animation(Motion.ease(0.4), value: engine.note)
        .animation(Motion.ease(0.4), value: phase)
    }

    private var hint: String {
        switch phase {
        case .listening: return "Говори. Пауза закончит запись · удержи фото, чтобы выключить"
        case .sending: return "Отправляю · удержи фото, чтобы выключить"
        case .thinking: return "\(agent.name) думает · удержи фото, чтобы выключить"
        case .speaking: return "Нажми на фото, чтобы остановить"
        default: return "Нажми на фото и говори"
        }
    }

    private var bottom: some View {
        HStack(alignment: .center, spacing: 12) {
            Text(hint)
                .monoLabel(10)
                .foregroundStyle(palette.muted)
                .lineLimit(2)
                .contentTransition(.opacity)
                .animation(Motion.ease(0.3), value: phase)
            Spacer()
            Button {
                typing = true
            } label: {
                Image(systemName: "keyboard")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(palette.ink)
                    .frame(width: 52, height: 52)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(palette.paper))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(palette.line, lineWidth: 0.5))
            }
            .accessibilityLabel("Написать \(agent.dative)")
            .disabled(phase.isBusy)
        }
    }
}

/// Her card gives a little under the finger.
struct CardPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.975 : 1)
            .animation(Motion.spring(0.35), value: configuration.isPressed)
    }
}

/// «Позвать Сару →» in her colour, like «Созвон →» of the proposal pages, with her small face: a tap calls her.
struct CallOther: View {
    let agent: HanceAgent
    let dark: Bool
    let action: () -> Void

    var body: some View {
        let p = Palette.of(agent, dark: dark)
        Button(action: action) {
            HStack(spacing: 8) {
                Image(agent.photo)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 26, height: 26)
                    .clipShape(Circle())
                    .id(agent)
                    .transition(.modifier(active: Flip(angle: -80, opacity: 0), identity: Flip(angle: 0, opacity: 1)))
                Text("Позвать \(agent.accusative)  →")
                    .font(HanceFont.text(15, .semibold))
            }
            .foregroundStyle(.white)
            .padding(.leading, 5)
            .padding(.trailing, 14)
            .padding(.vertical, 5)
            .background(Capsule().fill(p.accent))
        }
        .animation(Motion.reveal(0.6), value: agent)
        .accessibilityLabel("Позвать \(agent.accusative)")
    }
}

/// A look at the screen without the core, in debug builds: HANCE_DEMO=listening|sending|thinking|speaking|idle and
/// HANCE_DEMO_AGENT=sara show that phase with a made-up voice, for screenshots of the design.
@MainActor
enum Demo {
    static let phase: TalkPhase? = {
        #if DEBUG
            return ProcessInfo.processInfo.environment["HANCE_DEMO"].flatMap(TalkPhase.init(rawValue:))
        #else
            return nil
        #endif
    }()
    static let agent: HanceAgent? = {
        #if DEBUG
            return ProcessInfo.processInfo.environment["HANCE_DEMO_AGENT"].flatMap(HanceAgent.init(rawValue:))
        #else
            return nil
        #endif
    }()
    static var on: Bool { phase != nil }

    static func start(_ meter: LevelMeter) {
        guard on else { return }
        #if DEBUG
            // HANCE_DEMO_ISLAND=1: the same phase in the Dynamic Island and on the Lock Screen, with moving bars.
            if ProcessInfo.processInfo.environment["HANCE_DEMO_ISLAND"] != nil, let phase {
                let who = agent ?? .lora
                let line: String? = phase == .speaking ? "Встреча с Алёной в 15:00, я напомню за полчаса." : nil
                let since = Date()
                let activity = try? Activity.request(
                    attributes: TalkActivityAttributes(startedAt: since),
                    content: .init(state: .quiet(who, phase, line: line), staleDate: nil), pushType: nil)
                Task { @MainActor in
                    while let activity {
                        let bars = (0..<7).map { _ in Double.random(in: 0.15...1) }
                        let s = TalkActivityAttributes.ContentState(
                            agent: who, phase: phase, since: since, line: line, bars: bars)
                        await activity.update(.init(state: s, staleDate: nil))
                        try? await Task.sleep(for: .milliseconds(500))
                    }
                }
            }
        #endif
        Task { @MainActor in
            var t = 0.0
            while true {
                t += 0.03
                let syllables = max(0, sin(t * 9) * 0.5 + sin(t * 3.1) * 0.35 + 0.2)
                meter.feed(min(1, syllables * (0.6 + 0.4 * sin(t * 0.7))))
                try? await Task.sleep(for: .milliseconds(30))
            }
        }
    }
}
