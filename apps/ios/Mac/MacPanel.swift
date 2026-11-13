import AppKit
import Combine
import SwiftUI

/// Lora grows out of the MacBook's notch (Boris, 12.11: «органическим дополнением самой чёлки, типо приклеенной»): a
/// black island flush with the top of the screen, with the notch's concave shoulders where it meets the menu bar,
/// opening down and out from the notch itself and folding back into it. On a screen without a notch it hangs from the
/// top centre the same way. It floats over every app and Space without taking the focus from what he works in.
@MainActor
final class IslandPanel {
    private let panel: NSPanel
    private var bag: Set<AnyCancellable> = []
    private var away: DispatchWorkItem?

    init(talk: MacTalk) {
        panel = KeyPanel(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 140),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        // Above the menu bar, so it joins the notch.
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.contentView = NSHostingView(rootView: IslandView(talk: talk))
        talk.$shown.removeDuplicates().sink { [weak self] on in
            DispatchQueue.main.async { on ? self?.show() : self?.hide() }
        }.store(in: &bag)
        // Not signed in: the panel takes the keyboard for the password, without bringing Hance to the front.
        talk.$signedIn.combineLatest(talk.$shown).sink { [weak self] signedIn, shown in
            DispatchQueue.main.async {
                guard let self else { return }
                if shown && !signedIn { self.panel.makeKey() } else if self.panel.isKeyWindow { self.panel.resignKey() }
            }
        }.store(in: &bag)
        // His words or her answer make it taller: it grows downwards.
        talk.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.place() }
        }.store(in: &bag)
    }

    private func place() {
        guard let view = panel.contentView else { return }
        let screen = Notch.screen
        Notch.shared.measure(screen)
        let size = view.fittingSize
        let x = screen.frame.midX - size.width / 2
        let y = screen.frame.maxY - size.height
        panel.setFrame(NSRect(x: x, y: y, width: size.width, height: size.height), display: true)
    }

    private func show() {
        away?.cancel()
        place()
        panel.alphaValue = 1
        panel.orderFrontRegardless()
    }

    /// The island folds back into the notch first, then the window goes.
    private func hide() {
        let work = DispatchWorkItem { [weak self] in self?.panel.orderOut(nil) }
        away = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45, execute: work)
    }
}

/// The notch of the screen Lora comes out of: its width and height in points (the menu bar's height without one).
@MainActor
final class Notch: ObservableObject {
    static let shared = Notch()
    @Published private(set) var width: CGFloat = 200
    @Published private(set) var height: CGFloat = 32

    /// The built-in screen with the notch when there is one, else the main screen.
    static var screen: NSScreen {
        NSScreen.screens.first { $0.safeAreaInsets.top > 0 } ?? NSScreen.main ?? NSScreen.screens[0]
    }

    func measure(_ screen: NSScreen) {
        if screen.safeAreaInsets.top > 0, let l = screen.auxiliaryTopLeftArea, let r = screen.auxiliaryTopRightArea {
            width = screen.frame.width - l.width - r.width
            height = screen.safeAreaInsets.top
        } else {
            width = 200
            height = NSStatusBar.system.thickness
        }
    }
}

/// The outline of the notch grown big: a straight band as tall as the menu bar (it merges with the dark bar and the
/// notch), then, where its sides meet the bottom of the menu bar, a soft concave fillet into the island's sides (Boris,
/// 12.11: «обратное скругление, где край касается верха»), and round corners below.
struct NotchShape: Shape {
    /// The menu bar's height: the band above the fillets.
    var band: CGFloat
    var fillet: CGFloat = 10
    var corner: CGFloat = 26

