import SwiftUI

// The middle of the talk in the language of the Hance proposal pages (hance.pro/ekaterina_kp, Boris 09.11): no blurred
// clouds and no glow. A photo card with a technical plate on it, a strip of square pixels under it that lives with the
// talk, corner marks while she works, and the other one coming in through a pixel wipe.

extension Motion {
    /// The wipe of the proposal pages, cubic-bezier(.76,0,.24,1): slow out, fast through, slow in.
    static func wipe(_ duration: Double) -> Animation { .timingCurve(0.76, 0, 0.24, 1, duration: duration) }
    /// Their reveal, cubic-bezier(.16,1,.3,1).
    static func reveal(_ duration: Double) -> Animation { .timingCurve(0.16, 1, 0.3, 1, duration: duration) }
}

/// A small integer hash in 0..<1: the same cell and frame give the same value, so the pixels flicker by steps, not by
/// chance every frame.
func pixelNoise(_ a: Int, _ b: Int, _ c: Int) -> Double {
    var h = UInt64(bitPattern: Int64(a &* 73_856_093 ^ b &* 19_349_663 ^ c &* 83_492_791))
    h ^= h >> 33
    h = h &* 0xff51_afd7_ed55_8ccd
    h ^= h >> 33
    return Double(h % 10_000) / 10_000
}

/// Her photo as a card, the button of the talk. While she listens, thinks or speaks, four corner marks frame her.
struct HeroCard: View {
    let agent: HanceAgent
    let phase: TalkPhase
    let palette: Palette
    let size: CGSize

    var body: some View {
        ZStack {
            palette.accent
            Image(agent.cardPhoto)
                .resizable()
                .scaledToFill()
                .frame(width: size.width, height: size.height, alignment: .top)
                .clipped()
            CornerMarks(arm: 16, inset: 14)
                .stroke(palette.paper, style: StrokeStyle(lineWidth: 2.5, lineCap: .square))
                .opacity(phase.isBusy ? 1 : 0)
                .scaleEffect(phase.isBusy ? 1 : 1.04)
                .animation(Motion.reveal(0.5), value: phase.isBusy)
        }
        .frame(width: size.width, height: size.height)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(palette.line, lineWidth: 0.5))
        .overlay(alignment: .bottomLeading) {
            Text(agent.name)
                .monoLabel(10)
                .foregroundStyle(palette.accentInk)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 4).fill(palette.paper))
                .padding(14)
        }
        .shadow(color: .black.opacity(0.07), radius: 16, y: 8)
        .accessibilityElement()
        .accessibilityLabel("\(agent.name), \(phase.label)")
    }
}

/// The plate of the proposal pages («ОПОР 1 / НАГРУЗКА 100 %»): who and what she does, one number of the moment and a
/// thin bar. Listening and speaking, the number and the bar are the loudness; thinking, the time and a stepping bar.
struct HUDPlate: View {
    let agent: HanceAgent
    let phase: TalkPhase
    let meter: LevelMeter
    let since: Date
    let palette: Palette

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !phase.isBusy)) { tl in
            let t = tl.date.timeIntervalSince(since)
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 6) {
                    Text(agent.name).foregroundStyle(palette.ink)
                    Spacer(minLength: 8)
                    Rectangle()
                        .fill(phase.isBusy ? palette.accent : palette.muted)
                        .frame(width: 5, height: 5)
                        .opacity(phase.isBusy && Int(t * 2.5) % 2 == 1 ? 0.25 : 1)
                    Text(phase.label).foregroundStyle(phase.isBusy ? palette.accentInk : palette.muted)
                }
                HStack {
                    Text(caption).foregroundStyle(palette.muted)
                    Spacer(minLength: 8)
                    Text(value(t)).foregroundStyle(palette.ink).monospacedDigit()
                }
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Rectangle().fill(palette.line)
                        Rectangle()
                            .fill(phase == .listening || phase == .speaking ? palette.accent : palette.ink)
                            .frame(width: g.size.width * fill(t))
                    }
                }
                .frame(height: 3)
            }
            .monoLabel(9.5)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 10)
        .frame(width: 168)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(palette.paper.opacity(0.94)))
        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(palette.line, lineWidth: 0.5))
    }

    private var caption: String {
        switch phase {
        case .listening: return "голос"
        case .sending: return "отправка"
        case .thinking: return "ответ через"
        case .speaking: return "громкость"
        case .failed: return "связь"
        default: return "канал"
        }
    }

    private func value(_ t: Double) -> String {
        switch phase {
        case .listening, .speaking: return "\(Int((min(1, meter.value * 1.25) * 100).rounded())) %"
        case .sending, .thinking:
            let s = max(0, Int(t))
            return String(format: "%02d:%02d", s / 60, s % 60)
        case .failed: return "нет"
        default: return "открыт"
        }
    }

    /// The bar: the loudness, or for thinking a fill in ten steps every 1,2 s.
    private func fill(_ t: Double) -> CGFloat {
        switch phase {
        case .listening, .speaking: return CGFloat(min(1, meter.value * 1.25))
        case .sending, .thinking: return CGFloat((Int(t / 0.12) % 10) + 1) / 10
        case .failed: return 0
        default: return 1
        }
    }
}

