import Foundation

/// Hands-free listening (FR-NOTIF-5), as in the PWA (logic.ts createSilence) but on the microphone's decibels: after
/// speech, a pause of `pauseMs` ends the recording; with no speech within `startWaitMs` it ends empty; it never runs past
/// `maxMs`. The bar for speech follows the room: it rises over a steady noise (a street, a car) and falls back in quiet.
struct SilenceDetector {
    enum Step: Equatable {
        case listen
        case stop
        case nothing
    }

    let pauseMs: Double
    let startWaitMs: Double
    let maxMs: Double
    /// Loud this long before it counts as speech: a tap on the phone or a click does not.
    let minSpeechMs: Double
    /// The first moments are not listened to: the knocks that say «I listen» play then, into the microphone too.
    let ignoreMs: Double

    /// Speech is at least this loud whatever the room.
    static let quietBar: Double = -42
    /// And this much above the room's own noise.
    static let aboveRoom: Double = 12

    private var start: Double?
    private var lastAt: Double?
    private var lastLoud = -Double.infinity
    private var loudRun: Double = 0
    private(set) var spoke = false
    /// The room's noise in dB, followed slowly.
    private(set) var room: Double = -55

    init(
        pauseMs: Double = 1500, startWaitMs: Double = 10_000, maxMs: Double = 90_000, minSpeechMs: Double = 200,
        ignoreMs: Double = 0
    ) {
        self.pauseMs = pauseMs
        self.startWaitMs = startWaitMs
        self.maxMs = maxMs
        self.minSpeechMs = minSpeechMs
        self.ignoreMs = ignoreMs
    }

    var threshold: Double { max(Self.quietBar, room + Self.aboveRoom) }

    /// The loudness for the screen and the island, 0...1: -55 dB is nothing, -15 dB is full.
    static func level(db: Double) -> Double {
        guard db.isFinite else { return 0 }
        return min(1, max(0, (db + 55) / 40))
    }

    mutating func feed(db raw: Double, at: Double) -> Step {
        let db = raw.isFinite ? min(0, max(-100, raw)) : -100
        let begun = start ?? at
        start = begun
        let dt = min(100, max(0, at - (lastAt ?? at)))
        lastAt = at
        if at - begun < ignoreMs { return .listen }
        if at - begun >= maxMs { return spoke ? .stop : .nothing }

        let loud = db >= threshold
        // The room: down at once into a quieter moment, up slowly over a steady noise, hardly at all under speech.
        let tau: Double = db < room ? 150 : (loud ? 30_000 : 2000)
        room += (db - room) * (1 - exp(-dt / tau))

        if loud {
            if !spoke && at - lastLoud > 500 { loudRun = 0 }
            loudRun += dt
            lastLoud = at
            if loudRun >= minSpeechMs { spoke = true }
            return .listen
        }
        if !spoke {
            if at - lastLoud > 500 { loudRun = 0 }
            return at - begun >= startWaitMs ? .nothing : .listen
        }
        return at - lastLoud >= pauseMs ? .stop : .listen
    }
}
