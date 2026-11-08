import XCTest

@testable import Hance

/// The core's answers (apps/core/src/talk/routes.ts) as the app reads them, and the WAV it sends.
final class CoreClientTests: XCTestCase {
    func test_an_answer_at_once_with_a_call_of_the_other_one() throws {
        let json = #"{"heard":"позови Сару","talk":null,"switch":"sara","reply":{"text":"Да-да, Борь, я тут.","buttons":false}}"#
        let sent = try JSONDecoder().decode(Sent.self, from: Data(json.utf8))
        XCTAssertEqual(sent.heard, "позови Сару")
        XCTAssertNil(sent.talk)
        XCTAssertEqual(sent.switchTo, .sara)
        XCTAssertEqual(sent.reply?.text, "Да-да, Борь, я тут.")
    }

    func test_an_answer_to_wait_for() throws {
        let json = #"{"heard":"что у меня завтра","talk":"7c1f2c1e-4c55-4a1c-9c8e-0d7a2b3c4d5e","reply":null}"#
        let sent = try JSONDecoder().decode(Sent.self, from: Data(json.utf8))
        XCTAssertEqual(sent.talk, "7c1f2c1e-4c55-4a1c-9c8e-0d7a2b3c4d5e")
        XCTAssertNil(sent.reply)
        XCTAssertNil(sent.switchTo)
    }

    func test_nothing_heard() throws {
        let json = #"{"heard":null,"talk":null,"reply":{"text":"Не разобрала голосовое.","buttons":false}}"#
        let sent = try JSONDecoder().decode(Sent.self, from: Data(json.utf8))
        XCTAssertNil(sent.heard)
        XCTAssertEqual(sent.reply?.text, "Не разобрала голосовое.")
    }

    func test_the_long_wait_reads_done_and_waiting() throws {
        XCTAssertEqual(
            try TalkState.read(status: 200, body: Data(#"{"state":"done","text":"Готово.","cards":1}"#.utf8)),
            .done(text: "Готово.", cards: 1))
        XCTAssertEqual(try TalkState.read(status: 200, body: Data(#"{"state":"waiting"}"#.utf8)), .waiting)
        XCTAssertEqual(try TalkState.read(status: 404, body: Data(#"{"state":"gone"}"#.utf8)), .gone)
    }

    func test_the_sign_in_cookie_is_taken_from_the_answer_to_the_login() {
        let url = URL(string: "https://sara.hance.pro/api/login")!
        let headers = [
            "Set-Cookie": "sara_session=owner%3A1762600000000.abcDEF123; Max-Age=7776000; Path=/; HttpOnly; Secure; SameSite=Strict"
        ]
        XCTAssertEqual(SessionStore.cookie(from: headers, url: url), "owner%3A1762600000000.abcDEF123")
        XCTAssertNil(SessionStore.cookie(from: ["Set-Cookie": "other=1; Path=/"], url: url))
    }

    func test_the_streamed_wav_header_says_16_khz_mono_16_bit() {
        let h = Wav.header(dataBytes: nil)
        XCTAssertEqual(h.count, 44)
        XCTAssertEqual(String(decoding: h[0..<4], as: UTF8.self), "RIFF")
        XCTAssertEqual(String(decoding: h[8..<16], as: UTF8.self), "WAVEfmt ")
        XCTAssertEqual(h.u16(20), 1)  // PCM
        XCTAssertEqual(h.u16(22), 1)  // mono
        XCTAssertEqual(h.u32(24), 16_000)
        XCTAssertEqual(h.u32(28), 32_000)
        XCTAssertEqual(h.u16(34), 16)
        XCTAssertEqual(String(decoding: h[36..<40], as: UTF8.self), "data")
        // Still being recorded: the sizes say «a lot», ffmpeg reads to the end.
        XCTAssertEqual(h.u32(40), Wav.streamingSize)
    }

    func test_the_whole_wav_has_its_real_sizes() {
        let pcm = Data(repeating: 0, count: 3200)
        let wav = Wav.file(pcm: pcm)
        XCTAssertEqual(wav.count, 44 + 3200)
        XCTAssertEqual(wav.u32(4), 36 + 3200)
        XCTAssertEqual(wav.u32(40), 3200)
    }
}

extension Data {
    fileprivate func u16(_ at: Int) -> UInt16 { UInt16(self[at]) | UInt16(self[at + 1]) << 8 }
    fileprivate func u32(_ at: Int) -> UInt32 {
        UInt32(self[at]) | UInt32(self[at + 1]) << 8 | UInt32(self[at + 2]) << 16 | UInt32(self[at + 3]) << 24
    }
}
