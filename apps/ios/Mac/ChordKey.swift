import AppKit
import Carbon
import CoreGraphics

/// Two plain keys pressed together, ] and \ (ъ and ё in Boris's Russian layout, the same keys whatever the layout), call
/// Lora from any app (Boris, 12.11). A key of the pair is held back a moment: if its partner comes within 90 ms, both
/// are swallowed and Lora comes; if not, the key goes on as typed. Watching the keyboard needs the Accessibility
/// permission, asked for once.
final class ChordKey {
    static let first = CGKeyCode(kVK_ANSI_RightBracket)
    static let second = CGKeyCode(kVK_ANSI_Backslash)
    /// Marks the keys this class lets go later, so it does not catch them again.
    private static let replayMark: Int64 = 0x4841_4E43

    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var held: (code: CGKeyCode, down: CGEvent)?
    private var release: DispatchWorkItem?
    /// Both keys of a chord are down: their key-ups are swallowed too.
    private var inChord: Set<CGKeyCode> = []
    private let action: () -> Void

    init(action: @escaping () -> Void) {
        self.action = action
        arm()
    }

    /// Whether the Mac lets Hance watch the keyboard; asks once with the system's own prompt.
    static func allowed(prompt: Bool) -> Bool {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
    }

    /// Starts watching when allowed; asks for the permission and tries again every few seconds until it is given.
    func arm() {
        guard tap == nil else { return }
        guard Self.allowed(prompt: true) else {
            log.notice("chord ъ+ё: waiting for the Accessibility permission")
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.armQuietly() }
            return
        }
        start()
    }

    private func armQuietly() {
        guard tap == nil else { return }
        if Self.allowed(prompt: false) {
            start()
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.armQuietly() }
        }
    }

    private func start() {
        let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
        let me = Unmanaged.passUnretained(self).toOpaque()
        guard
            let t = CGEvent.tapCreate(
                tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                eventsOfInterest: CGEventMask(mask),
                callback: { _, type, event, info in
                    guard let info else { return Unmanaged.passUnretained(event) }
                    let me = Unmanaged<ChordKey>.fromOpaque(info).takeUnretainedValue()
                    return me.handle(type, event)
                }, userInfo: me)
        else {
            log.notice("chord ъ+ё: the keyboard tap was refused")
            return
        }
        tap = t
        source = CFMachPortCreateRunLoopSource(nil, t, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: t, enable: true)
        log.notice("chord ъ+ё: armed")
    }

    private func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        if event.getIntegerValueField(.eventSourceUserData) == Self.replayMark { return Unmanaged.passUnretained(event) }
        let code = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
        guard code == Self.first || code == Self.second else {
            // Another key while one of the pair is held back: both go on, in the order he typed them.
            if type == .keyDown, held != nil {
                letGo()
                replay(event)
                return nil
            }
            return Unmanaged.passUnretained(event)
        }
        // With ⌘, ⌥ or ⌃ it is a shortcut of the app in front, not the chord.
        let flags = event.flags.intersection([.maskCommand, .maskAlternate, .maskControl])
        guard flags.isEmpty else { return Unmanaged.passUnretained(event) }

        if type == .keyUp {
            if inChord.contains(code) {
                inChord.remove(code)
                return nil
            }
            if let h = held, h.code == code {
                // A quick tap of one key: it goes on as typed, the down first, then this up.
                letGo()
                replay(event)
                return nil
            }
            return Unmanaged.passUnretained(event)
        }

        // A key down.
        if event.getIntegerValueField(.keyboardEventAutorepeat) != 0 {
            return inChord.contains(code) ? nil : Unmanaged.passUnretained(event)
        }
        if let h = held, h.code != code {
            // Its partner within 90 ms: the chord. Neither key is typed.
            release?.cancel()
            release = nil
            held = nil
            inChord = [h.code, code]
            DispatchQueue.main.async { self.action() }
            return nil
        }
        if held != nil { letGo() }
        guard let copy = event.copy() else { return Unmanaged.passUnretained(event) }
        held = (code, copy)
        let work = DispatchWorkItem { [weak self] in self?.letGo() }
        release = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.09, execute: work)
        return nil
    }

    /// The held key was not a chord after all: it is typed now.
    private func letGo() {
        release?.cancel()
        release = nil
        guard let h = held else { return }
        held = nil
        replay(h.down)
    }

    private func replay(_ event: CGEvent) {
        guard let e = event.copy() else { return }
        e.setIntegerValueField(.eventSourceUserData, value: Self.replayMark)
        e.post(tap: .cgSessionEventTap)
    }
}
