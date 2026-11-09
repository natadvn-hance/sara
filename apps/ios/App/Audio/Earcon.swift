import AVFoundation

/// Hance starts to listen: two dull wooden knocks, «тук-тук», the first a little higher, like a Volvo's indicator; it
/// heard the end: the same two the other way round (Boris, 09.11). With the phone in the pocket and the side button
/// pressed, they say what the screen cannot.
@MainActor
enum Earcon {
    private static var players: [AVAudioPlayer] = []

    static func listening() { play(knocks([520, 430]), volume: 0.7) }
    static func heard() { play(knocks([430, 520]), volume: 0.7) }

    private static func play(_ wav: Data, volume: Float) {
        guard let p = try? AVAudioPlayer(data: wav) else { return }
        p.volume = volume
        p.prepareToPlay()
        p.play()
        players.removeAll { !$0.isPlaying }
        players.append(p)
    }

    nonisolated private static let rate = 44_100.0

    /// Two knocks of a small block of wood, 120 ms apart: each a short low body that sinks a little in pitch, a weaker
    /// overtone that dies first and a soft muffled tap at the start; no ring, nothing bright.
    nonisolated static func knocks(_ pitches: [Double] = [520, 430], apart: Double = 0.12) -> Data {
        let length = Int(rate * (apart * Double(pitches.count - 1) + 0.09))
        var mix = [Double](repeating: 0, count: length)
        var seed: UInt32 = 2_463_534_242
        for (k, f0) in pitches.enumerated() {
            let start = Int(rate * apart * Double(k))
            let level = k == 0 ? 1.0 : 0.88
            var phase1 = 0.0
            var phase2 = 0.0
            var muffled = 0.0
            for i in 0..<Int(rate * 0.09) where start + i < length {
                let t = Double(i) / rate
                // The pitch sinks a few percent in the first milliseconds: that is the «тук», not a «тинь».
                let f = f0 * (1 + 0.07 * exp(-t / 0.004))
                phase1 += 2 * .pi * f / rate
                phase2 += 2 * .pi * f * 2.6 / rate
                let body = sin(phase1) * exp(-t / 0.024)
                let overtone = sin(phase2) * 0.22 * exp(-t / 0.008)
                seed ^= seed << 13
                seed ^= seed >> 17
                seed ^= seed << 5
                let noise = Double(seed) / Double(UInt32.max) * 2 - 1
                muffled += 0.18 * (noise - muffled)
                let tap = muffled * 1.6 * exp(-t / 0.0015)
                let attack = min(1, t / 0.0008)
                mix[start + i] += level * attack * (body + overtone + tap)
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
