import Foundation

/// The core's answer to Boris's words (apps/core/src/talk/routes.ts, `POST /api/talk`).
struct Sent: Decodable, Equatable {
    struct Reply: Decodable, Equatable {
        let text: String
        let buttons: Bool
    }

    /// What whisper heard; null when it heard no words.
    let heard: String?
    /// The id to wait for the answer under; null when the answer came at once.
    let talk: String?
    let reply: Reply?
    /// Boris called the other one: she answers from now on.
    let switchTo: HanceAgent?

    enum CodingKeys: String, CodingKey {
        case heard
        case talk
        case reply
        case switchTo = "switch"
    }
}

/// One ask for the answer (`GET /api/talk/:id`).
enum TalkState: Equatable {
    case done(text: String, cards: Int)
    case waiting
    case gone

    static func read(status: Int, body: Data) throws -> TalkState {
        if status == 404 { return .gone }
        guard status == 200 else { throw CoreError.http(status, CoreClient.errorText(body)) }
        struct Raw: Decodable {
            let state: String
            let text: String?
            let cards: Int?
        }
        let r = try JSONDecoder().decode(Raw.self, from: body)
        switch r.state {
        case "done": return .done(text: r.text ?? "", cards: r.cards ?? 0)
        case "gone": return .gone
        default: return .waiting
        }
    }
}

enum CoreError: LocalizedError, Equatable {
    case signedOut
    case http(Int, String?)

    var errorDescription: String? {
        switch self {
        case .signedOut: return "Нужно войти в пульт."
        case .http(_, let text): return text ?? "Нет связи."
        }
    }
}

/// The core of Sara over HTTPS, at the same addresses as the PWA (ADR-028). The sign-in is the pult's cookie, sent by
/// hand from the Keychain: the app keeps no other cookies.
final class CoreClient: @unchecked Sendable {
    static let production = URL(string: "https://sara.hance.pro")!

    let base: URL
    private let lock = NSLock()
    private var cookieValue: String?
    private var current: URLSession
    /// The session of the requests: a new one when the old way to the core stopped answering (`prepare`).
    var session: URLSession { lock.withLock { current } }

    init(base: URL = CoreClient.configuredBase()) {
        self.base = base
        current = Self.makeSession()
        cookieValue = SessionStore.load()
    }

