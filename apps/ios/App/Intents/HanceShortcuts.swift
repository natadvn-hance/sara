import AppIntents

/// What iOS offers without setting anything up: the side button (Settings, Action Button, Shortcut, Hance), Siri,
/// Spotlight and the Shortcuts app.
struct HanceShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: TalkIntent(),
            phrases: [
                "Поговорить с \(.applicationName)",
                "\(.applicationName), слушай",
                "Позови \(\.$agent) в \(.applicationName)",
            ],
            shortTitle: "Говорить",
            systemImageName: "waveform"
        )
        AppShortcut(
            intent: OpenTalkIntent(),
            phrases: ["Открой \(.applicationName) и слушай"],
            shortTitle: "Открыть и говорить",
            systemImageName: "mic.fill"
        )
    }

    static var shortcutTileColor: ShortcutTileColor = .orange
}
