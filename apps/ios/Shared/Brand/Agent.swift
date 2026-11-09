import Foundation

/// Who answers in Hance (ADR-028): Lora by default, Sara on call. The names, greetings and roles are the core's and
/// the PWA's (apps/core/src/talk/agents.ts, apps/web/src/talk/engine.ts).
enum HanceAgent: String, Codable, CaseIterable, Hashable, Sendable {
    case lora
    case sara

    var name: String { self == .lora ? "Лора" : "Сара" }
    /// «Позови Сару».
    var accusative: String { self == .lora ? "Лору" : "Сару" }
    /// «Написать Саре».
    var dative: String { self == .lora ? "Лоре" : "Саре" }
    var role: String { self == .lora ? "Личный ассистент" : "Продажи и заявки" }
    var other: HanceAgent { self == .lora ? .sara : .lora }
    /// Her picture in the asset catalogs of the app and the widgets.
    var photo: String { self == .lora ? "AgentLora" : "AgentSara" }
    /// Her square photo for the big card of the talk (the circle above is for small places).
    var cardPhoto: String { self == .lora ? "AgentLoraCard" : "AgentSaraCard" }
    /// What she says when she is called (agents.ts): the core answers a call with it.
    var greeting: String { self == .lora ? "Борь, я на связи." : "Да-да, Борь, я тут." }
}

/// Where a talk is: the screen, the Dynamic Island and the notification all show the same.
enum TalkPhase: String, Codable, Hashable, Sendable {
    case idle
    case listening
    case sending
    case thinking
    case speaking
    /// She answered; the Live Activity keeps the answer a little while.
    case done
    /// No answer: no network, a lost answer.
    case failed

    /// In her own words, as the PWA says it: на связи, слушаю, расслышала, думаю, говорю.
    var label: String {
        switch self {
        case .idle: return "на связи"
        case .listening: return "слушаю"
        case .sending: return "расслышала"
        case .thinking: return "думаю"
        case .speaking: return "говорю"
        case .done: return "ответила"
        case .failed: return "нет ответа"
        }
    }

    /// The talk goes on: the microphone, the network or her voice is busy.
    var isBusy: Bool {
        switch self {
        case .listening, .sending, .thinking, .speaking: return true
        case .idle, .done, .failed: return false
        }
    }
}
