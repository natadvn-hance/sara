import ActivityKit
import Foundation

/// The talk in the Dynamic Island and on the Lock Screen: who answers and whether she listens, thinks or speaks.
/// Everything the island shows travels in the state; the app updates it on every change of phase, and a few times a
/// second while someone speaks, so the bars move with the voice.
struct TalkActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var agent: HanceAgent
        var phase: TalkPhase
        /// When this phase began: the island counts the thinking time by itself from here.
        var since: Date
        /// What Boris said while she thinks, the beginning of her answer while she speaks.
        var line: String?
        /// The loudness of the last moments, 0...1, oldest first: the bars of the island.
        var bars: [Double]

        static func quiet(_ agent: HanceAgent, _ phase: TalkPhase, line: String? = nil) -> ContentState {
            ContentState(agent: agent, phase: phase, since: Date(), line: line, bars: Array(repeating: 0.12, count: 7))
        }
    }

    var startedAt: Date
}
