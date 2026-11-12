import AppKit
import Combine
import SwiftUI

/// Lora under the menu bar, top centre, like the island of the iPhone (Boris, 12.11: «вылезала в шапке»): black, her
/// square face, her index, name and phase, the voice as square pixels, his words or her answer below. It floats over
/// every app and Space without taking the focus from what he works in.
@MainActor
final class IslandPanel {
    private let panel: NSPanel
    private var bag: Set<AnyCancellable> = []

    init(talk: MacTalk) {
        panel = KeyPanel(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 120),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
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
        // His words or her answer make it taller: it grows downwards from under the menu bar.
        talk.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.place() }
        }.store(in: &bag)
    }

    private func place() {
        guard let view = panel.contentView, let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        let size = view.fittingSize
        let x = screen.frame.midX - size.width / 2
        let y = screen.visibleFrame.maxY - size.height - 6
        panel.setFrame(NSRect(x: x, y: y, width: size.width, height: size.height), display: true)
    }

    private func show() {
        place()
        if !panel.isVisible {
            panel.alphaValue = 0
            panel.orderFrontRegardless()
        }
        NSAnimationContext.runAnimationGroup { c in
            c.duration = 0.22
            c.timingFunction = CAMediaTimingFunction(controlPoints: 0.16, 1, 0.3, 1)
            panel.animator().alphaValue = 1
        }
    }

    private func hide() {
        NSAnimationContext.runAnimationGroup { c in
            c.duration = 0.3
            panel.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            Task { @MainActor in
                guard let self, self.panel.alphaValue == 0 else { return }
                self.panel.orderOut(nil)
            }
        }
    }
}

/// A panel that can take typing (the password) while the app he works in stays in front.
final class KeyPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

struct IslandView: View {
    @ObservedObject var talk: MacTalk

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
        .padding(16)
        .frame(width: 460, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 26, style: .continuous).fill(Color.black))
        .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(Color.white.opacity(0.09), lineWidth: 1))
        .animation(.timingCurve(0.16, 1, 0.3, 1, duration: 0.4), value: talk.phase)
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
