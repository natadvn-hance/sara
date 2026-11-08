import AVFoundation

/// Two soft notes: up when Hance starts to listen, down when it heard the end. With the phone in the pocket and the
/// side button pressed, they say what the screen cannot.
@MainActor
enum Earcon {
    private static var players: [AVAudioPlayer] = []

    static func listening() { play([659.25, 987.77]) }
    static func heard() { play([987.77, 659.25]) }

    private static func play(_ notes: [Double]) {
        guard let p = try? AVAudioPlayer(data: tones(notes)) else { return }
        p.volume = 0.32
        p.prepareToPlay()
        p.play()
        players.removeAll { !$0.isPlaying }
        players.append(p)
    }

    /// The notes one after another, 75 ms each with a soft edge, as a WAV.
    private static func tones(_ notes: [Double]) -> Data {
        let rate = 44_100.0
        let each = Int(rate * 0.075)
        var pcm = Data()
        for f in notes {
            for i in 0..<each {
                let t = Double(i) / rate
                let edge = min(1, Double(i) / (rate * 0.008), Double(each - i) / (rate * 0.03))
                let v = sin(2 * .pi * f * t) * 0.6 + sin(4 * .pi * f * t) * 0.12
                pcm.appendLE(UInt16(bitPattern: Int16(max(-1, min(1, v * edge)) * 30_000)))
            }
        }
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
