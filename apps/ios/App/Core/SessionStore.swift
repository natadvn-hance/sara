import Foundation
import Security

/// The pult's sign-in (the signed cookie `sara_session`, 90 days, apps/core/src/auth/session.ts), kept in the
/// Keychain so the side button works on a locked phone after its first unlock. The password itself is never kept.
enum SessionStore {
    static let cookieName = "sara_session"
    private static let service = "pro.hance.talk"
    private static let account = "sara_session"

    /// The cookie's value from the answer to `POST /api/login`.
    static func cookie(from headers: [String: String], url: URL) -> String? {
        HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
            .first { $0.name == cookieName }?.value
    }

    static func load() -> String? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ value: String) {
        clear()
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: Data(value.utf8),
        ]
        SecItemAdd(q as CFDictionary, nil)
    }

    static func clear() {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(q as CFDictionary)
    }
}
