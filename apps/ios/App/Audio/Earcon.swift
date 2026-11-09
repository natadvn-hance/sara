import AVFoundation

/// Hance starts to listen: two round, dull knocks, «тук-тук», the first a little higher, like a Volvo's indicator; it
/// heard the end: the same two the other way round (Boris, 09.11). With the phone in the pocket and the side button
/// pressed, they say what the screen cannot.
@MainActor
enum Earcon {
    private static var players: [AVAudioPlayer] = []

    static func listening() { play(knocks([300, 250]), volume: 0.8) }
    static func heard() { play(knocks([250, 300]), volume: 0.8) }

    private static func play(_ wav: Data, volume: Float) {
        guard let p = try? AVAudioPlayer(data: wav) else { return }
        p.volume = volume
        p.prepareToPlay()
        p.play()
        players.removeAll { !$0.isPlaying }
        players.append(p)
    }

    nonisolated private static let rate = 44_100.0

    /// Two round, dull knocks 130 ms apart, like the relay of a Volvo's indicator (Boris, 09.11: «круглее и тупее»):
    /// each a low tone that sinks a little in its first milliseconds, with a soft attack and a short body; no click of
    /// noise, no bright overtone, and a gentle low-pass over all, so nothing in it is sharp.
    nonisolated static func knocks(_ pitches: [Double] = [300, 250], apart: Double = 0.13) -> Data {
        let each = 0.11
        let length = Int(rate * (apart * Double(pitches.count - 1) + each))
        var mix = [Double](repeating: 0, count: length)
        for (k, f0) in pitches.enumerated() {
            let start = Int(rate * apart * Double(k))
            let level = k == 0 ? 1.0 : 0.9
            var phase = 0.0
            var under = 0.0
            for i in 0..<Int(rate * each) where start + i < length {
                let t = Double(i) / rate
                // The «тук»: the pitch sinks 10 % in the first 6 ms, so it lands rather than rings.
                let f = f0 * (1 + 0.1 * exp(-t / 0.006))
                phase += 2 * .pi * f / rate
                under += 2 * .pi * f * 0.5 / rate
                let body = sin(phase) * exp(-t / 0.03)
                // A little of the octave below gives it weight, gone in a few milliseconds.
                let weight = sin(under) * 0.35 * exp(-t / 0.012)
                // A soft attack of 3 ms: round, not a click.
                let attack = 1 - exp(-t / 0.003)
                mix[start + i] += level * attack * (body + weight)
            }
        }
        // Two passes of a one-pole low-pass near 1,4 kHz take off what is left of the edge.
        let a = exp(-2 * .pi * 1400 / rate)
        for _ in 0..<2 {
            var y = 0.0
            for i in mix.indices {
                y = (1 - a) * mix[i] + a * y
                mix[i] = y
            }
        }
        let peak = mix.map(abs).max() ?? 1
        var pcm = Data()
        for v in mix { pcm.appendLE(UInt16(bitPattern: Int16(v / max(peak, 0.0001) * 0.9 * 30_000))) }
        return wav(pcm)
    }

    /// 16-bit mono PCM at 44.1 kHz as a WAV file.
    nonisolated private static func wav(_ pcm: Data) -> Data {
        var d = Data()
        d.append(contentsOf: Array("RIFF".utf8))
        d.appendLE(UInt32(36 + pcm.count))
        d.append(contentsOf: Array("WAVEfmt ".utf8))
        d.appendLE(UInt32(16))
        d.appendLE(UInt16(1))
        d.appendLE(UInt16(1))
        d.appendLE(UInt32(rate))
        d.appendLE(UInt32(rate * 2))
        d.appendLE(UInt16(2))
        d.appendLE(UInt16(16))
        d.append(contentsOf: Array("data".utf8))
        d.appendLE(UInt32(pcm.count))
        d.append(pcm)
        return d
    }
}
