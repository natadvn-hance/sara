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
            cards: info["cards"] as? Int ?? 0,
            at: notification.date)
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

/// Her answer as a page of Hance (hance.pro/ekaterina_kp, Boris 09.11): her square face comes in with a knight's move
/// and corner marks, her index, role and big name beside it, a hairline with the time, and her words lighting up one
/// by one from a faint grey, as the two-tone headlines of the pages.
struct ReplyCard: View {
    let agent: HanceAgent
    let text: String
    let cards: Int
    let at: Date
    @Environment(\.colorScheme) private var scheme
    @State private var shown = Date.distantFuture
    @State private var arrived = false

    var body: some View {
        let p = Palette.of(agent, dark: scheme == .dark)
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                SquareFace(agent: agent, size: 68, radius: 16, busy: arrived)
                    .scaleEffect(arrived ? 1 : 0.6)
                    .opacity(arrived ? 1 : 0)
                    .knightHop(trigger: arrived, step: 6)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(agent.index).foregroundStyle(p.accentInk)
                        Text(agent.role).foregroundStyle(p.muted)
                    }
                    .monoLabel(9.5)
                    Text(agent.name)
                        .font(HanceFont.text(34, .semibold))
                        .tracking(-1.3)
                        .foregroundStyle(p.ink)
                        .offset(y: arrived ? 0 : 12)
                        .opacity(arrived ? 1 : 0)
                }
                Spacer(minLength: 0)
                PixelKnight(color: p.accent, cell: 6, gap: 1.5)
                    .padding(.top, 4)
                    .opacity(arrived ? 1 : 0)
            }
            HStack {
                Text("ответ").foregroundStyle(p.muted)
                Spacer()
                Text(at, format: .dateTime.hour().minute()).foregroundStyle(p.ink)
            }
            .monoLabel(9.5)
            .overlay(alignment: .top) { Rectangle().fill(p.line).frame(height: 0.5).offset(y: -8) }
            .padding(.top, 4)
            TimelineView(.animation(minimumInterval: 0.04)) { tl in
                let words = text.split(separator: " ", omittingEmptySubsequences: false)
                let n = Int(max(0, tl.date.timeIntervalSince(shown)) * 18)
                Text(attributed(words: words, upTo: n, palette: p))
                    .font(HanceFont.reading(18))
                    .lineSpacing(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if cards > 0 {
                HStack(spacing: 6) {
                    Rectangle().fill(p.accent).frame(width: 5, height: 5)
                    Text("Кнопки в Telegram и во Входящих пульта")
                }
                .monoLabel(9.5)
                .foregroundStyle(p.accentInk)
            }
        }
        .padding(18)
        .background(p.bg)
        .onAppear {
            shown = Date().addingTimeInterval(0.35)
            withAnimation(.timingCurve(0.16, 1, 0.3, 1, duration: 0.7)) { arrived = true }
        }
    }

    /// The words up to the n-th in ink, the rest waiting in a faint grey, as the pages' two-tone headlines.
    private func attributed(words: [Substring], upTo n: Int, palette p: Palette) -> AttributedString {
        var out = AttributedString()
        for (i, w) in words.enumerated() {
            var piece = AttributedString(String(w) + (i + 1 < words.count ? " " : ""))
            piece.foregroundColor = i < n ? p.ink : p.ink.opacity(0.16)
            out += piece
        }
        return out
    }
}
