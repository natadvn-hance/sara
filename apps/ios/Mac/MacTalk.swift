import AppKit
import Foundation

/// Lora on the Mac (Boris, 12.11): one shortcut, she comes out under the menu bar and listens; 1,5 s of quiet sends his
/// words, she answers in her voice and listens 1,5 s more for his next words, then goes. The same core, the same
/// sign-in and the same voice as on the iPhone; the words are heard on the Mac itself.
@MainActor
final class MacTalk: ObservableObject {
    static let shared = MacTalk()

    static let notes = (
        notHeard: "Не расслышала. Нажми ъ + ё и скажи ещё раз.",
        offline: "Нет связи с сервером Сары.",
        failed: "Не получилось. Попробуй ещё раз.",
        late: "Ответа нет шесть минут. Спроси ещё раз.",
        noMic: "Нужен доступ к микрофону и распознаванию речи: Системные настройки → Конфиденциальность.",
        signIn: "Войди паролем пульта: нажми ъ + ё, поле для пароля в этой плашке."
    )

    @Published private(set) var agent: HanceAgent = .lora
    @Published private(set) var phase: TalkPhase = .idle
    @Published private(set) var since = Date()
    /// His words while she thinks; her answer while she speaks.
    @Published private(set) var line: String?
    @Published private(set) var note: String?
    @Published private(set) var level: Double = 0
    @Published private(set) var signedIn: Bool
    /// The panel is out.
    @Published private(set) var shown = false

    let client = CoreClient()
    private let mic = MacMic()
    private let speaker = Speaker()
    private var detector = SilenceDetector()
    private var started = Date()
    private var verdict: CheckedContinuation<SilenceDetector.Step?, Never>?
    private var turn = 0
    private var flow: Task<Void, Never>?
    private var hide: Task<Void, Never>?

    private init() {
        signedIn = client.signedIn
        mic.onLevel = { [weak self] db in self?.heardLevel(db) }
        speaker.onLevel = { [weak self] v in
            guard let self, self.phase == .speaking else { return }
            self.level = v
        }
    }

    // MARK: What Boris does

    /// The chord with a digit: that one answers. Busy, it works as the plain chord (sends, or stops her).
    func press(as who: HanceAgent) {
        if !phase.isBusy, who != agent { agent = who }
        press()
    }

    /// The shortcut: comes out and listens; listening, sends what he said; while she thinks or speaks, stops her.
    func press() {
        switch phase {
        case .idle, .done, .failed:
            guard signedIn else {
                // The password field is in the panel itself; the same keys again put it away.
                hide?.cancel()
                note = nil
                shown.toggle()
                return
            }
            listen(followUp: false)
        case .listening:
            if detector.spoke { resolve(.stop) } else { turnOff() }
        case .sending, .thinking, .speaking:
            turnOff()
        }
    }

    func call(_ who: HanceAgent) {
        guard who != agent, !phase.isBusy else { return }
        agent = who
        listen(followUp: false)
    }

    func turnOff() {
        if phase.isBusy { Earcon.off() }
        stop()
        goAway(after: 0.4)
    }

    func login(password: String) async throws {
        try await client.login(password: password)
        signedIn = true
        note = "Готово. Нажми ъ + ё и говори."
        _ = await MacMic.allowed()
        goAway(after: 3)
    }

    func signOut() {
        stop()
        client.signOut()
        signedIn = false
    }

    // MARK: The talk

    private func listen(followUp: Bool) {
        turn += 1
        let mine = turn
        flow?.cancel()
        flow = Task { await self.listenFlow(followUp: followUp, turn: mine) }
    }

    private func listenFlow(followUp: Bool, turn mine: Int) async {
        hide?.cancel()
        shown = true
        note = nil
        if !followUp { line = nil }
        guard await MacMic.allowed() else {
            show(Self.notes.noMic)
            return set(.failed)
        }
        guard mine == turn else { return }
        client.prepare(for: agent) { [weak self] in
            guard let self, mine == self.turn, self.phase.isBusy else { return }
            self.show(Self.notes.offline)
        }
        detector = SilenceDetector(startWaitMs: followUp ? 1500 : 10_000, ignoreMs: 350)
        started = Date()
        do {
            try mic.start()
        } catch {
            show(Self.notes.noMic)
            return set(.failed)
        }
        set(.listening)
        Earcon.listening()
        let step = await withCheckedContinuation { verdict = $0 }
        guard mine == turn, let step else {
            mic.cancel()
            return
        }
        level = 0
        if step == .nothing {
            mic.cancel()
            if followUp {
                Earcon.off()
                set(.done)
                return goAway(after: 2.5)
            }
            show(Self.notes.notHeard)
            set(.idle)
            return goAway(after: 3)
        }
        Earcon.heard()
        set(.sending)
        guard let words = await mic.finish() else {
            show(Self.notes.notHeard)
            set(.idle)
            return goAway(after: 3)
        }
        line = words
        do {
            let sent = try await client.sendText(words, agent: agent)
            guard mine == turn else { return }
            if let to = sent.switchTo { agent = to }
            if let reply = sent.reply {
                return await say(reply.text, followUp: true, turn: mine)
            }
            guard let talk = sent.talk else { return set(.idle) }
            set(.thinking)
            let outcome = try await AnswerWait.wait(
                talk: talk, isFatal: { ($0 as? CoreError) == .signedOut },
                ask: { try await self.client.answer($0) })
            guard mine == turn else { return }
            switch outcome {
            case .done(let text, _): await say(text, followUp: true, turn: mine)
            case .gone, .late:
                show(Self.notes.late)
                set(.failed)
                goAway(after: 4)
            }
        } catch {
            guard mine == turn, !(error is CancellationError) else { return }
            if (error as? CoreError) == .signedOut {
                signedIn = false
                show(Self.notes.signIn)
            } else {
                show(error.isOffline ? Self.notes.offline : Self.notes.failed)
            }
            log.error("mac talk failed: \(error)")
            set(.failed)
            goAway(after: 5)
        }
    }

    private func say(_ text: String, followUp: Bool, turn mine: Int) async {
        line = text
        set(.speaking)
        let who = agent
        let client = self.client
        let played = await speaker.say(text) { part in try await client.speak(part, agent: who) }
        level = 0
        guard mine == turn else { return }
        if played == .played && followUp { return await listenFlow(followUp: true, turn: mine) }
        set(.done)
        goAway(after: 6)
    }

    private func stop() {
        turn += 1
        resolve(nil)
        flow?.cancel()
        mic.cancel()
        speaker.stop()
        level = 0
        set(.idle)
    }

    private func heardLevel(_ db: Double) {
        guard phase == .listening else { return }
        level = SilenceDetector.level(db: db)
        let step = detector.feed(db: db, at: Date().timeIntervalSince(started) * 1000)
        if step != .listen { resolve(step) }
    }

    private func resolve(_ step: SilenceDetector.Step?) {
        let v = verdict
        verdict = nil
        v?.resume(returning: step)
    }

    private func set(_ p: TalkPhase) {
        log.notice("mac phase \(p)")
        phase = p
        since = Date()
    }

    private func show(_ text: String) {
        note = text
        shown = true
    }

    /// The panel goes back under the menu bar a moment after the talk ends, unless a new one began.
    private func goAway(after seconds: Double) {
        hide?.cancel()
        hide = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard let self, !Task.isCancelled, !self.phase.isBusy else { return }
            self.shown = false
            self.note = nil
        }
    }
}
