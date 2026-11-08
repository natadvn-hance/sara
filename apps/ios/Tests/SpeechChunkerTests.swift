import XCTest

@testable import Hance

/// Her answer is voiced in pieces: the first one short, so the first words come as soon as possible.
final class SpeechChunkerTests: XCTestCase {
    func test_a_short_answer_is_one_piece() {
        XCTAssertEqual(SpeechChunker.split("Борь, я на связи."), ["Борь, я на связи."])
    }

    func test_the_first_piece_is_the_first_sentence() {
        let text = "Завтра у тебя две встречи. В десять Сергей из Лиги, в три созвон с Анной по сайту. Остальное свободно."
        let parts = SpeechChunker.split(text)
        XCTAssertEqual(parts.first, "Завтра у тебя две встречи.")
        XCTAssertEqual(parts.joined(separator: " "), text)
        XCTAssertGreaterThanOrEqual(parts.count, 2)
    }

    func test_a_very_short_first_sentence_goes_with_the_next() {
        let parts = SpeechChunker.split("Да. Встреча завтра в десять у Сергея. А потом созвон с Анной про новый сайт и бюджет.")
        XCTAssertEqual(parts.first, "Да. Встреча завтра в десять у Сергея.")
    }

    func test_a_long_sentence_without_stops_is_cut_at_a_comma_or_a_space() {
        let words = Array(repeating: "слово", count: 80).joined(separator: " ")
        let parts = SpeechChunker.split(words, first: 140, rest: 320)
        XCTAssertLessThanOrEqual(parts[0].count, 140)
        for p in parts.dropFirst() { XCTAssertLessThanOrEqual(p.count, 320) }
        XCTAssertEqual(parts.joined(separator: " "), words)
        XCTAssertFalse(parts.contains { $0.hasPrefix(" ") || $0.hasSuffix(" ") })
    }

    func test_the_pieces_after_the_first_gather_sentences_up_to_the_limit() {
        let s = "Это предложение примерно из сорока знаков."
        let text = Array(repeating: s, count: 12).joined(separator: " ")
        let parts = SpeechChunker.split(text, first: 140, rest: 200)
        XCTAssertEqual(parts[0], s)
        for p in parts.dropFirst() {
            XCTAssertLessThanOrEqual(p.count, 200)
            XCTAssertTrue(p.hasSuffix("."))
        }
    }

    func test_a_very_long_answer_is_voiced_up_to_the_limit_at_the_end_of_a_sentence() {
        let s = "Это предложение примерно из сорока знаков."
        let text = Array(repeating: s, count: 60).joined(separator: " ")
        let parts = SpeechChunker.split(text, limit: 500)
        let said = parts.joined(separator: " ")
        XCTAssertLessThanOrEqual(said.count, 500)
        XCTAssertTrue(said.hasSuffix("."))
    }

    func test_lines_are_boundaries_and_blank_ones_are_dropped() {
        let parts = SpeechChunker.split("Первое дело на завтра\n\n- позвонить Анне\n- отправить счёт", first: 30, rest: 60)
        XCTAssertEqual(parts.first, "Первое дело на завтра")
        XCTAssertFalse(parts.contains(""))
    }
}