    func path(in r: CGRect) -> Path {
        let f = min(fillet, r.width / 4)
        // Folded into the notch: no room below the band, a plain block.
        guard r.height > band + f + 2 else { return Path(r) }
        let b = min(corner, (r.height - band - f) / 2, r.width / 4)
        let top = r.minY + band
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: top))
        p.addQuadCurve(to: CGPoint(x: r.maxX - f, y: top + f), control: CGPoint(x: r.maxX - f, y: top))
        p.addLine(to: CGPoint(x: r.maxX - f, y: r.maxY - b))
        p.addQuadCurve(to: CGPoint(x: r.maxX - f - b, y: r.maxY), control: CGPoint(x: r.maxX - f, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX + f + b, y: r.maxY))
        p.addQuadCurve(to: CGPoint(x: r.minX + f, y: r.maxY - b), control: CGPoint(x: r.minX + f, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX + f, y: top + f))
        p.addQuadCurve(to: CGPoint(x: r.minX, y: top), control: CGPoint(x: r.minX + f, y: top))
        p.closeSubpath()
        return p
    }
}

/// A panel that can take typing (the password) and may stand over the menu bar, where the notch is.
final class KeyPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

struct IslandView: View {
    @ObservedObject var talk: MacTalk
    @ObservedObject private var notch = Notch.shared
    @State private var open = false

    var body: some View {
        let p = Palette.of(talk.agent, dark: true)
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 14) {
                SquareFace(agent: talk.agent, size: 64, radius: 16, busy: talk.phase == .listening)
                    .onTapGesture { talk.press() }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(talk.agent.index).foregroundStyle(p.accentInk)
                        Text(talk.agent.role).foregroundStyle(.white.opacity(0.5))
                    }
                    .monoLabel(9)
                    Text(talk.agent.name)
                        .font(HanceFont.text(26, .semibold))
                        .tracking(-0.8)
                        .foregroundStyle(.white)
                    HStack(spacing: 6) {
                        Rectangle()
                            .fill(talk.phase.isBusy ? p.accent : Color.white.opacity(0.4))
                            .frame(width: 5, height: 5)
                        Text(talk.phase.label)
                            .monoLabel(9.5)
                            .foregroundStyle(talk.phase.isBusy ? p.accentInk : Color.white.opacity(0.55))
                    }
                }
                Spacer(minLength: 12)
                MacPixels(talk: talk, palette: p)
                    .frame(width: 150, height: 34)
            }
            if !talk.signedIn {
                SignInRow(talk: talk, palette: p)
            } else if talk.phase == .listening {
                Text("Говори. ъ + ё, когда закончишь")
                    .monoLabel(9.5)
                    .foregroundStyle(.white.opacity(0.55))
            } else if let note = talk.note {
                Text(note)
                    .font(HanceFont.text(14))
                    .foregroundStyle(p.accentInk)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let line = talk.line {
                Text(line)
                    .font(HanceFont.text(15))
                    .foregroundStyle(.white.opacity(0.88))
                    .lineLimit(5)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .opacity(open ? 1 : 0)
        // Below the camera: the top strip is the notch itself.
        .padding(.top, notch.height + 10)
        .padding(.horizontal, 26)
        .padding(.bottom, 18)
        .frame(width: 500, alignment: .leading)
        .background(Color.black)
        .mask {
            NotchShape(band: notch.height)
                .frame(width: open ? nil : notch.width, height: open ? nil : notch.height)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .onChange(of: talk.shown) { _, on in unfold(on) }
        .onAppear { unfold(talk.shown) }
    }

    private func unfold(_ on: Bool) {
        withAnimation(on ? .spring(response: 0.45, dampingFraction: 0.8) : .timingCurve(0.76, 0, 0.24, 1, duration: 0.4)) {
            open = on
        }
    }
}

/// The voice as square pixels, as on the phone: his voice as columns from the bottom, hers from the middle, a
/// scanning column while the words go up, stepped flicker while she thinks, the knight at rest.
struct MacPixels: View {
    @ObservedObject var talk: MacTalk
    let palette: Palette
    @State private var tape = Tape()

    final class Tape {
        var cols: [Double] = []
        var last: Double = 0
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            Canvas { ctx, size in
                let rows = 4
                let gap: CGFloat = 2
                let cell = (size.height - CGFloat(rows - 1) * gap) / CGFloat(rows)
                let cols = max(1, Int((size.width + gap) / (cell + gap)))
                if tape.cols.count != cols { tape.cols = Array(repeating: 0, count: cols) }
                let voice = talk.phase == .listening || talk.phase == .speaking
                if t - tape.last >= 0.05 {
                    tape.last = t
                    tape.cols.removeFirst()
                    tape.cols.append(voice ? talk.level : 0)
                }
                func dot(_ c: Int, _ r: Int, _ color: Color, _ o: Double = 1) {
                    let rect = CGRect(x: CGFloat(c) * (cell + gap), y: CGFloat(r) * (cell + gap), width: cell, height: cell)
                    ctx.fill(Path(rect), with: .color(color.opacity(o)))
                }
                for c in 0..<cols { for r in 0..<rows { dot(c, r, .white, 0.1) } }
                switch talk.phase {
                case .listening, .speaking:
                    for c in 0..<cols {
                        let h = Int((min(1, tape.cols[c] * 1.3) * Double(rows)).rounded(.up))
                        for k in 0..<h {
                            let r = talk.phase == .speaking ? (rows - h) / 2 + k : rows - 1 - k
                            if r >= 0 && r < rows { dot(c, r, palette.accent) }
                        }
                    }
                case .sending:
                    let head = Int(t / 0.04) % (cols + 6)
                    for (k, o) in [1.0, 0.5, 0.2].enumerated() where head - k >= 0 && head - k < cols {
                        for r in 0..<rows { dot(head - k, r, palette.accent, o) }
                    }
                case .thinking:
                    let frame = Int(t / 0.11)
                    for c in 0..<cols {
                        for r in 0..<rows {
                            var h = UInt64(truncatingIfNeeded: c &* 73_856_093 ^ r &* 19_349_663 ^ frame &* 83_492_791)
                            h ^= h >> 33
                            h = h &* 0xff51_afd7_ed55_8ccd
                            h ^= h >> 33
                            if h % 100 < 22 { dot(c, r, palette.accent, h % 100 < 9 ? 1 : 0.5) }
                        }
                    }
                default:
                    let s = Int(t / 0.8)
                    let c = (s * 2) % cols
                    let r = 2 - (s % 2) * 2
                    dot(c, r, palette.accent)
                    dot(c, r + 1, palette.accent)
                    dot((c + 1) % cols, r, palette.accent)
                }
            }
        }
    }
}

