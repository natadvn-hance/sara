import ActivityKit
import SwiftUI
import WidgetKit

/// The talk in the Dynamic Island and on the Lock Screen: her face, whether she listens, thinks or speaks, the bars of
/// the voice, the thinking time counting by itself, her first words and a stop button.
struct TalkLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TalkActivityAttributes.self) { context in
            LockScreenTalk(state: context.state)
                .widgetURL(URL(string: "hance://talk"))
        } dynamicIsland: { context in
            let s = context.state
            let p = Palette.of(s.agent, dark: true)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    IslandFace(agent: s.agent, phase: s.phase, since: s.since, size: 50, accent: p.accent)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(s.agent.name)
                            .font(HanceFont.text(19, .semibold))
                            .foregroundStyle(.white)
                        Text(s.phase.label)
                            .monoLabel(10)
                            .foregroundStyle(p.accentInk)
                            .contentTransition(.interpolate)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 6)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    StopButton(accent: p.accent)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        PhaseStrip(state: s, palette: p, height: 26)
                        if let line = s.line {
                            Text(line)
                                .font(HanceFont.text(14))
                                .foregroundStyle(.white.opacity(0.78))
                                .lineLimit(2)
                                .transition(.opacity)
                        }
                    }
                    .padding(.horizontal, 6)
                    .padding(.top, 2)
                }
            } compactLeading: {
                IslandFace(agent: s.agent, phase: s.phase, since: s.since, size: 22, accent: p.accent)
            } compactTrailing: {
                CompactPhase(state: s, palette: p)
            } minimal: {
                IslandFace(agent: s.agent, phase: s.phase, since: s.since, size: 22, accent: p.accent)
            }
            .keylineTint(p.accent)
            .widgetURL(URL(string: "hance://talk"))
        }
    }
}

/// Her face with a ring of her colour; while she thinks the ring fills by itself with the seconds.
struct IslandFace: View {
    let agent: HanceAgent
    let phase: TalkPhase
    let since: Date
    let size: CGFloat
    let accent: Color

    var body: some View {
        ZStack {
            Image(agent.photo)
                .resizable()
                .scaledToFill()
                .frame(width: size - 5, height: size - 5)
                .clipShape(Circle())
                .id(agent)
                .transition(.scale(scale: 0.4).combined(with: .opacity))
            if phase == .thinking {
                ProgressView(timerInterval: since...since.addingTimeInterval(20), countsDown: false) {
                    EmptyView()
                } currentValueLabel: {
                    EmptyView()
                }
                .progressViewStyle(.circular)
                .tint(accent)
                .frame(width: size, height: size)
            } else {
                Circle()
                    .stroke(accent.opacity(phase == .idle || phase == .done ? 0.45 : 1), lineWidth: size > 30 ? 2.5 : 1.8)
                    .frame(width: size, height: size)
            }
        }
        .frame(width: size, height: size)
        .animation(.spring(response: 0.5, dampingFraction: 0.7), value: agent)
    }
}

/// The right side of the compact island: the bars while someone speaks, the seconds while she thinks.
struct CompactPhase: View {
    let state: TalkActivityAttributes.ContentState
    let palette: Palette

    var body: some View {
        Group {
            switch state.phase {
            case .listening, .speaking:
                Bars(values: Array(state.bars.suffix(5)), color: palette.accent, height: 16, width: 3)
            case .thinking:
                Text(timerInterval: state.since...Date.distantFuture, countsDown: false)
                    .font(HanceFont.mono(12))
                    .monospacedDigit()
                    .foregroundStyle(palette.accent)
                    .frame(width: 38, alignment: .trailing)
            case .sending:
                Image(systemName: "arrow.up.circle.fill")
                    .foregroundStyle(palette.accent)
            case .done:
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(palette.accent)
            case .failed:
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundStyle(palette.accentInk)
            case .idle:
                KnightMark().fill(palette.accent).frame(width: 14, height: 14)
            }
        }
        .contentTransition(.opacity)
        .animation(.spring(response: 0.35, dampingFraction: 0.7), value: state.phase)
    }
}

/// The wide strip of the expanded island and the Lock Screen: what the phase looks like.
struct PhaseStrip: View {
    let state: TalkActivityAttributes.ContentState
    let palette: Palette
    let height: CGFloat

    var body: some View {
        HStack(spacing: 10) {
            switch state.phase {
            case .listening, .speaking:
                // The name above already says who listens or speaks; here, how long.
                Bars(values: state.bars, color: palette.accent, height: height, width: 5)
                Spacer(minLength: 0)
                Text(timerInterval: state.since...Date.distantFuture, countsDown: false)
                    .font(HanceFont.mono(12))
                    .monospacedDigit()
                    .multilineTextAlignment(.trailing)
                    .foregroundStyle(palette.accent)
                    .frame(width: 46, alignment: .trailing)
            case .thinking:
                ProgressView(timerInterval: state.since...state.since.addingTimeInterval(60), countsDown: false) {
                    EmptyView()
                } currentValueLabel: {
                    EmptyView()
                }
                .tint(palette.accent)
                Text(timerInterval: state.since...Date.distantFuture, countsDown: false)
                    .font(HanceFont.mono(13))
                    .monospacedDigit()
                    .foregroundStyle(palette.accent)
                    .frame(width: 46, alignment: .trailing)
            case .sending:
                Bars(values: Array(repeating: 0.35, count: 7), color: palette.accent.opacity(0.6), height: height, width: 5)
                Spacer(minLength: 0)
            default:
                KnightMark().fill(palette.accent).frame(width: height * 0.7, height: height * 0.7)
                Spacer(minLength: 0)
            }
        }
        .frame(height: height)
        .animation(.spring(response: 0.4, dampingFraction: 0.75), value: state.phase)
    }
}

/// The voice as bars: each update of the island moves them with a spring.
struct Bars: View {
    let values: [Double]
    let color: Color
    let height: CGFloat
    let width: CGFloat

    var body: some View {
        HStack(alignment: .center, spacing: width * 0.7) {
            ForEach(Array(values.enumerated()), id: \.offset) { _, v in
                Capsule()
                    .fill(color)
                    .frame(width: width, height: max(width, height * v))
            }
        }
        .frame(height: height)
        .animation(.spring(response: 0.32, dampingFraction: 0.55), value: values)
    }
}

struct StopButton: View {
    let accent: Color

    var body: some View {
        Button(intent: StopTalkIntent()) {
            Image(systemName: "stop.fill")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(Circle().fill(accent))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Остановить")
    }
}

/// The Lock Screen: the same talk on her paper.
struct LockScreenTalk: View {
    let state: TalkActivityAttributes.ContentState
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let p = Palette.of(state.agent, dark: scheme == .dark)
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                IslandFace(agent: state.agent, phase: state.phase, since: state.since, size: 46, accent: p.accent)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(state.agent.name)
                            .font(HanceFont.text(18, .semibold))
                            .foregroundStyle(p.ink)
                        Text(state.phase.label)
                            .monoLabel(10)
                            .foregroundStyle(p.accentInk)
                    }
                    Text(state.line ?? state.agent.role)
                        .font(HanceFont.text(14))
                        .foregroundStyle(p.muted)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                if state.phase.isBusy {
                    StopButton(accent: p.accent)
                } else {
                    KnightMark().fill(p.accent).frame(width: 22, height: 22)
                }
            }
            if state.phase.isBusy {
                PhaseStrip(state: state, palette: p, height: 22)
            }
        }
        .padding(16)
        .activityBackgroundTint(p.bg.opacity(0.92))
        .activitySystemActionForegroundColor(p.accent)
    }
}
