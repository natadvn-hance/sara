import ActivityKit
import SwiftUI
import WidgetKit

/// The talk in the Dynamic Island and on the Lock Screen, in the language of the app (hance.pro/ekaterina_kp, Boris
/// 09.11): her square face, her index and name, the phase with a square dot, the voice as square pixels, the thinking
/// time counting by itself, her first words and a square stop button.
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
                    SquareFace(agent: s.agent, size: 54, radius: 14, busy: s.phase.isBusy)
                        .padding(.leading, 4)
                        .padding(.top, 2)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(s.agent.index).foregroundStyle(p.accentInk)
                            Text(s.agent.role).foregroundStyle(.white.opacity(0.5))
                        }
                        .monoLabel(8.5)
                        .lineLimit(1)
                        Text(s.agent.name)
                            .font(HanceFont.text(22, .semibold))
                            .tracking(-0.6)
                            .foregroundStyle(.white)
                        PhaseTag(phase: s.phase, palette: p, dark: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 8)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    StopButton(accent: p.accent)
                        .padding(.trailing, 4)
                        .padding(.top, 2)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 9) {
                        PhaseStrip(state: s, palette: p, empty: .white.opacity(0.13), height: 22)
                        if let line = s.line {
                            Text(line)
                                .font(HanceFont.text(14))
                                .foregroundStyle(.white.opacity(0.8))
                                .lineLimit(2)
                                .transition(.opacity)
                        }
                    }
                    .padding(.horizontal, 6)
                    .padding(.top, 6)
                }
            } compactLeading: {
                SquareFace(agent: s.agent, size: 22, radius: 6, stroke: s.phase.isBusy ? p.accent : nil)
            } compactTrailing: {
                CompactPhase(state: s, palette: p)
            } minimal: {
                SquareFace(agent: s.agent, size: 22, radius: 6, stroke: s.phase.isBusy ? p.accent : nil)
            }
            .keylineTint(p.accent)
            .widgetURL(URL(string: "hance://talk"))
        }
    }
}

/// The phase as on the app's plate: a square dot of her colour and the word in capitals.
struct PhaseTag: View {
    let phase: TalkPhase
    let palette: Palette
    let dark: Bool

    var body: some View {
        HStack(spacing: 6) {
            Rectangle()
                .fill(phase.isBusy ? palette.accent : (dark ? Color.white.opacity(0.45) : palette.muted))
                .frame(width: 5, height: 5)
            Text(phase.label)
                .monoLabel(9.5)
                .foregroundStyle(phase.isBusy ? palette.accentInk : (dark ? Color.white.opacity(0.55) : palette.muted))
                .contentTransition(.interpolate)
        }
    }
}

/// The right side of the compact island: square pixels while someone speaks, the seconds while she thinks.
struct CompactPhase: View {
    let state: TalkActivityAttributes.ContentState
    let palette: Palette

    var body: some View {
        Group {
            switch state.phase {
            case .listening, .speaking:
                PixelBars(
                    values: Array(state.bars.suffix(5)), rows: 4, cell: 3, gap: 1.2, color: palette.accent,
                    empty: .white.opacity(0.14), centered: state.phase == .speaking)
            case .thinking, .sending:
                Text(timerInterval: state.since...Date.distantFuture, countsDown: false)
                    .font(HanceFont.mono(11))
                    .monospacedDigit()
                    .foregroundStyle(palette.accentInk)
                    .frame(width: 36, alignment: .trailing)
            case .failed:
                Text("!")
                    .font(HanceFont.mono(13))
                    .foregroundStyle(palette.accentInk)
            case .idle, .done:
                PixelKnight(color: palette.accent, cell: 4, gap: 1)
            }
        }
        .contentTransition(.opacity)
        .animation(.spring(response: 0.35, dampingFraction: 0.8), value: state.phase)
    }
}

/// The wide strip of the expanded island and the Lock Screen: the voice as square pixels with the time; thinking, a
/// thin bar that fills by itself and the time; at rest, the knight.
struct PhaseStrip: View {
    let state: TalkActivityAttributes.ContentState
    let palette: Palette
    let empty: Color
    let height: CGFloat

    var body: some View {
        let rows = 4
        let cell = (height - CGFloat(rows - 1) * 2) / CGFloat(rows)
        HStack(spacing: 10) {
            switch state.phase {
            case .listening, .speaking:
                GeometryReader { g in
                    let n = max(4, Int((g.size.width + 2) / (cell + 2)))
                    PixelBars(
                        values: PixelBars.spread(state.bars, to: n), rows: rows, cell: cell, gap: 2,
                        color: palette.accent, empty: empty, centered: state.phase == .speaking)
                }
                .frame(height: height)
                timer
            case .thinking, .sending:
                VStack(alignment: .leading, spacing: 6) {
                    Text(state.phase == .thinking ? "ответ через" : "отправка")
                        .monoLabel(9)
                        .foregroundStyle(palette.accentInk)
                    ProgressView(timerInterval: state.since...state.since.addingTimeInterval(40), countsDown: false) {
                        EmptyView()
                    } currentValueLabel: {
                        EmptyView()
                    }
                    .progressViewStyle(.linear)
                    .tint(palette.accent)
                }
                timer
            default:
                PixelKnight(color: palette.accent, cell: 5, gap: 1.5)
                Spacer(minLength: 0)
            }
        }
        .frame(height: height + 4)
        .animation(.spring(response: 0.4, dampingFraction: 0.8), value: state.phase)
    }

    private var timer: some View {
        Text(timerInterval: state.since...Date.distantFuture, countsDown: false)
            .font(HanceFont.mono(12))
            .monospacedDigit()
            .multilineTextAlignment(.trailing)
            .foregroundStyle(palette.accentInk)
            .frame(width: 46, alignment: .trailing)
    }
}

/// A square stop button of her colour, as the keyboard button of the app.
struct StopButton: View {
    let accent: Color

    var body: some View {
        Button(intent: StopTalkIntent()) {
            Rectangle()
                .fill(.white)
                .frame(width: 12, height: 12)
                .frame(width: 42, height: 42)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(accent))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Остановить")
    }
}

/// The Lock Screen: the same talk as a page of Hance, on her paper.
struct LockScreenTalk: View {
    let state: TalkActivityAttributes.ContentState
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let p = Palette.of(state.agent, dark: scheme == .dark)
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                SquareFace(agent: state.agent, size: 58, radius: 14, busy: state.phase.isBusy)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(state.agent.index).foregroundStyle(p.accentInk)
                        Text(state.agent.role).foregroundStyle(p.muted)
                    }
                    .monoLabel(8.5)
                    .lineLimit(1)
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(state.agent.name)
                            .font(HanceFont.text(22, .semibold))
                            .tracking(-0.6)
                            .foregroundStyle(p.ink)
                        PhaseTag(phase: state.phase, palette: p, dark: false)
                    }
                    if let line = state.line {
                        Text(line)
                            .font(HanceFont.text(14))
                            .foregroundStyle(p.ink.opacity(0.75))
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                if state.phase.isBusy {
                    StopButton(accent: p.accent)
                } else {
                    PixelKnight(color: p.accent, cell: 5, gap: 1.5)
                        .padding(.top, 4)
                }
            }
            if state.phase.isBusy {
                Rectangle().fill(p.line).frame(height: 0.5)
                PhaseStrip(state: state, palette: p, empty: p.line, height: 18)
            }
        }
        .padding(16)
        .activityBackgroundTint(p.bg)
        .activitySystemActionForegroundColor(p.accent)
    }
}