/// The pult's password right in the panel, as the first sign-in on the iPhone: Enter signs in, and the next ъ+ё talks.
struct SignInRow: View {
    @ObservedObject var talk: MacTalk
    let palette: Palette
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Войди паролем пульта, тем же, что в приложении на iPhone")
                .font(HanceFont.text(13))
                .foregroundStyle(.white.opacity(0.7))
            HStack(spacing: 8) {
                SecureField("Пароль пульта", text: $password)
                    .textFieldStyle(.plain)
                    .font(HanceFont.text(15))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .frame(height: 36)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(0.1)))
                    .focused($focused)
                    .onSubmit { signIn() }
                Button(action: signIn) {
                    Text(busy ? "Вхожу…" : "Войти")
                        .font(HanceFont.text(14, .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .frame(height: 36)
                        .background(Capsule().fill(palette.accent))
                }
                .buttonStyle(.plain)
                .disabled(password.isEmpty || busy)
            }
            if let error {
                Text(error).font(HanceFont.text(13)).foregroundStyle(palette.accentInk)
            }
        }
        .onAppear { focused = true }
    }

    private func signIn() {
        guard !password.isEmpty, !busy else { return }
        busy = true
        error = nil
        Task {
            do {
                try await talk.login(password: password)
                password = ""
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? "Не вышло войти."
            }
            busy = false
        }
    }
}
