import AVFoundation
import Speech

/// The Mac's microphone for one turn: its loudness for the pause and the screen, and the words heard on the Mac itself
/// (Apple's Russian speech recognition, on the device when it can). The Mac has no audio session to set up.
@MainActor
final class MacMic {
    /// Loudness in dB of each moment, on the main thread.
    var onLevel: ((Double) -> Void)?

    private let engine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "ru-RU"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var best = ""
    private var over = false
    private var waiting: CheckedContinuation<String, Never>?
    private var running = false

    /// Asks for the microphone and speech recognition once; true when both are allowed.
    static func allowed() async -> Bool {
        let mic: Bool
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: mic = true
        case .notDetermined: mic = await AVCaptureDevice.requestAccess(for: .audio)
        default: mic = false
        }
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                SFSpeechRecognizer.requestAuthorization { _ in c.resume() }
            }
        }
        return mic && SFSpeechRecognizer.authorizationStatus() == .authorized
    }

    func start() throws {
        guard !running else { return }
        best = ""
        over = false
        let r = SFSpeechAudioBufferRecognitionRequest()
        r.shouldReportPartialResults = true
        r.taskHint = .dictation
        r.addsPunctuation = true
        if recognizer?.supportsOnDeviceRecognition == true { r.requiresOnDeviceRecognition = true }
        request = r
        task = recognizer?.recognitionTask(with: r) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let last = result?.isFinal == true || error != nil
            Task { @MainActor in self?.heard(text, last: last) }
        }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            r.append(buffer)
            let db = Self.decibels(buffer)
            DispatchQueue.main.async { self?.onLevel?(db) }
        }
        engine.prepare()
        try engine.start()
        running = true
    }

    /// Some words were heard already.
    var hasWords: Bool { !best.trimmingCharacters(in: .whitespaces).isEmpty }

    /// He finished: the words heard, waiting up to 1,5 s for the last of them.
    func finish() async -> String? {
        stopEngine()
        request?.endAudio()
        if !over {
            let text: String = await withCheckedContinuation { c in
                waiting = c
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .milliseconds(1500))
                    self?.answer()
                }
            }
            best = text
        }
        task?.cancel()
        let t = best.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    func cancel() {
        stopEngine()
        task?.cancel()
        request?.endAudio()
        answer()
    }

    private func stopEngine() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        running = false
    }

    private func heard(_ text: String?, last: Bool) {
        if let text { best = text }
        if last {
            over = true
            answer()
        }
    }

    private func answer() {
        let c = waiting
        waiting = nil
        c?.resume(returning: best)
    }

    nonisolated static func decibels(_ b: AVAudioPCMBuffer) -> Double {
        guard let ch = b.floatChannelData?[0], b.frameLength > 0 else { return -100 }
        var sum: Float = 0
        let n = Int(b.frameLength)
        for i in 0..<n { sum += ch[i] * ch[i] }
        let rms = (sum / Float(n)).squareRoot()
        return rms > 0 ? Double(20 * log10(rms)) : -100
    }
}
