import Foundation

/// Her answer in pieces for her voice: the core makes a piece's sound in about the time it takes to say it, so the
/// first piece is short (the first sentence) and the next ones are made while the one before plays. A very long answer
/// is voiced up to `limit`, at the end of a sentence; the rest is on the screen.
enum SpeechChunker {
    static func split(_ text: String, first: Int = 140, rest: Int = 320, limit: Int = 1200) -> [String] {
        let sentences = within(limit, sentencesOf(text))
        var pieces: [String] = []
        var current = ""
        for s in sentences {
            if !current.isEmpty {
                let joined = current + " " + s
                // The first piece is the first sentence, joined with the next only when it is a mere «Да.».
                let fits = pieces.isEmpty ? (current.count < 25 && joined.count <= first) : joined.count <= rest
                if fits {
                    current = joined
                    continue
                }
                pieces.append(current)
                current = ""
            }
            let cap = pieces.isEmpty ? first : rest
            if s.count <= cap {
                current = s
            } else {
                var parts = cut(s, firstCap: cap, restCap: rest)
                current = parts.removeLast()
                pieces.append(contentsOf: parts)
            }
        }
        if !current.isEmpty { pieces.append(current) }
        return pieces
    }

    /// The sentences of the text: each line apart, a line cut after «.», «!», «?» or «…» followed by a space.
    static func sentencesOf(_ text: String) -> [String] {
        var out: [String] = []
        for rawLine in text.split(whereSeparator: \.isNewline) {
            let line = Array(rawLine.trimmingCharacters(in: .whitespaces))
            var current = ""
            for (i, ch) in line.enumerated() {
                current.append(ch)
                let ends = ".!?…".contains(ch)
                let nextIsSpace = i + 1 < line.count && line[i + 1].isWhitespace
                if ends && nextIsSpace {
                    let s = current.trimmingCharacters(in: .whitespaces)
                    if !s.isEmpty { out.append(s) }
                    current = ""
                }
            }
            let s = current.trimmingCharacters(in: .whitespaces)
            if !s.isEmpty { out.append(s) }
        }
        return out
    }

    /// The sentences that fit into `limit` characters said one after another; a first sentence longer than that is cut.
    private static func within(_ limit: Int, _ sentences: [String]) -> [String] {
        var out: [String] = []
        var used = 0
        for s in sentences {
            let add = (out.isEmpty ? 0 : 1) + s.count
            if used + add > limit {
                if out.isEmpty { out.append(cut(s, firstCap: limit, restCap: limit)[0]) }
                break
            }
            out.append(s)
            used += add
        }
        return out
    }

    /// A sentence too long for one piece, cut between words, after a comma when there is one past the middle.
    private static func cut(_ s: String, firstCap: Int, restCap: Int) -> [String] {
        var parts: [String] = []
        var words = s.split(separator: " ").map(String.init)
        while !words.isEmpty {
            let cap = parts.isEmpty ? firstCap : restCap
            var taken: [String] = []
            var length = 0
            var lastComma = -1
            for w in words {
                let add = (taken.isEmpty ? 0 : 1) + w.count
                if length + add > cap { break }
                taken.append(w)
                length += add
                if w.hasSuffix(",") || w.hasSuffix(";") || w.hasSuffix(":") { lastComma = taken.count }
            }
            if taken.isEmpty {
                // One word longer than the piece: cut the word itself.
                let w = words.removeFirst()
                parts.append(String(w.prefix(cap)))
                let tail = String(w.dropFirst(cap))
                if !tail.isEmpty { words.insert(tail, at: 0) }
                continue
            }
            if taken.count < words.count, lastComma > 0, taken.prefix(lastComma).joined(separator: " ").count >= cap / 2 {
                taken = Array(taken.prefix(lastComma))
            }
            parts.append(taken.joined(separator: " "))
            words.removeFirst(taken.count)
        }
        return parts
    }
}
