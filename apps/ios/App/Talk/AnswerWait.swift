import Foundation

enum AnswerOutcome: Equatable {
    case done(text: String, cards: Int)
    case gone
    case late
}

/// Asks the core for the answer until it comes, as the PWA does (logic.ts waitForAnswer): each ask waits there up to 25
/// seconds; a Secretary's turn lasts up to four minutes, so the app gives up only after `deadline`. A failed ask (the
/// phone changed networks, a deploy) is asked again after a pause; only what `isFatal` names (signed out) stops it.
enum AnswerWait {
    static func wait(
        talk: String,
        deadline: TimeInterval = 360,
        now: () -> Date = Date.init,
        isFatal: (Error) -> Bool = { _ in false },
        pause: (Double) async -> Void = { s in try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) },
        ask: (String) async throws -> TalkState
    ) async throws -> AnswerOutcome {
        let until = now().addingTimeInterval(deadline)
        var failures = 0
        while now() < until {
            try Task.checkCancellation()
            do {
                let r = try await ask(talk)
                failures = 0
                switch r {
                case .done(let text, let cards): return .done(text: text, cards: cards)
                case .gone: return .gone
                case .waiting: continue
                }
            } catch {
                if Task.isCancelled || error is CancellationError || isFatal(error) { throw error }
                failures += 1
                await pause(min(10, pow(2, Double(min(failures - 1, 4)))))
            }
        }
        return .late
    }
}
