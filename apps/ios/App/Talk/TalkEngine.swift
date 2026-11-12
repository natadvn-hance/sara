import AVFoundation
import SwiftUI
import UIKit

/// The talk itself, apart from the screen (ADR-028), as the PWA's engine.ts: listen, send, wait for Lora or Sara, say
/// her answer, listen a few seconds for a follow-up. The microphone, the audio session and the Live Activity are on for
/// the whole talk, so it goes on with the phone locked or the app in the background, and the side button can start it
/// without opening the app.
@MainActor
final class TalkEngine: ObservableObject {
    static let shared = TalkEngine()

    static let notes = (
        notHeard: "Не разобрала",
        notHeardTry: "Не услышала. Нажми и скажи ещё раз.",
        noMic: "Нет доступа к микрофону. Разреши его для Hance в Настройках.",
        late: "Ответа нет шесть минут. Спроси ещё раз.",
        gone: "Ответ потерялся: сервер перезапускался. Скажи ещё раз.",
        failed: "Нет связи. Проверь интернет и попробуй ещё раз.",
        offline: "Нет связи с сервером Сары. Проверь интернет или VPN и скажи ещё раз."
    )

    /// Who answers now: Lora by default.
    @Published private(set) var agent: HanceAgent = .lora
    @Published private(set) var phase: TalkPhase = .idle
    /// He pressed and the microphone is starting: the screen lights up at once, before the first sound.
    @Published private(set) var arming = false
    /// When the phase began: the screen counts the thinking time from here.
    @Published private(set) var since = Date()
    /// What the core heard of Boris's last words.
    @Published private(set) var heard: String?
    /// Her last answer, on the screen until the next question.
    @Published private(set) var card: AnswerCard?
    /// A short word when something went wrong.
    @Published private(set) var note: String?
    @Published private(set) var signedIn: Bool
    @Published private(set) var timings: [TurnTimings] = TurnTimings.load()
    /// The app is on screen: answers go to the screen, not to notifications. Asked of iOS each time: an intent from the
    /// side button wakes the app in the background, where no scene ever becomes active.
    var onScreen: Bool { UIApplication.shared.applicationState == .active }

    let meter = LevelMeter()
    let client: CoreClient
    private let source: VoiceSource
    private let speaker = Speaker()
    private let activity = TalkActivityController()
    private var detector = SilenceDetector()
    private var verdict: CheckedContinuation<SilenceDetector.Step?, Never>?
    private var flow: Task<Void, Never>?
    private var upload: VoiceUpload?
    private var turn = 0
    private var micOn = false
    private var line: String?
    private var clock = TurnClock()
    private var greetings: [String: Data] = [:]
    private var noteTimer: Task<Void, Never>?

    private var keepAlive: Task<Void, Never>?

