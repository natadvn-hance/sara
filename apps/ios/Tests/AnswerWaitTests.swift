import XCTest

@testable import Hance

/// FR-NOTIF-5: the answer is asked for again and again (each ask waits up to 25 seconds in the core), as in the PWA
/// (logic.ts waitForAnswer).
final class AnswerWaitTests: XCTestCase {
    private struct SignedOutError: Error {}

    func test_FR_NOTIF_5_asks_until_the_answer_comes() async throws {
        var replies: [TalkState] = [.waiting, .waiting, .done(text: "Готово.", cards: 0)]
        var asked = 0
        let r = try await AnswerWait.wait(talk: "t1") { id in
            XCTAssertEqual(id, "t1")
            asked += 1
            return replies.removeFirst()
        }
        XCTAssertEqual(r, .done(text: "Готово.", cards: 0))
        XCTAssertEqual(asked, 3)
    }

    func test_FR_NOTIF_5_a_lost_answer_and_a_late_one() async throws {
        let gone = try await AnswerWait.wait(talk: "t2") { _ in .gone }
        XCTAssertEqual(gone, .gone)
        var now = Date(timeIntervalSince1970: 0)
        let late = try await AnswerWait.wait(
            talk: "t3", deadline: 1,
            now: {
                now = now.addingTimeInterval(0.4)
                return now
            },
            ask: { _ in .waiting })
        XCTAssertEqual(late, .late)
    }

    func test_FR_NOTIF_5_a_failed_ask_is_asked_again_after_a_pause() async throws {
        var pauses: [Double] = []
        var calls = 0
        let r = try await AnswerWait.wait(
            talk: "t4",
            pause: { pauses.append($0) },
            ask: { _ in
                calls += 1
                if calls < 3 { throw URLError(.networkConnectionLost) }
                return .done(text: "Есть.", cards: 0)
            })
        XCTAssertEqual(r, .done(text: "Есть.", cards: 0))
        XCTAssertEqual(pauses, [1, 2])
    }

    func test_FR_NOTIF_5_signed_out_stops_the_wait() async {
        do {
            _ = try await AnswerWait.wait(
                talk: "t5", isFatal: { $0 is SignedOutError }, pause: { _ in },
                ask: { _ in throw SignedOutError() })
            XCTFail("signed out should stop the wait")
        } catch {
            XCTAssertTrue(error is SignedOutError)
        }
    }
}
