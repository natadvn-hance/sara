import Foundation
import os

/// The talk's log on the Mac: the system log only (Console.app, subsystem pro.hance.mac). Phases, times and errors,
/// never Boris's words. The shared core client writes to it as on the phone.
struct TalkLog: Sendable {
    private let os = Logger(subsystem: "pro.hance.mac", category: "talk")

    func notice(_ s: String) { os.notice("\(s, privacy: .public)") }
    func error(_ s: String) { os.error("\(s, privacy: .public)") }
}

let log = TalkLog()
