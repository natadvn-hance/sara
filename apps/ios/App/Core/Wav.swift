import Foundation

/// Boris's voice as the core's whisper wants it: 16 kHz, mono, 16-bit PCM in a WAV. The core's ffmpeg reads it as it
/// is (apps/core/src/notify/transcribe.ts). While it is still being recorded the sizes in the header say «a lot»: the
/// request starts before the end is known, and ffmpeg reads to the end of what came.
enum Wav {
    static let sampleRate = 16_000
    static let streamingSize: UInt32 = 0x7FFF_F000

    static func header(dataBytes: Int?) -> Data {
        let size = dataBytes.map { UInt32($0) } ?? streamingSize
        var d = Data()
        d.append(contentsOf: Array("RIFF".utf8))
        d.appendLE(UInt32(36) &+ size)
        d.append(contentsOf: Array("WAVEfmt ".utf8))
        d.appendLE(UInt32(16))
        d.appendLE(UInt16(1))
        d.appendLE(UInt16(1))
        d.appendLE(UInt32(sampleRate))
        d.appendLE(UInt32(sampleRate * 2))
        d.appendLE(UInt16(2))
        d.appendLE(UInt16(16))
        d.append(contentsOf: Array("data".utf8))
        d.appendLE(size)
        return d
    }

    static func file(pcm: Data) -> Data {
        var d = header(dataBytes: pcm.count)
        d.append(pcm)
        return d
    }

    /// Seconds of sound in this much PCM.
    static func seconds(pcmBytes: Int) -> Double { Double(pcmBytes) / Double(sampleRate * 2) }
}

extension Data {
    mutating func appendLE(_ v: UInt16) {
        append(UInt8(v & 0xFF))
        append(UInt8(v >> 8))
    }

    mutating func appendLE(_ v: UInt32) {
        for i in 0..<4 { append(UInt8((v >> (8 * UInt32(i))) & 0xFF)) }
    }
}
