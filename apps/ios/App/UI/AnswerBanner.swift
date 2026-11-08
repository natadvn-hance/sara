import SwiftUI

/// Her answer as a plate that grows out of the Dynamic Island, springs open, and lights up word by word while she says
/// it. A swipe up or the cross puts it away; the play button says it again.
struct AnswerBanner: View {
    let card: AnswerCard
    let palette: Palette
    let speaking: Bool
    let since: Date
    let onClose: () -> Void
    let onReplay: () -> Void
    @State private var open = false
    @State private var drag: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(card.agent.photo)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 34, height: 34)
                    .clipShape(Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text(card.agent.name)
                        .font(HanceFont.text(16, .semibold))
                        .foregroundStyle(palette.ink)
                    Text(speaking ? "говорит" : card.at.formatted(date: .omitted, time: .shortened))
                        .monoLabel(10)
                        .foregroundStyle(speaking ? palette.accent : palette.muted)
                }
                Spacer()
                if !speaking {
                    Button(action: onReplay) {
                        Image(systemName: "play.fill")
                            .font(.system(size: 13, weight: .bold))
                            .frame(width: 34, height: 34)
                            .background(Circle().fill(palette.accentSoft))
                            .foregroundStyle(palette.accentInk)
                    }
                    .accessibilityLabel("Послушать ещё раз")
                }
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .bold))
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(palette.bg))
                        .foregroundStyle(palette.muted)
                }
                .accessibilityLabel("Убрать")
            }
            ScrollView {
                SpokenText(text: card.text, speaking: speaking, since: since, palette: palette)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: 260)
            .fixedSize(horizontal: false, vertical: true)
            if card.cards > 0 {
                Label("Кнопки пришли в Telegram и во Входящие пульта", systemImage: "rectangle.on.rectangle")
                    .font(HanceFont.text(13, .medium))
                    .foregroundStyle(palette.accentInk)
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .fill(palette.paper)
                .shadow(color: .black.opacity(0.14), radius: 24, y: 10)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .stroke(palette.accent.opacity(open ? 0.18 : 0.6), lineWidth: open ? 0.75 : 2)
        )
        .scaleEffect(x: open ? 1 : 0.34, y: open ? 1 : 0.1, anchor: .top)
        .opacity(open ? 1 : 0)
        .blur(radius: open ? 0 : 10)
        .offset(y: min(0, drag))
        .gesture(
            DragGesture()
                .onChanged { drag = $0.translation.height }
                .onEnded { v in
                    if v.translation.height < -40 { onClose() }
                    withAnimation(.spring(response: 0.35)) { drag = 0 }
                }
        )
        .onAppear {
            withAnimation(.spring(response: 0.55, dampingFraction: 0.74)) { open = true }
        }
    }
}

/// Her words: those already said in ink, the rest pale, as her voice goes (about fourteen letters a second).
struct SpokenText: View {
    let text: String
    let speaking: Bool
    let since: Date
    let palette: Palette

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.05, paused: !speaking)) { tl in
            let n = speaking ? Int(max(0, tl.date.timeIntervalSince(since) - 0.3) * 14) : text.count
            Text(parts(n))
                .font(HanceFont.reading(18))
                .lineSpacing(4)
                .animation(.easeOut(duration: 0.15), value: n)
        }
    }

    private func parts(_ n: Int) -> AttributedString {
        let k = min(max(n, 0), text.count)
        // Up to the end of the word being said.
        var end = text.index(text.startIndex, offsetBy: k)
        while end < text.endIndex && !text[end].isWhitespace { end = text.index(after: end) }
        var said = AttributedString(String(text[..<end]))
        said.foregroundColor = palette.ink
        var rest = AttributedString(String(text[end...]))
        rest.foregroundColor = palette.ink.opacity(0.3)
        return said + rest
    }
}
