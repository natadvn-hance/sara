import AVFoundation

/// Dull knocks like a Volvo's indicator (Boris, 09.11 and 12.11: «тупее, как поворотники у Volvo»), in three styles he
/// picks from: «Реле», «Дерево», «Капля». On: two going up, «тук-тук», which sounds like switching on; his words sent:
/// the same two going down; off: one low knock. With the phone in the pocket and the side button pressed, they say what
/// the screen cannot.
@MainActor
enum Earcon {
    private static var players: [AVAudioPlayer] = []
    static let styleKey = "hance.earcon.style"

    /// The style he picked; «Дерево 05» (his choice, 12.11) until he picks another.
    static var style: EarconStyle {
        get { UserDefaults.standard.string(forKey: styleKey).flatMap(EarconStyle.init(rawValue:)) ?? .box }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: styleKey) }
    }

    static func listening() { style == .box ? playFile("earcon-on") : play(knocks(style, up: true), volume: 0.9) }
    static func heard() { style == .box ? playFile("earcon-sent") : play(knocks(style, up: false), volume: 0.9) }
    static func off() { style == .box ? playFile("earcon-off") : play(knocks(style, single: true), volume: 0.85) }

    /// «Дерево 05» from Lora's set 01-06 (Boris's choice, 12.11), as made there: on, two knocks going up (A3 to C#4);
    /// sent, one low knock (E3); off, two going down. He asked «sent» and «off» of that set swapped, and so they are.
    private static var files: [String: Data] = [:]

    private static func playFile(_ name: String) {
        if files[name] == nil, let url = Bundle.main.url(forResource: name, withExtension: "wav") {
            files[name] = try? Data(contentsOf: url)
        }
        guard let data = files[name] else {
            // Not in the bundle (a test): the synthesized wood says it instead.
            return play(knocks(.wood, up: name != "earcon-sent", single: name == "earcon-sent"), volume: 0.9)
        }
        play(data, volume: 1)
    }

    private static func play(_ wav: Data, volume: Float) {
        guard let p = try? AVAudioPlayer(data: wav) else { return }
        p.volume = volume
        p.prepareToPlay()
        p.play()
        players.removeAll { !$0.isPlaying }
        players.append(p)
    }

    /// A pair (up or down) or one knock of the style.
    nonisolated static func knocks(_ style: EarconStyle, up: Bool = true, single: Bool = false) -> Data {
        let r = style.recipe
        let pitches = single ? [r.low * 0.9] : (up ? [r.low, r.high] : [r.high, r.low])
        return knocks(pitches, recipe: r)
    }

    nonisolated private static let rate = 44_100.0

    /// The knocks of a recipe, one after another: each a low tone that sinks as it lands (the thud), its attack and
    /// body as the recipe says, a little of the octave below for weight, maybe a muffled relay «тк», all under a
    /// low-pass so nothing is bright.
    nonisolated static func knocks(_ pitches: [Double], recipe r: EarconRecipe) -> Data {
        let each = r.body * 4 + 0.02
        let length = Int(rate * (r.apart * Double(pitches.count - 1) + each))
        var mix = [Double](repeating: 0, count: length)
        var seed: UInt32 = 2_463_534_242
        for (k, f0) in pitches.enumerated() {
            let start = Int(rate * r.apart * Double(k))
            let level = k == 0 ? 1.0 : 0.9
            var phase = 0.0
            var under = 0.0
            var tick = 0.0
            for i in 0..<Int(rate * each) where start + i < length {
                let t = Double(i) / rate
                let f = f0 * (1 + r.drop * exp(-t / r.dropTime))
                phase += 2 * .pi * f / rate
                under += 2 * .pi * f * 0.5 / rate
                let body = sin(phase) * exp(-t / r.body)
                let weight = sin(under) * r.weight * exp(-t / (r.body * 0.5))
                seed ^= seed << 13
                seed ^= seed >> 17
                seed ^= seed << 5
                let noise = Double(seed) / Double(UInt32.max) * 2 - 1
                tick += 0.2 * (noise - tick)
                let click = tick * r.click * exp(-t / 0.0009)
                let attack = 1 - exp(-t / r.attack)
                mix[start + i] += level * attack * (body + weight + click)
            }
        }
        let a = exp(-2 * .pi * r.lowpass / rate)
        for _ in 0..<r.passes {
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

/// How a knock is made: its two pitches, how hard it sinks as it lands, its attack, body, weight, relay click, the
/// low-pass over it and the gap between the two knocks.
struct EarconRecipe: Sendable {
    let low: Double
    let high: Double
    let drop: Double
    let dropTime: Double
    let attack: Double
    let body: Double
    let weight: Double
    let click: Double
    let lowpass: Double
    let passes: Int
    let apart: Double
}

/// The three sounds Boris chooses from (12.11): all low and dull, none sharp.
enum EarconStyle: String, CaseIterable, Sendable {
    /// «Дерево 05», a dry wooden box, from Lora's set (Boris's choice, 12.11): three recorded sounds in the bundle.
    case box
    /// A low dull «тук» with a barely heard relay click: the Volvo's indicator.
    case relay
    /// Lower still, a soft wooden knock without any click.
    case wood
    /// Round, a little like a drop: the tone sinks further as it lands.
    case drop

    var name: String {
        switch self {
        case .box: return "Дерево 05"
        case .relay: return "Реле"
        case .wood: return "Дерево"
        case .drop: return "Капля"
        }
    }

    var recipe: EarconRecipe {
        switch self {
        case .box, .relay:
            return EarconRecipe(
                low: 165, high: 200, drop: 0.25, dropTime: 0.003, attack: 0.001, body: 0.02, weight: 0.5, click: 0.35,
                lowpass: 1300, passes: 2, apart: 0.13)
        case .wood:
            return EarconRecipe(
                low: 140, high: 170, drop: 0.15, dropTime: 0.004, attack: 0.002, body: 0.028, weight: 0.6, click: 0,
                lowpass: 900, passes: 2, apart: 0.14)
        case .drop:
            return EarconRecipe(
                low: 215, high: 260, drop: 0.45, dropTime: 0.006, attack: 0.003, body: 0.03, weight: 0.3, click: 0,
                lowpass: 1100, passes: 2, apart: 0.14)
        }
    }
}
