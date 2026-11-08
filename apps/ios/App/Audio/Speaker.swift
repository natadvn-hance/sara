import AVFoundation

/// Her voice. The answer is said in pieces (SpeechChunker): the first piece is fetched at once, and each next one is
/// fetched while the one before plays, so the first words come as soon as the first sentence is made. If the core has
/// no voice (503) or a piece will not play, the phone's own Russian voice says the rest.
@MainActor
final class Speaker: NSObject, AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
    enum Played: Equatable {
        case played
        case stopped
        case failed
    }

    /// Her loudness while she speaks, 0...1, for the orb and the island.
    var onLevel: ((Double) -> Void)?
    /// Once, when the first sound of an answer starts.
    var onFirstSound: ((_ phoneVoice: Bool) -> Void)?

    private var player: AVAudioPlayer?
    private let synth = AVSpeechSynthesizer()
    private var finish: ((Played) -> Void)?
    private var meter: Timer?
    private var stopped = false

    override init() {
        super.init()
        synth.delegate = self
    }

    func say(_ text: String, fetch: @escaping (String) async throws -> Data?) async -> Played {
        stopped = false
        let parts = SpeechChunker.split(text)
        guard !parts.isEmpty else { return .played }
        var next: Task<Data?, Error>? = Task { try await fetch(parts[0]) }
        for i in parts.indices {
            let data: Data?
            do {
                data = try await next?.value
            } catch {
                data = nil
            }
            if stopped || Task.isCancelled {
                return .stopped
            }
            if i + 1 < parts.count {
                let p = parts[i + 1]
                next = Task { try await fetch(p) }
            } else {
                next = nil
            }
            let r: Played
            if let data {
                r = await play(data)
            } else {
                r = .failed
            }
            if r == .played { continue }
            next?.cancel()
            if r == .stopped { return .stopped }
            // No voice from the core for this piece: the phone says it and the rest.
            return await speakLocally(parts[i...].joined(separator: " "))
        }
        return .played
    }

    func stop() {
        stopped = true
        player?.stop()
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        end(.stopped)
    }

    /// The phone's own voice: Milena, Russian.
    func speakLocally(_ text: String) async -> Played {
        guard !stopped else { return .stopped }
        let u = AVSpeechUtterance(string: String(text.prefix(1200)))
        u.voice = AVSpeechSynthesisVoice(language: "ru-RU")
        u.rate = AVSpeechUtteranceDefaultSpeechRate * 1.04
        return await withCheckedContinuation { cont in
            finish = { cont.resume(returning: $0) }
            synth.speak(u)
            firstSound(phoneVoice: true)
            startMeter(fake: true)
        }
    }

    private func play(_ data: Data) async -> Played {
        guard let p = try? AVAudioPlayer(data: data) else { return .failed }
        p.delegate = self
        p.isMeteringEnabled = true
        p.prepareToPlay()
        player = p
        return await withCheckedContinuation { cont in
            finish = { cont.resume(returning: $0) }
            if p.play() {
                firstSound(phoneVoice: false)
                startMeter(fake: false)
            } else {
                end(.failed)
            }
        }
    }

    private func firstSound(phoneVoice: Bool) {
        let f = onFirstSound
        onFirstSound = nil
        f?(phoneVoice)
    }

    private func end(_ r: Played) {
        meter?.invalidate()
        meter = nil
        onLevel?(0)
        let f = finish
        finish = nil
        f?(r)
    }

    private func startMeter(fake: Bool) {
        meter?.invalidate()
        let started = Date()
        meter = Timer.scheduledTimer(withTimeInterval: 1 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if fake {
                    let t = Date().timeIntervalSince(started)
                    self.onLevel?(0.35 + 0.25 * abs(sin(t * 7.3)) * abs(sin(t * 2.1 + 1)))
                } else if let p = self.player {
                    p.updateMeters()
                    self.onLevel?(SilenceDetector.level(db: Double(p.averagePower(forChannel: 0)) - 6))
                }
            }
        }
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.end(flag ? .played : .failed) }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in self.end(.failed) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.end(.played) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.end(.stopped) }
    }
}
