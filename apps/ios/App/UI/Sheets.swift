import SwiftUI

/// Sign-in with the pult's password, typed by Boris himself; the app keeps only the sign-in, not the password.
struct LoginView: View {
    @EnvironmentObject private var engine: TalkEngine
    @Environment(\.colorScheme) private var scheme
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false
    @FocusState private var focused: Bool

    private var palette: Palette { .of(.lora, dark: scheme == .dark) }

    var body: some View {
        ZStack {
            palette.bg.ignoresSafeArea()
            VStack(spacing: 18) {
                Spacer()
                KnightMark()
                    .fill(palette.accent)
                    .frame(width: 64, height: 64)
                    .knightHop(trigger: busy, step: 8)
                Wordmark()
                    .fill(palette.ink)
                    .frame(width: 150, height: 38)
                Text("Голос Лоры и Сары")
                    .monoLabel(11)
                    .foregroundStyle(palette.muted)
                    .padding(.bottom, 18)
                SecureField("Пароль пульта", text: $password)
                    .textContentType(.password)
                    .font(HanceFont.text(18))
                    .padding(.horizontal, 20)
                    .frame(height: 56)
                    .background(Capsule().fill(palette.paper))
                    .overlay(Capsule().stroke(focused ? palette.accent : palette.line, lineWidth: focused ? 1.5 : 0.75))
                    .focused($focused)
                    .submitLabel(.go)
                    .onSubmit(signIn)
                if let error {
                    Text(error)
                        .font(HanceFont.text(14, .medium))
                        .foregroundStyle(palette.accentInk)
                }
                Button(action: signIn) {
                    ZStack {
                        if busy {
                            ProgressView().tint(.white)
                        } else {
                            Text("Войти").font(HanceFont.text(18, .semibold))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 56)
                    .background(Capsule().fill(palette.accent))
                    .foregroundStyle(.white)
                }
                .disabled(password.isEmpty || busy)
                .opacity(password.isEmpty ? 0.55 : 1)
                Text("Тот же пароль, что у пульта sara.hance.pro. Вход держится 90 дней.")
                    .font(HanceFont.text(13))
                    .foregroundStyle(palette.muted)
                    .multilineTextAlignment(.center)
                    .padding(.top, 4)
                Spacer()
                Spacer()
            }
            .padding(.horizontal, 28)
        }
        .foregroundStyle(palette.ink)
    }

    private func signIn() {
        guard !password.isEmpty, !busy else { return }
        busy = true
        error = nil
        Task {
            do {
                try await engine.login(password: password)
                password = ""
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? TalkEngine.notes.failed
            }
            busy = false
        }
    }
}

/// Writing instead of speaking, for a place where speaking is not right.
struct TypeSheet: View {
    let agent: HanceAgent
    let palette: Palette
    let send: (String) -> Void
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Написать \(agent.dative)")
                .monoLabel(11)
                .foregroundStyle(palette.muted)
            HStack(spacing: 10) {
                TextField("Что спросить", text: $text, axis: .vertical)
                    .font(HanceFont.text(18))
                    .lineLimit(1...4)
                    .focused($focused)
                    .submitLabel(.send)
                    .onSubmit { if !text.isEmpty { send(text) } }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(palette.paper))
                    .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(palette.line, lineWidth: 0.75))
                Button {
                    send(text)
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 18, weight: .bold))
                        .frame(width: 48, height: 48)
                        .background(Circle().fill(palette.accent))
                        .foregroundStyle(.white)
                }
                .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityLabel("Отправить")
            }
        }
        .padding(20)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(palette.bg)
        .foregroundStyle(palette.ink)
        .onAppear { focused = true }
    }
}

/// Where the time went in the last questions: what the app can cut, and what is the core's.
struct TimingsSheet: View {
    @EnvironmentObject private var engine: TalkEngine
    let palette: Palette

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if engine.timings.isEmpty {
                        Text("Пока пусто. Спроси Лору или Сару, и здесь появится, сколько заняла каждая часть.")
                            .font(HanceFont.text(15))
                            .foregroundStyle(palette.muted)
                    }
                    ForEach(engine.timings) { t in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(t.agent.name).font(HanceFont.text(15, .semibold))
                                Text(t.at.formatted(date: .omitted, time: .shortened))
                                    .monoLabel(10)
                                    .foregroundStyle(palette.muted)
                                Spacer()
                                Text("до голоса \(sec(t.total))")
                                    .font(HanceFont.mono(12, .medium))
                                    .foregroundStyle(palette.accentInk)
                            }
                            Text(parts(t))
                                .font(HanceFont.mono(11))
                                .foregroundStyle(palette.ink2)
                        }
                        .padding(.vertical, 4)
                    }
                } footer: {
                    Text(
                        "«Пауза» это тишина, по которой приложение понимает, что ты договорил. «Распознала» это хвост загрузки и распознавание на сервере. «Думала» это сама Лора или Сара. «Голос» это синтез на сервере и загрузка первого куска."
                    )
                    .font(HanceFont.text(12))
                }
                Section {
                    LabeledContent("Сервер", value: engine.client.base.host() ?? "")
                    Button("Выйти", role: .destructive) { engine.signOut() }
                }
            }
            .navigationTitle("Замеры")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func sec(_ ms: Int?) -> String {
        guard let ms else { return "-" }
        return String(format: "%.1f с", Double(ms) / 1000).replacingOccurrences(of: ".", with: ",")
    }

    private func parts(_ t: TurnTimings) -> String {
        var out: [String] = []
        if let s = t.spoke { out.append("говорил \(sec(Int(s * 1000)))") }
        if t.pause != nil { out.append("пауза \(sec(t.pause))") }
        out.append("распознала \(sec(t.heard))")
        out.append("думала \(sec(t.answer))")
        out.append("голос \(sec(t.voiceReady))\(t.phoneVoice ? " (голос телефона)" : "")")
        return out.joined(separator: " · ")
    }
}