/// The strip of square pixels under her card. Empty cells stay as a faint grid. At rest a knight walks it by knight's
/// moves; listening, his voice runs through it as columns from the bottom; sending, a column scans across; thinking,
/// the pixels flicker in steps; speaking, her voice opens columns from the middle.
struct PixelBand: View {
    let phase: TalkPhase
    let meter: LevelMeter
    let palette: Palette
    @State private var tape = PixelTape()

    static let cell: CGFloat = 8
    static let gap: CGFloat = 3
    static let rows = 6
    static var height: CGFloat { CGFloat(rows) * (cell + gap) - gap }

    var body: some View {
        TimelineView(.animation) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            Canvas { ctx, size in
                let step = Self.cell + Self.gap
                let cols = max(1, Int((size.width + Self.gap) / step))
                let x0 = (size.width - (CGFloat(cols) * step - Self.gap)) / 2
                tape.feed(t, meter.value, cols: cols, on: phase == .listening || phase == .speaking)
                func cell(_ c: Int, _ r: Int, _ color: Color, _ opacity: Double = 1) {
                    let rect = CGRect(
                        x: x0 + CGFloat(c) * step, y: CGFloat(r) * step, width: Self.cell, height: Self.cell)
                    ctx.fill(Path(rect), with: .color(color.opacity(opacity)))
                }
                let rows = Self.rows
                for c in 0..<cols { for r in 0..<rows { cell(c, r, palette.line, 0.55) } }
                switch phase {
                case .listening:
                    for c in 0..<cols {
                        let h = Int((min(1, tape.cols[c] * 1.3) * Double(rows)).rounded(.up))
                        for k in 0..<h { cell(c, rows - 1 - k, palette.accent, k == h - 1 ? 0.55 : 1) }
                    }
                case .speaking:
                    let mid = Double(rows - 1) / 2
                    for c in 0..<cols {
                        let half = min(1, tape.cols[c] * 1.3) * Double(rows) / 2
                        for r in 0..<rows where abs(Double(r) - mid) < half + 0.01 {
                            cell(c, r, palette.accent, abs(Double(r) - mid) + 1 > half ? 0.5 : 1)
                        }
                    }
                case .sending:
                    let head = Int(t / 0.04) % (cols + 8)
                    for (k, o) in [1.0, 0.5, 0.22].enumerated() where head - k >= 0 && head - k < cols {
                        for r in 0..<rows { cell(head - k, r, palette.accent, o) }
                    }
                case .thinking:
                    let frame = Int(t / 0.11)
                    for c in 0..<cols {
                        for r in 0..<rows {
                            let n = pixelNoise(c, r, frame)
                            if n < 0.2 { cell(c, r, n < 0.07 ? palette.ink : palette.accent, n < 0.12 ? 1 : 0.5) }
                        }
                    }
                default:
                    // The knight: two across, one up or down, every 0,8 s; its last two squares fade behind it.
                    let s = Int(t / 0.8)
                    for back in 0..<3 {
                        let k = s - back
                        let c = ((k * 2) % cols + cols) % cols
                        let r = rows - 2 - ((k % 2 + 2) % 2) * 2
                        let o = [1.0, 0.4, 0.15][back]
                        cell(c, r, palette.accent, o)
                        cell(c, r + 1, palette.accent, o)
                        cell((c + 1) % cols, r, palette.accent, o)
                    }
                }
            }
        }
        .frame(height: Self.height)
        .accessibilityHidden(true)
    }
}

/// The loudness as columns that run from right to left, one new column every 45 ms.
final class PixelTape {
    var cols: [Double] = []
    private var last: Double = 0

    func feed(_ t: Double, _ v: Double, cols n: Int, on: Bool) {
        if cols.count != n { cols = Array(repeating: 0, count: n) }
        guard t - last >= 0.045 else { return }
        last = t
        cols.removeFirst()
        cols.append(on ? v : 0)
    }
}

/// The page's change of colour on the proposal pages: square pixels fall over the screen from the top with a ragged
/// edge, then fall away the same way and leave the new page. `progress` 0 to 1 covers; with `out` it uncovers.
struct PixelWipe: Shape {
    var progress: Double
    var out: Bool
    var seed: Int

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let cell: CGFloat = 26
        let cols = Int((rect.width / cell).rounded(.up))
        let rows = Int((rect.height / cell).rounded(.up))
        var p = Path()
        guard progress > 0 || out else { return p }
        for r in 0..<rows {
            for c in 0..<cols {
                let edge = Double(r) / Double(max(1, rows)) * 0.6 + pixelNoise(c, r, seed) * 0.4
                let covered = out ? edge >= progress : edge < progress
                if covered {
                    p.addRect(CGRect(x: CGFloat(c) * cell, y: CGFloat(r) * cell, width: cell + 0.5, height: cell + 0.5))
                }
            }
        }
        return p
    }
}

/// A turn round the upright axis, for the small face in the call button.
struct Flip: ViewModifier {
    let angle: Double
    let opacity: Double

    func body(content: Content) -> some View {
        content
            .rotation3DEffect(.degrees(angle), axis: (x: 0, y: 1, z: 0), perspective: 0.6)
            .opacity(opacity)
    }
}
