import SwiftUI
import UserNotifications

/// Hance on the iPhone (ADR-028): Boris talks to Lora (by default) and Sara by voice, from the side button, Siri, the
/// Control Center or the app, through the same core as the PWA at sara.hance.pro/talk.
@main
struct HanceApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var engine = TalkEngine.shared

    var body: some Scene {
        WindowGroup {
            Group {
                if engine.signedIn || Demo.on {
                    TalkScreen()
                } else {
                    LoginView()
                }
            }
            .environmentObject(engine)
            .animation(.easeInOut(duration: 0.35), value: engine.signedIn)
            .onOpenURL { url in open(url) }
        }
    }

    /// `hance://talk?agent=sara`: the island, a notification or a Shortcut asks to talk.
    private func open(_ url: URL) {
        guard url.scheme == "hance" else { return }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let agent = items.first { $0.name == "agent" }.flatMap { HanceAgent(rawValue: $0.value ?? "") }
        if url.host() == "talk", items.contains(where: { $0.name == "go" }) {
            engine.openAndListen(agent ?? engine.agent)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        Notifier.register()
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /// On screen the answer is the app's own plate; the system banner only when the app is away.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        await MainActor.run { TalkEngine.shared.onScreen } ? [] : [.banner, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let agent = HanceAgent(rawValue: info["agent"] as? String ?? "") ?? .lora
        await MainActor.run {
            let engine = TalkEngine.shared
            switch response.actionIdentifier {
            case Notifier.replyAction: engine.openAndListen(agent)
            case Notifier.listenAction: engine.replay()
            default: break
            }
        }
    }
}