    /// What the phone thinks the way to the core is, for the log: the addresses its DNS gives (a VPN's fake 198.18.x.x
    /// only works inside its tunnel) and the interfaces now up (a utun is a VPN tunnel).
    static func wayReport(_ host: String) -> String {
        var hints = addrinfo(ai_flags: 0, ai_family: AF_UNSPEC, ai_socktype: SOCK_STREAM, ai_protocol: 0,
            ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
        var res: UnsafeMutablePointer<addrinfo>?
        var addresses: [String] = []
        if getaddrinfo(host, "443", &hints, &res) == 0 {
            var p = res
            while let a = p {
                var buf = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(a.pointee.ai_addr, a.pointee.ai_addrlen, &buf, socklen_t(buf.count), nil, 0, NI_NUMERICHOST) == 0 {
                    addresses.append(String(cString: buf))
                }
                p = a.pointee.ai_next
            }
            freeaddrinfo(res)
        }
        var interfaces: [String] = []
        var ifs: UnsafeMutablePointer<ifaddrs>?
        if getifaddrs(&ifs) == 0 {
            var p = ifs
            while let i = p {
                let name = String(cString: i.pointee.ifa_name)
                let up = (Int32(i.pointee.ifa_flags) & IFF_UP) != 0
                if up, name.hasPrefix("utun") || name.hasPrefix("en") || name.hasPrefix("pdp_ip"), !interfaces.contains(name) {
                    if i.pointee.ifa_addr?.pointee.sa_family == UInt8(AF_INET) { interfaces.append(name) }
                }
                p = i.pointee.ifa_next
            }
            freeifaddrs(ifs)
        }
        return "dns \(addresses.isEmpty ? "none" : addresses.joined(separator: ",")), up \(interfaces.joined(separator: ","))"
    }

    private static func makeSession() -> URLSession {
        let c = URLSessionConfiguration.default
        c.httpCookieAcceptPolicy = .never
        c.httpShouldSetCookies = false
        c.httpCookieStorage = nil
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 40
        c.timeoutIntervalForResource = 300
        return URLSession(configuration: c, delegate: NetLog.shared, delegateQueue: nil)
    }

    /// At the start of listening: the way to the core must answer within 2,5 s, or a new one is opened at once, while
    /// he still speaks (12.11: the open connection died as he began, and the words waited 10 s on it, then 4 s more
    /// for a new one). Then her voice is woken on the way that answers.
    /// `unreachable` is called when even a new way does not answer in 8 s: the phone does not reach the core at all
    /// (12.11 19:42, through his VPN), so he learns it at once instead of after the 40 s of a request.
    func prepare(for agent: HanceAgent, unreachable: @escaping @MainActor @Sendable () -> Void = {}) {
        var r = request("/talk", method: "HEAD", timeout: 2.5)
        r.setValue(nil, forHTTPHeaderField: "Cookie")
        let s = session
        Task.detached { [weak self] in
            do {
                _ = try await s.data(for: r)
            } catch {
                guard let self else { return }
                log.notice("the way to the core did not answer in 2.5 s: a new one")
                let fresh = Self.makeSession()
                let old: URLSession = self.lock.withLock {
                    let o = self.current
                    self.current = fresh
                    return o
                }
                old.finishTasksAndInvalidate()
                var p = self.request("/talk", method: "HEAD", timeout: 8)
                p.setValue(nil, forHTTPHeaderField: "Cookie")
                do {
                    _ = try await fresh.data(for: p)
                } catch {
                    log.notice("the core is not reachable from the phone: \(Self.wayReport(self.base.host() ?? ""))")
                    await unreachable()
                    return
                }
            }
            self?.warm(agent)
        }
    }

    /// `-HanceServer http://localhost:8787` at launch points the app at a test core (tools/mock-core.mjs).
    static func configuredBase() -> URL {
        if let s = UserDefaults.standard.string(forKey: "HanceServer"), let u = URL(string: s) { return u }
        return production
    }

    var signedIn: Bool { lock.withLock { cookieValue != nil } }

    func signOut() {
        SessionStore.clear()
        lock.withLock { cookieValue = nil }
    }

    static func errorText(_ data: Data) -> String? {
        (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
    }

    func request(_ path: String, method: String = "GET", type: String? = nil, timeout: TimeInterval = 40) -> URLRequest {
        var r = URLRequest(url: URL(string: path, relativeTo: base)!.absoluteURL)
        r.httpMethod = method
        r.timeoutInterval = timeout
        r.httpShouldHandleCookies = false
        r.cachePolicy = .reloadIgnoringLocalCacheData
        // HTTP/3 (QUIC) is tried too: where a VPN or a network drags out the TLS handshake over TCP (16 s on 12.11),
        // QUIC often gets through at once; the log says which one each request took.
        r.assumesHTTP3Capable = true
        if let type { r.setValue(type, forHTTPHeaderField: "Content-Type") }
        if let c = lock.withLock({ cookieValue }) {
            r.setValue("\(SessionStore.cookieName)=\(c)", forHTTPHeaderField: "Cookie")
        }
        return r
    }

    /// A request whose 401 means the sign-in is over.
    func send(_ r: URLRequest, delegate: URLSessionTaskDelegate? = nil) async throws -> (Data, HTTPURLResponse) {
        let (data, res) = try await session.data(for: r, delegate: delegate)
        guard let http = res as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if http.statusCode == 401 {
            signOut()
            throw CoreError.signedOut
        }
        return (data, http)
    }

    func login(password: String) async throws {
        var r = request("/api/login", method: "POST", type: "application/json")
        r.httpBody = try JSONEncoder().encode(["password": password])
        let (data, res) = try await session.data(for: r)
        guard let http = res as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard http.statusCode == 200 else {
            throw CoreError.http(http.statusCode, Self.errorText(data) ?? "Не вышло войти.")
        }
        var headers: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
            if let k = k as? String, let v = v as? String { headers[k] = v }
        }
        guard let c = SessionStore.cookie(from: headers, url: r.url!) else {
            throw CoreError.http(200, "Сервер не дал вход. Попробуй ещё раз.")
        }
        SessionStore.save(c)
        lock.withLock { cookieValue = c }
    }

    func decodeSent(_ x: (Data, HTTPURLResponse)) throws -> Sent {
        guard x.1.statusCode == 200 else { throw CoreError.http(x.1.statusCode, Self.errorText(x.0)) }
        return try JSONDecoder().decode(Sent.self, from: x.0)
    }

    func sendText(_ text: String, agent: HanceAgent) async throws -> Sent {
        var r = request("/api/talk?agent=\(agent.rawValue)", method: "POST", type: "application/json")
        r.httpBody = try JSONEncoder().encode(["text": text])
        return try decodeSent(try await send(r))
    }

    /// The whole recording at once: what is left when the streamed upload did not go through.
    func sendVoice(wav: Data, agent: HanceAgent) async throws -> Sent {
        var r = request("/api/talk?agent=\(agent.rawValue)", method: "POST", type: "audio/wav", timeout: 120)
        r.httpBody = wav
        return try decodeSent(try await send(r))
    }

    func answer(_ talk: String) async throws -> TalkState {
        let (data, res) = try await send(request("/api/talk/\(talk)", timeout: 35))
        return try TalkState.read(status: res.statusCode, body: data)
    }

    /// Her voice for these words as MP3, or nil (503: the voice service is down) and the phone says them.
    func speak(_ text: String, agent: HanceAgent) async throws -> Data? {
        var r = request("/api/talk/speak", method: "POST", type: "application/json", timeout: 60)
        r.httpBody = try JSONEncoder().encode(["text": text, "agent": agent.rawValue])
        let (data, res) = try await send(r)
        return res.statusCode == 200 && !data.isEmpty ? data : nil
    }

    /// The voice service loads its model while Boris speaks (ADR-028, point 4).
    /// Wakes her voice on the server (after PR #291 a short real synthesis): for the one who answers now only.
    func warm(_ agent: HanceAgent) {
        let r = request("/api/talk/warm?agent=\(agent.rawValue)", method: "POST", timeout: 10)
        let s = session
        Task.detached { _ = try? await s.data(for: r) }
    }

    /// Keeps the connection to the core open: the talk page's headers through Caddy, no work on the core at all.
    func ping() {
        var r = request("/talk", method: "HEAD", timeout: 10)
        r.setValue(nil, forHTTPHeaderField: "Cookie")
        let s = session
        Task.detached { _ = try? await s.data(for: r) }
    }
}

extension Error {
    /// The phone does not reach the core at all (no network, a VPN or a network that blocks the server, a timeout),
    /// as opposed to the core answering with an error.
    var isOffline: Bool {
        guard let u = self as? URLError else { return false }
        switch u.code {
        case .timedOut, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .notConnectedToInternet,
            .secureConnectionFailed, .dataNotAllowed, .internationalRoamingOff:
            return true
        default:
            return false
        }
    }
}

/// Where each request's time goes on the way, in the log (Boris, 12.11: the core answered in 8 ms, the phone waited
/// 4,6 s): a new or a reused connection, the protocol, DNS, connect, TLS, the wait for the answer, the network. The
/// path only, never what was said.
final class NetLog: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let shared = NetLog()

    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        let path = task.originalRequest?.url?.path ?? "?"
        let total = Int(metrics.taskInterval.duration * 1000)
        func ms(_ a: Date?, _ b: Date?) -> String {
            guard let a, let b else { return "-" }
            return "\(Int(b.timeIntervalSince(a) * 1000))"
        }
        for t in metrics.transactionMetrics where t.resourceFetchType == .networkLoad {
            let net = (t.isCellular ? "cell" : "wifi") + (t.remoteAddress.map { " " + $0 } ?? "")
            log.notice(
                "net \(path) \(total) ms: \(t.networkProtocolName ?? "?") \(t.isReusedConnection ? "reused" : "new"), dns \(ms(t.domainLookupStartDate, t.domainLookupEndDate)) connect \(ms(t.connectStartDate, t.connectEndDate)) tls \(ms(t.secureConnectionStartDate, t.secureConnectionEndDate)) wait \(ms(t.requestEndDate, t.responseStartDate)) body \(ms(t.responseStartDate, t.responseEndDate)), \(net)\(t.isExpensive ? " expensive" : "")\(t.isConstrained ? " constrained" : "")\(t.isProxyConnection ? " proxy" : "")"
            )
        }
    }
}
