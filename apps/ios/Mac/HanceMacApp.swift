import AppKit
import SwiftUI

/// Hance on the Mac: an icon in the menu bar and ъ+ё (or ⌥Space) anywhere; Lora comes out under the menu bar, listens and
/// answers in her voice, as in the app on the iPhone (Boris, 12.11).
@main
struct HanceMacApp: App {
    @NSApplicationDelegateAdaptor(MacAppDelegate.self) private var delegate
    @StateObject private var talk = MacTalk.shared

    var body: some Scene {
        MenuBarExtra {
            MenuView(talk: talk)
        } label: {
            Image(nsImage: MacAppDelegate.menuIcon)
        }
        .menuBarExtraStyle(.window)
    }
}

final class MacAppDelegate: NSObject, NSApplicationDelegate {
    private var hotKey: HotKey?
    private var chord: ChordKey?
    private var panel: IslandPanel?

    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated {
            panel = IslandPanel(talk: .shared)
            // ъ+ё (] and \ together) is the main way (Boris, 12.11); ⌥Space stays as the spare one.
            chord = ChordKey { who in MacTalk.shared.press(as: who) }
            hotKey = HotKey { MacTalk.shared.press() }
        }
    }

    /// The knight of Hance for the menu bar, drawn as a template so the bar tints it.
    @MainActor static let menuIcon: NSImage = {
        let r = ImageRenderer(content: KnightMark().fill(Color.black).frame(width: 16, height: 16))
        r.scale = 2
        let image = r.nsImage ?? NSImage(systemSymbolName: "waveform", accessibilityDescription: "Hance")!
        image.isTemplate = true
        image.size = NSSize(width: 16, height: 16)
        return image
    }()
}

struct MenuView: View {
    @ObservedObject var talk: MacTalk
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        let p = Palette.of(talk.agent, dark: false)
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                HanceLogo(height: 18, mark: p.accent, word: .primary)
                Spacer()
                Text("ъ+ё · +1 Лора · +2 Сара").monoLabel(9).foregroundStyle(.secondary)
            }
            if talk.signedIn {
                Button {
                    talk.press()
                } label: {
                    Label("Говорить с \(talk.agent == .lora ? "Лорой" : "Сарой")", systemImage: "waveform")
                }
                Button {
                    talk.call(talk.agent.other)
                } label: {
                    Label("Позвать \(talk.agent.other.accusative)", systemImage: "person.wave.2")
                }
                .disabled(talk.phase.isBusy)
                Divider()
                Button("Выйти из пульта") { talk.signOut() }
            } else {
                Text("Войди паролем пульта, как в приложении на iPhone.")
                    .font(HanceFont.text(13))
                    .foregroundStyle(.secondary)
                SecureField("Пароль пульта", text: $password)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { login() }
                Button(busy ? "Вхожу…" : "Войти") { login() }
                    .disabled(password.isEmpty || busy)
                if let error {
                    Text(error).font(HanceFont.text(12)).foregroundStyle(p.accentInk)
                }
            }
            Divider()
            Button("Закрыть Hance") { NSApp.terminate(nil) }
        }
        .buttonStyle(.plain)
        .padding(14)
        .frame(width: 280)
    }

    private func login() {
        guard !password.isEmpty else { return }
        busy = true
        error = nil
        Task {
            do {
                try await talk.login(password: password)
                password = ""
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? "Не вышло войти."
            }
            busy = false
        }
    }
}
