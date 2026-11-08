import SwiftUI

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

/// The colours of Hance, one language with the PWA (talk-design-language.md, PR #270): warm paper, ink #1A1A1A, and
/// the colour of the one who speaks. Lora is the orange of Hance, Sara is #005A52. Dark follows the phone's theme.
struct Palette: Equatable {
    /// The colour of the one who speaks.
    let accent: Color
    /// Her colour for text: darker in light, lighter in dark.
    let accentInk: Color
    /// Her colour, soft: under labels, in the clouds.
    let accentSoft: Color
    let bg: Color
    /// Cards and plates.
    let paper: Color
    let ink: Color
    /// Secondary text.
    let muted: Color
    /// Hairlines.
    let line: Color

    static func of(_ agent: HanceAgent, dark: Bool) -> Palette {
        switch (agent, dark) {
        case (.lora, false):
            return Palette(
                accent: Color(hex: 0xFF3D00), accentInk: Color(hex: 0xC93000), accentSoft: Color(hex: 0xFFD9C9),
                bg: Color(hex: 0xF3F2EF), paper: Color(hex: 0xFCFBF9), ink: Color(hex: 0x1A1A1A),
                muted: Color(hex: 0x6B6A65), line: Color(hex: 0xDCD9D3))
        case (.sara, false):
            return Palette(
                accent: Color(hex: 0x005A52), accentInk: Color(hex: 0x00463F), accentSoft: Color(hex: 0xBFDCD7),
                bg: Color(hex: 0xEEF2F1), paper: Color(hex: 0xFCFBF9), ink: Color(hex: 0x1A1A1A),
                muted: Color(hex: 0x6B6A65), line: Color(hex: 0xD6DCDA))
        case (.lora, true):
            return Palette(
                accent: Color(hex: 0xFF4F17), accentInk: Color(hex: 0xFF8A62), accentSoft: Color(hex: 0x4A2416),
                bg: Color(hex: 0x141312), paper: Color(hex: 0x201F1D), ink: Color(hex: 0xF3F2EF),
                muted: Color(hex: 0x9D978F), line: Color(hex: 0x33312E))
        case (.sara, true):
            return Palette(
                accent: Color(hex: 0x1B8A7D), accentInk: Color(hex: 0x7CCFC3), accentSoft: Color(hex: 0x123430),
                bg: Color(hex: 0x101615), paper: Color(hex: 0x201F1D), ink: Color(hex: 0xF3F2EF),
                muted: Color(hex: 0x9D978F), line: Color(hex: 0x2C3331))
        }
    }
}

/// The movement of the site: its curve cubic-bezier(.22,1,.36,1) and its spring cubic-bezier(.2,1.35,.35,1).
enum Motion {
    static func ease(_ duration: Double = 0.9) -> Animation { .timingCurve(0.22, 1, 0.36, 1, duration: duration) }
    static func spring(_ duration: Double = 0.9) -> Animation { .timingCurve(0.2, 1.35, 0.35, 1, duration: duration) }
}

/// The type of Hance: Involve (400 and 600) for words, as on hance.pro; Martian Mono in capitals for small labels,
/// the status and times.
enum HanceFont {
    enum Weight {
        case regular
        case semibold
    }

    static func text(_ size: CGFloat, _ weight: Weight = .regular) -> Font {
        .custom(weight == .regular ? "Involve-Regular" : "Involve-SemiBold", fixedSize: size)
    }

    /// Involve that follows the phone's text size, for longer reading (the answer).
    static func reading(_ size: CGFloat, _ weight: Weight = .regular) -> Font {
        .custom(weight == .regular ? "Involve-Regular" : "Involve-SemiBold", size: size, relativeTo: .body)
    }

    static func mono(_ size: CGFloat) -> Font {
        .custom("MartianMono-Regular", fixedSize: size)
    }
}

extension View {
    /// The small label of Hance: Martian Mono in capitals, a little spaced.
    func monoLabel(_ size: CGFloat = 11) -> some View {
        font(HanceFont.mono(size)).tracking(0.2).textCase(.uppercase)
    }
}
