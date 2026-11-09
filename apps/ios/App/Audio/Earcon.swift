import AVFoundation

/// Hance starts to listen: two dull, crisp knocks, «тук-тук», the first a little higher, like a Volvo's indicator; it
/// heard the end: the same two the other way round (Boris, 09.11). With the phone in the pocket and the side button
/// pressed, they say what the screen cannot.
@MainActor
enum Earcon {
    private static var players: [AVAudioPlayer] = []

    static func listening() { play(knocks([230, 190]), volume: 0.85) }
    static func heard() { play(knocks([190, 230]), volume: 0.85) }

    private static func play(_ wav: Data, volume: Float) {
        guard let p = try? AVAudioPlayer(data: wav) else { return }
        p.volume = volume
        p.prepareToPlay()
        p.play()
        players.removeAll { !$0.isPlaying }
        players.append(p)
    }

    nonisolated private static let rate = 44_100.0

    /// Two knocks like the relay of a Volvo's indicator, 120 ms apart (Boris, 09.11: «тупее и острее одновременно»):
    /// dull in tone, sharp in time. Each is a low tone that drops hard in its first milliseconds (the thud), starts at
    /// once and dies in about 20 ms, with a tiny muffled «тк» of the relay on top; no ringing overtone, and a low-pass
    /// near 2 kHz keeps it from being bright.
    nonisolated static func knocks(_ pitches: [Double] = [230, 190], apart: Double = 0.12) -> Data {
        let each = 0.08
        let length = Int(rate * (apart * Double(pitches.count - 1) + each))
        var mix = [Double](repeating: 0, count: length)
        var seed: UInt32 = 2_463_534_242
        for (k, f0) in pitches.enumerated() {
            let start = Int(rate * apart * Double(k))
            let level = k == 0 ? 1.0 : 0.9
            var phase = 0.0
            var under = 0.0
            var tick = 0.0
            for i in 0..<Int(rate * each) where start + i < length {
                let t = Double(i) / rate
                // A hard drop of the pitch, 30 % in 3 ms: the thud.
                let f = f0 * (1 + 0.3 * exp(-t / 0.003))
                phase += 2 * .pi * f / rate
                under += 2 * .pi * f * 0.5 / rate
                let body = sin(phase) * exp(-t / 0.018)
                let weight = sin(under) * 0.4 * exp(-t / 0.009)
                // The relay's «тк»: a millisecond of noise, muffled, not a hiss.
                seed ^= seed << 13
                seed ^= seed >> 17
                seed ^= seed << 5
                let noise = Double(seed) / Double(UInt32.max) * 2 - 1
                tick += 0.25 * (noise - tick)
                let click = tick * 0.9 * exp(-t / 0.0009)
                let attack = min(1, t / 0.0004)
                mix[start + i] += level * attack * (body + weight + click)
            }
        }
        let a = exp(-2 * .pi * 2000 / rate)
        var y = 0.0
        for i in mix.indices {
            y = (1 - a) * mix[i] + a * y
            mix[i] = y
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
