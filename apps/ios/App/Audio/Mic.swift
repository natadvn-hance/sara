import AVFoundation

/// Where Boris's voice comes from: the microphone, or in a test a file played as if he spoke.
protocol VoiceSource: AnyObject {
    /// The loudness in dB of each moment, on the main thread, a few dozen times a second.
    var onLevel: ((Double) -> Void)? { get set }
    /// While set, every moment also goes here as 16 kHz mono 16-bit PCM, on the audio thread.
    func record(into sink: ((Data) -> Void)?)
    func start() throws
    func stop()
}

enum MicError: Error {
    case noInput
}

/// The audio session of a talk: recording and her voice at once, her voice on the loudspeaker (or AirPods), other
/// sound quieter meanwhile. Active for the whole talk: iOS keeps the app running in the background while it is.
enum AudioSessionControl {
    static func activate() throws {
        let s = AVAudioSession.sharedInstance()
        try s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP, .duckOthers])
        try? s.setPreferredIOBufferDuration(0.02)
        try s.setActive(true)
    }

    static func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

/// The phone's sound made into what the core's whisper reads: 16 kHz, mono, 16-bit.
final class Downsampler {
    static let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    private let converter: AVAudioConverter

    init?(from input: AVAudioFormat) {
        guard let c = AVAudioConverter(from: input, to: Self.format) else { return nil }
        c.downmix = true
        converter = c
    }

    func convert(_ input: AVAudioPCMBuffer) -> Data? {
        let ratio = Self.format.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio + 64)
        guard let out = AVAudioPCMBuffer(pcmFormat: Self.format, frameCapacity: capacity) else { return nil }
        var given = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inStatus in
            if given {
                inStatus.pointee = .noDataNow
                return nil
            }
            given = true
            inStatus.pointee = .haveData
            return input
        }
        guard status != .error, out.frameLength > 0, let p = out.int16ChannelData?[0] else { return nil }
        return Data(bytes: p, count: Int(out.frameLength) * 2)
    }

    /// The loudness of a buffer in dBFS.
    static func decibels(_ b: AVAudioPCMBuffer) -> Double {
        guard let ch = b.floatChannelData?[0], b.frameLength > 0 else { return -100 }
        var sum: Float = 0
        let n = Int(b.frameLength)
        for i in 0..<n { sum += ch[i] * ch[i] }
        let rms = (sum / Float(n)).squareRoot()
        return rms > 0 ? Double(20 * log10(rms)) : -100
    }
}

/// The microphone through AVAudioEngine: its loudness for the screen and the pause, and its sound for the core.
final class Mic: VoiceSource {
    var onLevel: ((Double) -> Void)?
    private let engine = AVAudioEngine()
    private var down: Downsampler?
    private let lock = NSLock()
    private var sink: ((Data) -> Void)?
    private var running = false

    func record(into sink: ((Data) -> Void)?) {
        lock.withLock { self.sink = sink }
    }

    func start() throws {
        guard !running else { return }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0, let down = Downsampler(from: format) else {
            throw MicError.noInput
        }
        self.down = down
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.heard(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
        running = true
    }

    func stop() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        running = false
        record(into: nil)
    }

    private func heard(_ buffer: AVAudioPCMBuffer) {
        let db = Downsampler.decibels(buffer)
        if let sink = lock.withLock({ self.sink }), let pcm = down?.convert(buffer) { sink(pcm) }
        DispatchQueue.main.async { [weak self] in self?.onLevel?(db) }
    }
}

#if DEBUG
    /// A test: `-HanceFakeVoice /path/to/question.wav` plays the file as Boris's voice once, then silence. The simulator
    /// has no one to speak into it.
    final class FakeVoice: VoiceSource {
        var onLevel: ((Double) -> Void)?
        private let url: URL
        private var timer: DispatchSourceTimer?
        private let queue = DispatchQueue(label: "pro.hance.fakevoice")
        private let lock = NSLock()
        private var sink: ((Data) -> Void)?
        private var file: AVAudioFile?
        private var down: Downsampler?
        private var played = false
        private var startedAt = Date()

        init(url: URL) { self.url = url }

        func record(into sink: ((Data) -> Void)?) {
            lock.withLock { self.sink = sink }
            if sink != nil, !played {
                played = true
                startedAt = Date()
                queue.async {
                    self.file = try? AVAudioFile(forReading: self.url)
                    self.down = self.file.flatMap { Downsampler(from: $0.processingFormat) }
                }
            }
        }

        func start() throws {
            guard timer == nil else { return }
            let t = DispatchSource.makeTimerSource(queue: queue)
            t.schedule(deadline: .now(), repeating: .milliseconds(21))
            t.setEventHandler { [weak self] in self?.tick() }
            t.resume()
            timer = t
        }

        func stop() {
            timer?.cancel()
            timer = nil
            record(into: nil)
        }

        private func tick() {
            let sink = lock.withLock { self.sink }
            var db = -70.0 + Double.random(in: -3...3)
            var pcm: Data?
            if let file, let down, Date().timeIntervalSince(startedAt) > 0.6 {
                let frames = AVAudioFrameCount(file.processingFormat.sampleRate * 0.021)
                if let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames),
                    (try? file.read(into: buf, frameCount: frames)) != nil, buf.frameLength > 0
                {
                    db = Downsampler.decibels(buf)
                    pcm = down.convert(buf)
                } else {
                    self.file = nil
                }
            }
            // 21 ms of silence at 16 kHz.
            if pcm == nil { pcm = Data(count: 672) }
            if let sink, let pcm { sink(pcm) }
            DispatchQueue.main.async { [weak self] in self?.onLevel?(db) }
        }
    }
#endif
