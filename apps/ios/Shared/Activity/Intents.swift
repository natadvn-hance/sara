import AppIntents
import Foundation

/// The intents live in the app and in the widget extension: the Control Center button and the island's stop button
/// name them, and iOS runs them in the app's process. Only the app's copy does the work (`HANCE_APP`).

enum AgentChoice: String, AppEnum {
    case lora
    case sara

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Кто отвечает"
    static var caseDisplayRepresentations: [AgentChoice: DisplayRepresentation] = [
        .lora: "Лора",
        .sara: "Сара",
    ]

    var agent: HanceAgent { self == .lora ? .lora : .sara }
}

/// The side button (Action Button), Siri and the Control Center: Hance listens at once, without opening the app.
/// It records in the background with the Live Activity in the Dynamic Island, sends, waits and says her answer aloud.
/// `LiveActivityIntent` lets it start the island from the background; without the island iOS stops the app.
struct TalkIntent: AudioRecordingIntent, LiveActivityIntent {
    static var title: LocalizedStringResource = "Поговорить с Hance"
    static var description = IntentDescription("Hance сразу слушает: скажи, и Лора ответит голосом.")
    static var openAppWhenRun: Bool = false
    /// iOS 26 asks for the modes instead: in the background, and the app on screen only when he must sign in first.
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { [.background, .foreground(.dynamic)] }

    @Parameter(title: "Кто отвечает", default: .lora)
    var agent: AgentChoice

    init() {}

    init(agent: AgentChoice) {
        self.agent = agent
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if HANCE_APP
            guard TalkEngine.shared.signedIn else {
                if #available(iOS 26.0, *) {
                    throw needsToContinueInForegroundError(IntentDialog(SignInFirst().localizedStringResource))
                }
                throw SignInFirst()
            }
            do {
                try await TalkEngine.shared.startFromIntent(agent.agent)
            } catch {
                // iOS gave no island, or would not start the microphone in the background: no error on the Lock
                // Screen, the app comes up and listens on screen.
                guard #available(iOS 26.0, *) else { throw error }
                try await continueInForeground(nil, alwaysConfirm: false)
                TalkEngine.shared.openAndListen(agent.agent)
            }
        #endif
        return .result()
    }
}

/// Hance is not signed in yet: the password is typed in the app, never through Siri.
struct SignInFirst: Error, CustomLocalizedStringResourceConvertible {
    var localizedStringResource: LocalizedStringResource { "Сначала открой Hance и войди паролем пульта." }
}

/// iOS did not start the Live Activity (the island), and a recording in the background without one is stopped.
struct NoIsland: Error, CustomLocalizedStringResourceConvertible {
    var localizedStringResource: LocalizedStringResource { "Открой Hance: iOS не дал показать разговор в Dynamic Island." }
}

/// The same talk with the app on screen: for Siri «Открой Hance» and for a tap on the island.
struct OpenTalkIntent: AppIntent {
    static var title: LocalizedStringResource = "Открыть Hance и говорить"
    static var description = IntentDescription("Открывает Hance, и Лора сразу слушает.")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Кто отвечает", default: .lora)
    var agent: AgentChoice

    init() {}

    init(agent: AgentChoice) {
        self.agent = agent
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        #if HANCE_APP
            TalkEngine.shared.openAndListen(agent.agent)
        #endif
        return .result()
    }
}

/// The stop button in the Dynamic Island and on the Lock Screen: no more listening, no more voice.
struct StopTalkIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Остановить разговор"
    static var isDiscoverable: Bool = false

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult {
        #if HANCE_APP
            TalkEngine.shared.stop()
        #endif
        return .result()
    }
}
