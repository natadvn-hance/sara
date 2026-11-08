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

/// The colours of Hance as on hance.pro and in the PWA (apps/web/src/talk/talk.css): warm paper, and the colour of the
/// one who speaks. Lora is the orange of Hance, Sara is #005A52. Dark follows the phone's theme.
struct Palette: Equatable {
    let accent: Color
    let accentInk: Color
    let accentLine: Color
    let accentSoft: Color
    let bg: Color
    let paper: Color
    let ink: Color
    let ink2: Color
    let muted: Color
    let line: Color

    static func of(_ agent: HanceAgent, dark: Bool) -> Palette {
        switch (agent, dark) {
        case (.lora, false):
            return Palette(
                accent: Color(hex: 0xFF3D00), accentInk: Color(hex: 0xC42F00),
                accentLine: Color(hex: 0xFFCDB9), accentSoft: Color(hex: 0xFFF1EB),
                bg: Color(hex: 0xF3F2EF), paper: Color(hex: 0xFCFBF9), ink: Color(hex: 0x262524),
                ink2: Color(hex: 0x55514D), muted: Color(hex: 0x736E68), line: Color(hex: 0xDCD9D3))
        case (.sara, false):
            return Palette(
                accent: Color(hex: 0x005A52), accentInk: Color(hex: 0x00463F),
                accentLine: Color(hex: 0xB3D5D0), accentSoft: Color(hex: 0xE4F1EF),
                bg: Color(hex: 0xEEF2F1), paper: Color(hex: 0xFCFBF9), ink: Color(hex: 0x262524),
                ink2: Color(hex: 0x55514D), muted: Color(hex: 0x736E68), line: Color(hex: 0xDCD9D3))
        case (.lora, true):
            return Palette(
                accent: Color(hex: 0xFF4F17), accentInk: Color(hex: 0xFF8A62),
                accentLine: Color(hex: 0x5A2A1A), accentSoft: Color(hex: 0x3A2119),
                bg: Color(hex: 0x1C1B19), paper: Color(hex: 0x262523), ink: Color(hex: 0xF3F2EF),
                ink2: Color(hex: 0xCDCBC6), muted: Color(hex: 0x9D978F), line: Color(hex: 0x383633))
        case (.sara, true):
            return Palette(
                accent: Color(hex: 0x1B8A7D), accentInk: Color(hex: 0x7CCFC3),
                accentLine: Color(hex: 0x1F4A45), accentSoft: Color(hex: 0x11302C),
                bg: Color(hex: 0x151C1B), paper: Color(hex: 0x262523), ink: Color(hex: 0xF3F2EF),
                ink2: Color(hex: 0xCDCBC6), muted: Color(hex: 0x9D978F), line: Color(hex: 0x383633))
        }
    }
}

/// The type of Hance: Onest for words, Martian Mono for small uppercase labels and times (the fonts of the site,
/// made into static TTFs by tools/fonts.py).
enum HanceFont {
    enum Weight {
        case regular
        case medium
        case semibold
    }

    static func text(_ size: CGFloat, _ weight: Weight = .regular) -> Font {
        switch weight {
        case .regular: return .custom("Onest-Regular", fixedSize: size)
        case .medium: return .custom("Onest-Medium", fixedSize: size)
        case .semibold: return .custom("Onest-SemiBold", fixedSize: size)
        }
    }

    /// Onest that follows the phone's text size, for longer reading (the answer).
    static func reading(_ size: CGFloat, _ weight: Weight = .regular) -> Font {
        switch weight {
        case .regular: return .custom("Onest-Regular", size: size, relativeTo: .body)
        case .medium: return .custom("Onest-Medium", size: size, relativeTo: .body)
        case .semibold: return .custom("Onest-SemiBold", size: size, relativeTo: .body)
        }
    }

    static func mono(_ size: CGFloat, _ weight: Weight = .regular) -> Font {
        .custom(weight == .regular ? "MartianMono-Regular" : "MartianMono-Medium", fixedSize: size)
    }
}

extension View {
    /// The small uppercase label of Hance: Martian Mono, a little spaced.
    func monoLabel(_ size: CGFloat = 11, _ weight: HanceFont.Weight = .regular) -> some View {
        font(HanceFont.mono(size, weight)).tracking(0.2).textCase(.uppercase)
    }
}
