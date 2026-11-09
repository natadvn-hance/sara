import XCTest

@testable import Hance

/// FR-NOTIF-5: hands-free listening, as in the PWA (logic.ts createSilence), on the microphone's decibels.
final class SilenceDetectorTests: XCTestCase {
    private func feed(_ s: inout SilenceDetector, _ db: Double, from: Double, to: Double, step: Double = 50)
        -> SilenceDetector.Step
    {
        var last = SilenceDetector.Step.listen
        var t = from
        while t <= to {
            last = s.feed(db: db, at: t)
            if last != .listen { return last }
            t += step
        }
        return last
    }

    func test_FR_NOTIF_5_ends_after_a_pause_that_follows_speech_not_before_he_starts() {
        var s = SilenceDetector(pauseMs: 1100, startWaitMs: 8000, maxMs: 60_000)
        // Quiet before the first word: still listening.
        XCTAssertEqual(feed(&s, -60, from: 0, to: 3000), .listen)
        // He speaks for a second.
        XCTAssertEqual(feed(&s, -20, from: 3050, to: 4000), .listen)
        // A short breath between words is not the end.
        XCTAssertEqual(feed(&s, -60, from: 4050, to: 4600), .listen)
        XCTAssertEqual(feed(&s, -22, from: 4650, to: 5000), .listen)
        // The pause after the last word ends it.
        XCTAssertEqual(s.feed(db: -60, at: 5050), .listen)
        XCTAssertEqual(s.feed(db: -60, at: 6000), .listen)
        XCTAssertEqual(s.feed(db: -60, at: 6150), .stop)
    }

    func test_FR_NOTIF_5_nothing_said_ends_empty_after_the_start_wait() {
        var s = SilenceDetector(pauseMs: 1100, startWaitMs: 6000, maxMs: 60_000)
        XCTAssertEqual(feed(&s, -60, from: 0, to: 5900), .listen)
        XCTAssertEqual(s.feed(db: -60, at: 6000), .nothing)
    }

    func test_FR_NOTIF_5_a_click_is_not_speech() {
        var s = SilenceDetector(pauseMs: 1100, startWaitMs: 3000, maxMs: 60_000)
        XCTAssertEqual(s.feed(db: -60, at: 0), .listen)
        // A tap on the phone, a tenth of a second loud.
        XCTAssertEqual(s.feed(db: -10, at: 50), .listen)
        XCTAssertEqual(s.feed(db: -10, at: 100), .listen)
        // Not the end of a question: there was none.
        XCTAssertEqual(feed(&s, -60, from: 150, to: 2950), .listen)
        XCTAssertEqual(s.feed(db: -60, at: 3000), .nothing)
    }

    func test_FR_NOTIF_5_never_runs_past_the_longest_recording() {
        var s = SilenceDetector(pauseMs: 1100, startWaitMs: 6000, maxMs: 10_000)
        XCTAssertEqual(feed(&s, -20, from: 0, to: 9950), .listen)
        XCTAssertEqual(s.feed(db: -20, at: 10_000), .stop)
    }

    func test_FR_NOTIF_5_a_noisy_room_raises_the_bar_for_speech() {
        var s = SilenceDetector(pauseMs: 1100, startWaitMs: 8000, maxMs: 60_000)
        // A street at -44 dB for four seconds: not speech, and the bar rises above it.
        XCTAssertEqual(feed(&s, -44, from: 0, to: 4000), .listen)
        // He speaks over it.
        XCTAssertEqual(feed(&s, -16, from: 4050, to: 5000), .listen)
        // The street again: the pause after his words ends the recording.
        XCTAssertEqual(feed(&s, -44, from: 5050, to: 7000), .stop)
    }

    func test_FR_NOTIF_5_a_long_question_is_not_cut_in_the_middle() {
        var s = SilenceDetector(pauseMs: 1100, startWaitMs: 8000, maxMs: 90_000)
        XCTAssertEqual(feed(&s, -60, from: 0, to: 500), .listen)
        // Forty seconds of speech with short breaths: still listening.
        var t = 550.0
        while t < 40_000 {
            XCTAssertEqual(feed(&s, -24, from: t, to: t + 2500), .listen)
            XCTAssertEqual(feed(&s, -58, from: t + 2550, to: t + 2900), .listen)
            t += 2950
        }
        XCTAssertEqual(feed(&s, -58, from: t, to: t + 1500), .stop)
    }

    func test_the_screen_level_maps_decibels_to_0_1() {
        XCTAssertEqual(SilenceDetector.level(db: -80), 0)
        XCTAssertEqual(SilenceDetector.level(db: -15), 1)
        XCTAssertEqual(SilenceDetector.level(db: -35), 0.5, accuracy: 0.001)
        XCTAssertEqual(SilenceDetector.level(db: 0), 1)
    }

    func test_by_default_three_quarters_of_a_second_of_quiet_ends_the_recording() {
        var s = SilenceDetector()
        var t = 0.0
        while t < 600 {
            _ = s.feed(db: -20, at: t)
            t += 20
        }
        XCTAssertEqual(s.feed(db: -70, at: t + 700), .listen)
        XCTAssertEqual(s.feed(db: -70, at: t + 760), .stop)
    }
}
