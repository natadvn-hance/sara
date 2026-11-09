import Foundation

/// Boris's voice goes up while he still speaks: the request to the core opens with the first sound, and its body is the
/// WAV as it is recorded. When he stops, only the last fraction of a second is left to send, and whisper starts at once.
/// If the streamed request fails (a network change, a proxy that wants the length), the whole recording is sent again
/// in one piece.
final class VoiceUpload: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let client: CoreClient
    private let agent: HanceAgent
    private let queue = DispatchQueue(label: "pro.hance.upload")
    private let output: OutputStream
    private var pending = Data()
    private var pcm = Data()
    private var finished = false
    private var closed = false
    private var dropped = false
    private var task: Task<(Data, HTTPURLResponse), Error>?

    /// Seconds of voice recorded so far.
    var seconds: Double { queue.sync { Wav.seconds(pcmBytes: pcm.count) } }

    init(client: CoreClient, agent: HanceAgent) {
        self.client = client
        self.agent = agent
        var i: InputStream?
        var o: OutputStream?
        Stream.getBoundStreams(withBufferSize: 1 << 16, inputStream: &i, outputStream: &o)
        output = o!
        super.init()
        output.open()
        pending = Wav.header(dataBytes: nil)
        var r = client.request("/api/talk?agent=\(agent.rawValue)", method: "POST", type: "audio/wav", timeout: 45)
        r.httpBodyStream = i
        let request = r
        task = Task { [client, weak self] in try await client.send(request, delegate: self) }
        queue.async { self.pump() }
    }

    /// 16 kHz mono 16-bit PCM from the microphone; any thread.
    func append(_ data: Data) {
        queue.async {
            guard !self.finished else { return }
            self.pcm.append(data)
            self.pending.append(data)
            self.pump()
        }
    }

    /// The recording is over: the rest goes up, and the core's answer comes back.
    func finish() async throws -> Sent {
        queue.sync {
            finished = true
            pump()
        }
        do {
            guard let task else { throw URLError(.cancelled) }
            let res = try await task.value
            if res.1.statusCode == 200 { return try client.decodeSent(res) }
            throw CoreError.http(res.1.statusCode, CoreClient.errorText(res.0))
        } catch CoreError.signedOut {
            throw CoreError.signedOut
        } catch {
            // No way to the core at all: sending the whole recording again would only double the wait.
            if Task.isCancelled || error.isOffline { throw error }
            let all = queue.sync { pcm }
            return try await client.sendVoice(wav: Wav.file(pcm: all), agent: agent)
        }
    }

    /// Nothing goes to the core: the request is cut first, and the stream is closed only after, so the core never
    /// gets an end of the body and never hears a half or a silence as a question.
    func cancel() {
        queue.sync {
            finished = true
            dropped = true
        }
        let t = task
        t?.cancel()
        Task { [weak self] in
            _ = await t?.result
            self?.queue.async { self?.close() }
        }
    }

    /// Writes what the stream can take now; the rest a moment later. Never blocks: a core that answered early (401)
    /// reads nothing more.
    private func pump() {
        guard !closed, !dropped else { return }
        while !pending.isEmpty && output.hasSpaceAvailable {
            let n = pending.withUnsafeBytes { buf -> Int in
                guard let p = buf.bindMemory(to: UInt8.self).baseAddress else { return 0 }
                return output.write(p, maxLength: min(buf.count, 1 << 14))
            }
            if n <= 0 { break }
            pending.removeFirst(n)
        }
        if output.streamStatus == .error || output.streamStatus == .closed {
            close()
            return
        }
        if pending.isEmpty && finished {
            close()
        } else if !pending.isEmpty {
            queue.asyncAfter(deadline: .now() + 0.02) { self.pump() }
        }
    }

    private func close() {
        guard !closed else { return }
        closed = true
        output.close()
    }

    /// A retry would need the stream from its start: refuse, and the whole recording goes again in `finish`.
    func urlSession(
        _ session: URLSession, task: URLSessionTask, needNewBodyStream completionHandler: @escaping (InputStream?) -> Void
    ) {
        completionHandler(nil)
    }
}
