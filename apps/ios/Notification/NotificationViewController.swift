import SwiftUI
import UIKit
import UserNotifications
import UserNotificationsUI

/// Her answer, pressed long in the notification: Hance's own view instead of the plain system text. The system banner
/// itself cannot be animated by an app; this view, opened from it, can.
final class NotificationViewController: UIViewController, UNNotificationContentExtension {
    private var host: UIHostingController<ReplyCard>?

    func didReceive(_ notification: UNNotification) {
        let content = notification.request.content
        let info = content.userInfo
        let card = ReplyCard(
            agent: HanceAgent(rawValue: info["agent"] as? String ?? "") ?? .lora,
            text: info["text"] as? String ?? content.body,
            cards: info["cards"] as? Int ?? 0)
        if let host {
            host.rootView = card
            return
        }
        let h = UIHostingController(rootView: card)
        h.sizingOptions = .preferredContentSize
        h.view.backgroundColor = .clear
        addChild(h)
        view.addSubview(h.view)
        h.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            h.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            h.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            h.view.topAnchor.constraint(equalTo: view.topAnchor),
            h.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        h.didMove(toParent: self)
        host = h
    }

    override func preferredContentSizeDidChange(forChildContentContainer container: UIContentContainer) {
        super.preferredContentSizeDidChange(forChildContentContainer: container)
        preferredContentSize = CGSize(width: view.bounds.width, height: container.preferredContentSize.height)
    }
}

/// Her face springs in with a knight's move, a drop of her colour breathes behind it, and her words come up one by one.
struct ReplyCard: View {
    let agent: HanceAgent
    let text: String
    let cards: Int
    @Environment(\.colorScheme) private var scheme
    @State private var shown = Date.distantFuture
    @State private var arrived = false

    var body: some View {
        let p = Palette.of(agent, dark: scheme == .dark)
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 14) {
                ZStack {
                    TimelineView(.animation) { tl in
                        let t = tl.date.timeIntervalSinceReferenceDate
                        Circle()
                            .fill(
                                RadialGradient(
                                    colors: [p.accent.opacity(0.55), p.accent.opacity(0)], center: .center, startRadius: 8,
                                    endRadius: 44)
                            )
                            .scaleEffect(1 + 0.12 * sin(t * 2.2))
                    }
                    .frame(width: 84, height: 84)
                    Image(agent.photo)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 54, height: 54)
                        .clipShape(Circle())
                        .overlay(Circle().stroke(p.paper, lineWidth: 2.5))
                        .scaleEffect(arrived ? 1 : 0.3)
                        .knightHop(trigger: arrived, step: 6)
                }
                .frame(width: 70, height: 70)
                VStack(alignment: .leading, spacing: 3) {
                    Text(agent.name)
                        .font(HanceFont.text(22, .semibold))
                        .foregroundStyle(p.ink)
                    Text(agent.role)
                        .monoLabel(10)
                        .foregroundStyle(p.muted)
                }
                Spacer()
                KnightMark()
                    .fill(p.accent)
                    .frame(width: 20, height: 20)
                    .rotationEffect(.degrees(arrived ? 0 : -90))
                    .opacity(arrived ? 1 : 0)
            }
            TimelineView(.animation(minimumInterval: 0.04)) { tl in
                let words = text.split(separator: " ", omittingEmptySubsequences: false)
                let n = Int(max(0, tl.date.timeIntervalSince(shown)) * 18)
                Text(attributed(words: words, upTo: n, palette: p))
                    .font(HanceFont.reading(17))
                    .lineSpacing(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if cards > 0 {
                Text("Кнопки пришли в Telegram и во Входящие пульта")
                    .font(HanceFont.text(13, .medium))
                    .foregroundStyle(p.accentInk)
            }
        }
        .padding(18)
        .background(
            LinearGradient(colors: [p.accentSoft, p.bg], startPoint: .topLeading, endPoint: .bottomTrailing)
        )
        .onAppear {
            shown = Date().addingTimeInterval(0.35)
            withAnimation(.spring(response: 0.6, dampingFraction: 0.62)) { arrived = true }
        }
    }

    /// The words up to the n-th in ink, the next one fading in, the rest not yet there.
    private func attributed(words: [Substring], upTo n: Int, palette p: Palette) -> AttributedString {
        var out = AttributedString()
        for (i, w) in words.enumerated() {
            var piece = AttributedString(String(w) + (i + 1 < words.count ? " " : ""))
            piece.foregroundColor = i < n ? p.ink : (i == n ? p.ink.opacity(0.35) : p.ink.opacity(0))
            out += piece
        }
        return out
    }
}
