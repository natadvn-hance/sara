import ActivityKit
import Foundation
import UserNotifications
import os

let log = Logger(subsystem: "pro.hance.talk", category: "talk")

/// The loudness of whoever speaks now, smoothed: quick to rise, slow to fall. The orb reads it every frame.
@MainActor
final class LevelMeter {
    private(set) var value: Double = 0
    private var recent: [Double] = Array(repeating: 0, count: 28)

    func feed(_ v: Double) {
        let k = v > value ? 0.55 : 0.18
        value += (v - value) * k
        recent.append(value)
        if recent.count > 28 { recent.removeFirst(recent.count - 28) }
    }

    func reset() {
        value = 0
        recent = Array(repeating: 0, count: 28)
    }

    /// Seven bars for the Dynamic Island from the last half second or so.
    func bars() -> [Double] {
        stride(from: 0, to: 28, by: 4).map { i in
            let slice = recent[i..<min(i + 4, recent.count)]
            return max(0.12, min(1, (slice.max() ?? 0) * 1.25))
        }
    }
}

/// What she answered, on the screen as a plate that grows out of the island.
struct AnswerCard: Identifiable, Equatable {
    let id = UUID()
    let agent: HanceAgent
    let text: String
    /// Cards with buttons that went to Telegram and the pult's inbox.
    let cards: Int
    let at = Date()
}

/// The Live Activity of a talk: started with the first listening, updated on every phase and a few times a second while
/// someone speaks, ended with her answer left on the Lock Screen a little while.
@MainActor
final class TalkActivityController {
    private var activity: Activity<TalkActivityAttributes>?
    private var lastPush = Date.distantPast
    private var chain: Task<Void, Never>?

    var isOn: Bool { activity != nil }

    func start(_ state: TalkActivityAttributes.ContentState) {
        guard activity == nil, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        // Left from a run that iOS stopped by force: one talk, one island.
        let left = Activity<TalkActivityAttributes>.activities
        if !left.isEmpty {
            Task { for a in left { await a.end(nil, dismissalPolicy: .immediate) } }
        }
        do {
            activity = try Activity.request(
                attributes: TalkActivityAttributes(startedAt: Date()),
                content: .init(state: state, staleDate: Date().addingTimeInterval(600)),
                pushType: nil)
            lastPush = Date()
        } catch {
            log.error("live activity: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// A change of phase goes at once; the bars at most about twice a second.
    func update(_ state: TalkActivityAttributes.ContentState, force: Bool) {
        guard let a = activity else { return }
        let now = Date()
        if !force && now.timeIntervalSince(lastPush) < 0.45 { return }
        lastPush = now
        let before = chain
        chain = Task {
            await before?.value
            await a.update(.init(state: state, staleDate: now.addingTimeInterval(600)))
        }
    }

    func end(_ state: TalkActivityAttributes.ContentState?, linger: TimeInterval) {
        guard let a = activity else { return }
        activity = nil
        let before = chain
        chain = Task {
            await before?.value
            await a.end(
                state.map { .init(state: $0, staleDate: nil) },
                dismissalPolicy: linger > 0 ? .after(Date().addingTimeInterval(linger)) : .immediate)
        }
    }

    /// Left from a run that was stopped by force.
    static func endAll() async {
        for a in Activity<TalkActivityAttributes>.activities {
            await a.end(nil, dismissalPolicy: .immediate)
        }
    }
}

/// Her answer as a notification when the app is not on screen. Pressed long, it opens Hance's own animated view
/// (the Notification Content Extension); its buttons say it again or start a reply.
enum Notifier {
    static let category = "HANCE_REPLY"
    static let listenAction = "HANCE_LISTEN"
    static let replyAction = "HANCE_REPLY_VOICE"

    static func register() {
        let listen = UNNotificationAction(
            identifier: listenAction, title: "Послушать", options: [.foreground],
            icon: UNNotificationActionIcon(systemImageName: "play.fill"))
        let reply = UNNotificationAction(
            identifier: replyAction, title: "Ответить голосом", options: [.foreground],
            icon: UNNotificationActionIcon(systemImageName: "mic.fill"))
        let c = UNNotificationCategory(
            identifier: category, actions: [reply, listen], intentIdentifiers: [],
            options: [.hiddenPreviewsShowTitle])
        UNUserNotificationCenter.current().setNotificationCategories([c])
    }

    static func ask() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
    }

    static func post(agent: HanceAgent, text: String, cards: Int) {
        let c = UNMutableNotificationContent()
        c.title = agent.name
        c.subtitle = agent.role
        c.body = cards > 0 ? text + "\n\nКнопки в Telegram." : text
        c.sound = .default
        c.categoryIdentifier = category
        c.threadIdentifier = agent.rawValue
        c.interruptionLevel = .active
        c.userInfo = ["agent": agent.rawValue, "text": text, "cards": cards]
        let r = UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil)
        UNUserNotificationCenter.current().add(r)
    }
}

/// Where the time of one question goes, for Boris and for us: how long he spoke, the pause that told the app he had
/// finished, the rest of the upload with whisper, her thinking, her voice.
struct TurnTimings: Codable, Identifiable, Equatable {
    var id = UUID()
    var at = Date()
    var agent: HanceAgent
    var voice: Bool
    /// How long he spoke, seconds.
    var spoke: Double?
    /// The pause the app waited for to know he had finished, ms.
    var pause: Int?
    /// From the end of the recording to the core's answer to it: the rest of the upload and whisper, ms.
    var heard: Int?
    /// From there to her answer: Lora's or Sara's thinking, ms.
    var answer: Int?
    /// From her answer to her first sound: the voice made and fetched, ms.
    var voiceReady: Int?
    /// From the end of his words to her first sound, ms: what he waits in all.
    var total: Int?
    var phoneVoice = false

    static let key = "hance.timings"

    static func load() -> [TurnTimings] {
        guard let d = UserDefaults.standard.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([TurnTimings].self, from: d)) ?? []
    }

    static func save(_ all: [TurnTimings]) {
        if let d = try? JSONEncoder().encode(Array(all.prefix(30))) { UserDefaults.standard.set(d, forKey: key) }
    }

    var line: String {
        func s(_ ms: Int?) -> String { ms.map { String(format: "%.1f", Double($0) / 1000) } ?? "-" }
        return "speech \(spoke.map { String(format: "%.1f", $0) } ?? "-")s pause \(s(pause)) heard \(s(heard)) "
            + "answer \(s(answer)) voice \(s(voiceReady)) total \(s(total))\(phoneVoice ? " phone-voice" : "")"
    }
}

/// The moments of one question as they happen.
struct TurnClock {
    var started = Date()
    var lastLoud: Date?
    var stopped: Date?
    var heard: Date?
    var answered: Date?
    var sounded: Date?
    var phoneVoice = false
    /// He spoke (not typed).
    var voice = false

    func timings(agent: HanceAgent) -> TurnTimings {
        func ms(_ a: Date?, _ b: Date?) -> Int? {
            guard let a, let b else { return nil }
            return Int(b.timeIntervalSince(a) * 1000)
        }
        let speechEnd = lastLoud ?? stopped
        var t = TurnTimings(agent: agent, voice: voice)
        t.spoke = voice ? speechEnd.map { $0.timeIntervalSince(started) } : nil
        t.pause = voice ? ms(lastLoud, stopped) : nil
        t.heard = ms(stopped, heard)
        t.answer = ms(heard, answered)
        t.voiceReady = ms(answered, sounded)
        t.total = ms(speechEnd, sounded)
        t.phoneVoice = phoneVoice
        return t
    }
}