    init() {
        client = CoreClient()
        signedIn = client.signedIn
        #if DEBUG
            if let path = UserDefaults.standard.string(forKey: "HanceFakeVoice") {
                source = FakeVoice(url: URL(fileURLWithPath: path))
            } else {
                source = Mic()
            }
        #else
            source = Mic()
        #endif
        source.onLevel = { [weak self] db in self?.heardLevel(db) }
        speaker.onLevel = { [weak self] v in self?.voiceLevel(v) }
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] n in
            let began = (n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
            if began { MainActor.assumeIsolated { self?.stop() } }
        }
        // The way to the core is set up as soon as Hance comes on screen, and kept open while it is there or a talk
        // goes on: on Boris's phone a new secure connection takes up to 16 s through his VPN (12.11), an open one
        // answers in a fraction of a second.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.signedIn else { return }
                self.client.warm(self.agent)
            }
        }
        keepAlive = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                guard let self else { return }
                if self.signedIn && (self.onScreen || self.phase.isBusy) { self.client.ping() }
            }
        }
        loadGreetings()
    }

    // MARK: What Boris does

    /// The orb: speak, end the recording, or stop her voice.
    func press() {
        switch phase {
        case .idle, .done, .failed: listen()
        // Listening: once he has spoken a tap sends his words; before that (waiting for him, or for his next words
        // after her answer) the same tap switches her off (Boris, 12.11).
        case .listening: detector.spoke ? finishListening() : turnOff()
        case .speaking: turnOff()
        // His habit is a tap to end his words; the pause may have ended them a moment before. That tap must not
        // throw his question away (Boris, 12.11): while it goes up and she thinks, a tap does nothing.
        case .sending, .thinking: break
        }
    }

    func listen(followUp: Bool = false) {
        guard signedIn else { return }
        turn += 1
        let mine = turn
        flow?.cancel()
        flow = Task { await self.listenFlow(followUp: followUp, turn: mine) }
    }

    /// He tapped while speaking: what he said goes now, without waiting for the pause.
    func finishListening() {
        guard phase == .listening else { return }
        resolve(.stop)
    }

    func send(text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, signedIn, !phase.isBusy else { return }
        turn += 1
        let mine = turn
        flow?.cancel()
        flow = Task {
            self.heard = t
            self.card = nil
            self.clock = TurnClock()
            self.set(.sending, line: t)
            do {
                let sent = try await self.client.sendText(t, agent: self.agent)
                self.clock.stopped = self.clock.started
                self.clock.heard = Date()
                await self.answered(sent, spoken: false, typed: t, turn: mine)
            } catch {
                self.failed(error, turn: mine)
            }
        }
    }

    /// A tap on the other one's picture: she comes and greets.
    func call(_ who: HanceAgent) {
        guard who != agent, phase == .idle || phase == .done || phase == .failed || phase == .speaking else { return }
        turn += 1
        let mine = turn
        speaker.stop()
        flow?.cancel()
        become(who)
        flow = Task { await self.say(who.greeting, cards: 0, followUp: false, turn: mine) }
    }

    /// The side button, Siri or the Control Center: listening starts before the intent returns, with the island up.
    func startFromIntent(_ who: HanceAgent) async throws {
        // One button, on and off (Boris, 09.11): listening, a press sends what he said; while she thinks or
        // speaks, a press stops her; otherwise it starts listening.
        if phase == .listening {
            finishListening()
            return
        }
        if phase.isBusy {
            turnOff()
            return
        }
        if who != agent { become(who) }
        guard await micAllowed() else {
            throw MicError.noInput
        }
        // The island first: iOS stops an intent that records in the background without one.
        activity.start(state(.listening))
        guard activity.isOn else { throw NoIsland() }
        do {
            try beginTalk()
        } catch {
            activity.end(nil, linger: 0)
            throw error
        }
        listen()
    }

    /// From Siri «Открой Hance», a notification's «Ответить голосом» or the island: the app is on screen and listens.
    func openAndListen(_ who: HanceAgent) {
        if phase.isBusy { return }
        if who != agent { become(who) }
        listen()
    }

    /// Her last answer once more.
    func replay() {
        guard let c = card, !phase.isBusy else { return }
        turn += 1
        let mine = turn
        flow = Task { await self.say(c.text, cards: c.cards, followUp: false, turn: mine, show: false) }
    }

    /// He switches her off (a long press on her photo at any time, a tap while she waits for him): the low knock, and
    /// all stops.
    func turnOff() {
        if phase.isBusy { Earcon.off() }
        stop()
    }

    /// No more listening, no more voice; the island goes.
    func stop() {
        turn += 1
        resolve(nil)
        flow?.cancel()
        upload?.cancel()
        upload = nil
        speaker.stop()
        endTalk(final: nil)
    }

    func dismissCard() { card = nil }

    func login(password: String) async throws {
        try await client.login(password: password)
        signedIn = true
        _ = await micAllowed()
        await Ears.askOnce()
        await Notifier.ask()
        loadGreetings()
    }

    func signOut() {
        stop()
        client.signOut()
        signedIn = false
    }

    // MARK: The talk

    private func listenFlow(followUp: Bool, turn mine: Int) async {
        let pressed = Date()
        arming = !followUp
        defer { arming = false }
        guard await micAllowed() else {
            show(Self.notes.noMic)
            return endTalk(final: .failed)
        }
        do {
            try beginTalk()
        } catch {
            show(Self.notes.noMic)
            return endTalk(final: .failed)
        }
        guard mine == turn else { return }
        if onScreen { await Ears.askOnce() }
        guard mine == turn else { return }
        client.prepare(for: agent)
        note = nil
        if !followUp { card = nil }
        clock = TurnClock()
        clock.voice = true
        // After her answer the talk waits 1,5 s for his next words, then goes out (Boris, 12.11).
        detector = SilenceDetector(startWaitMs: followUp ? 1500 : 10_000, ignoreMs: 350)
        let up = VoiceUpload(client: client, agent: agent)
        upload = up
        // The phone hears the words itself as he speaks; the recording goes up too, for when it cannot.
        let ears = Ears()
        source.record(into: { pcm in
            up.append(pcm)
            ears?.feed(pcm)
        })
        set(.listening, line: nil)
        arming = false
        Earcon.listening()
        log.notice("listening \(Int(Date().timeIntervalSince(pressed) * 1000)) ms after the press")

        let step = await waitForVerdict()
        source.record(into: nil)
        log.notice(
            "listen ended: \(String(describing: step), privacy: .public), \(up.seconds, format: .fixed(precision: 1)) s, turn \(mine == self.turn ? "same" : "changed", privacy: .public)"
        )
        guard mine == turn, let step else {
            up.cancel()
            ears?.cancel()
            return
        }
        if step == .nothing || up.seconds < 0.4 {
            up.cancel()
            ears?.cancel()
            upload = nil
            // He said nothing after her answer: the answer stays on the Lock Screen a while, as after any answer.
            if followUp, let last = card {
                line = last.text
                Earcon.off()
                return endTalk(final: .done)
            }
            // Pressed and nothing heard: said so, not a silent stop.
            show(Self.notes.notHeardTry)
            return endTalk(final: nil)
        }
        Earcon.heard()
        clock.stopped = Date()
        set(.sending, line: nil)
        do {
            let sent: Sent
            if let words = await ears?.finish() {
                // Heard on the phone: the words go as text, no recording and no whisper on the server to wait for.
                up.cancel()
                log.notice("heard on the phone, \(words.count) chars")
                sent = try await client.sendText(words, agent: agent)
            } else if ears?.heardNoSpeech == true {
                // Sound but no speech (noise, her echo): no question to anyone, no «не разобрала» from the server.
                up.cancel()
                upload = nil
                log.notice("the phone heard no speech, nothing is sent")
                if followUp, let last = card {
                    line = last.text
                    Earcon.off()
                    return endTalk(final: .done)
                }
                show(Self.notes.notHeardTry)
                return endTalk(final: nil)
            } else {
                log.notice("the phone heard no words, the recording goes to the server")
                sent = try await up.finish()
            }
            upload = nil
            clock.heard = Date()
            guard mine == turn else { return }
            await answered(sent, spoken: true, typed: nil, turn: mine)
        } catch {
            upload = nil
            failed(error, turn: mine)
        }
    }

    private func answered(_ sent: Sent, spoken: Bool, typed: String?, turn mine: Int) async {
        guard mine == turn else { return }
        heard = typed ?? sent.heard ?? Self.notes.notHeard
        if let to = sent.switchTo { become(to) }
        if let reply = sent.reply {
            clock.answered = Date()
            return await say(reply.text, cards: reply.buttons ? 1 : 0, followUp: spoken && sent.heard != nil, turn: mine)
        }
        guard let talk = sent.talk else { return endTalk(final: nil) }
        set(.thinking, line: heard)
        do {
            let outcome = try await AnswerWait.wait(
                talk: talk, isFatal: { ($0 as? CoreError) == .signedOut },
                ask: { try await self.client.answer($0) })
            guard mine == turn else { return }
            switch outcome {
            case .done(let text, let cards):
                clock.answered = Date()
                await say(text, cards: cards, followUp: spoken, turn: mine)
            case .gone:
                show(Self.notes.gone)
                endTalk(final: .failed)
            case .late:
                show(Self.notes.late)
                endTalk(final: .failed)
            }
        } catch {
            failed(error, turn: mine)
        }
    }

    private func say(_ text: String, cards: Int, followUp: Bool, turn mine: Int, show showCard: Bool = true) async {
        let who = agent
        if showCard {
            card = AnswerCard(agent: who, text: text, cards: cards)
            if !onScreen { Notifier.post(agent: who, text: text, cards: cards) }
        }
        if !micOn {
            try? AudioSessionControl.activate()
            activity.start(state(.speaking))
        }
        set(.speaking, line: text)
        speaker.onFirstSound = { [weak self] phoneVoice in
            self?.clock.sounded = Date()
            self?.clock.phoneVoice = phoneVoice
        }
        let client = self.client
        let played = await speaker.say(text) { [weak self] part in
            if let cached = self?.greetings[Self.greetingKey(who, part)] { return cached }
            return try await client.speak(part, agent: who)
        }
        record()
        guard mine == turn else { return }
        if played == .played && followUp {
            return await listenFlow(followUp: true, turn: mine)
        }
        endTalk(final: .done)
    }

    private func failed(_ error: Error, turn mine: Int) {
        guard mine == turn else { return }
        if (error as? CoreError) == .signedOut {
            stop()
            signedIn = false
            return
        }
        if error is CancellationError || Task.isCancelled { return }
        log.error("talk failed: \(String(describing: error), privacy: .public)")
        show(error.isOffline ? Self.notes.offline : Self.notes.failed)
        endTalk(final: .failed)
    }

    // MARK: Microphone, session, island

    private func micAllowed() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
    }

    private func beginTalk() throws {
        if micOn { return }
        try AudioSessionControl.activate()
        try source.start()
        micOn = true
        activity.start(state(.listening))
    }

    private func endTalk(final: TalkPhase?) {
        resolve(nil)
        source.record(into: nil)
        source.stop()
        micOn = false
        AudioSessionControl.deactivate()
        if let final {
            activity.end(state(final), linger: final == .done ? 30 : 10)
        } else {
            activity.end(nil, linger: 0)
        }
        meter.reset()
        phase = .idle
        since = Date()
    }

    private func waitForVerdict() async -> SilenceDetector.Step? {
        await withCheckedContinuation { cont in
            verdict = cont
        }
    }

    private func resolve(_ step: SilenceDetector.Step?) {
        let v = verdict
        verdict = nil
        v?.resume(returning: step)
    }

    private func heardLevel(_ db: Double) {
        guard phase == .listening else { return }
        meter.feed(SilenceDetector.level(db: db))
        let now = Date()
        let step = detector.feed(db: db, at: now.timeIntervalSince(clock.started) * 1000)
        if db >= detector.threshold { clock.lastLoud = now }
        activity.update(state(.listening), force: false)
        if step != .listen { resolve(step) }
    }

    private func voiceLevel(_ v: Double) {
        guard phase == .speaking else { return }
        meter.feed(v)
        activity.update(state(.speaking), force: false)
    }

    private func set(_ p: TalkPhase, line newLine: String?) {
        log.notice("phase \(String(describing: p), privacy: .public)")
        phase = p
        since = Date()
        line = newLine
        activity.update(state(p), force: true)
    }

    private func state(_ p: TalkPhase) -> TalkActivityAttributes.ContentState {
        let bars = p == .listening || p == .speaking ? meter.bars() : Array(repeating: 0.12, count: 7)
        let shown = line.map { String($0.prefix(110)) }
        return .init(agent: agent, phase: p, since: since, line: shown, bars: bars)
    }

    private func become(_ who: HanceAgent) {
        guard who != agent else { return }
        agent = who
        activity.update(state(phase), force: true)
    }

    private func show(_ text: String) {
        note = text
        noteTimer?.cancel()
        noteTimer = Task {
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if !Task.isCancelled, self.note == text { self.note = nil }
        }
    }

    private func record() {
        guard clock.sounded != nil || clock.answered != nil else { return }
        let t = clock.timings(agent: agent)
        guard t.answer != nil || t.heard != nil else { return }
        log.info("timing \(t.agent.rawValue, privacy: .public) \(t.line, privacy: .public)")
        timings.insert(t, at: 0)
        if timings.count > 30 { timings.removeLast(timings.count - 30) }
        TurnTimings.save(timings)
        clock = TurnClock()
    }

    // MARK: Greetings, kept on the phone

    private static func greetingKey(_ who: HanceAgent, _ text: String) -> String { "\(who.rawValue):\(text)" }

    private static func greetingFile(_ who: HanceAgent) -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("greeting-\(who.rawValue).mp3")
    }

    /// Her greeting in her own voice, fetched once and kept: when she is called, she answers at once.
    private func loadGreetings() {
        for who in HanceAgent.allCases {
            let key = Self.greetingKey(who, who.greeting)
            if let d = try? Data(contentsOf: Self.greetingFile(who)) {
                greetings[key] = d
            }
        }
        guard signedIn else { return }
        let missing = HanceAgent.allCases.filter { greetings[Self.greetingKey($0, $0.greeting)] == nil }
        guard !missing.isEmpty else { return }
        let client = self.client
        Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            for who in missing {
                guard let d = try? await client.speak(who.greeting, agent: who) else { continue }
                try? d.write(to: Self.greetingFile(who))
                self.greetings[Self.greetingKey(who, who.greeting)] = d
            }
        }
    }
}
