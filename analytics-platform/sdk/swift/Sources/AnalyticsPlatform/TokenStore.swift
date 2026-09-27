import Foundation

/// Where the user session lives between app launches. Refresh tokens rotate on every refresh, so the store is
/// written after login and after every refresh; a stale refresh token is rejected by the server.
public protocol TokenStore: Sendable {
    func load() async throws -> Tokens?
    /// Persist `tokens`, or clear the session when `nil` (logout, or a rejected refresh token).
    func save(_ tokens: Tokens?) async throws
}

/// Keeps the session in memory only (the default): the user logs in again after a restart.
public actor InMemoryTokenStore: TokenStore {
    private var tokens: Tokens?

    public init(_ tokens: Tokens? = nil) { self.tokens = tokens }

    public func load() async throws -> Tokens? { tokens }

    public func save(_ tokens: Tokens?) async throws { self.tokens = tokens }
}

#if canImport(Security)
import Security

/// Stores the session in the Keychain (`kSecClassGenericPassword`), readable after the first unlock and never
/// synced to iCloud or restored to another device.
public actor KeychainTokenStore: TokenStore {
    private let service: String
    private let account: String

    public init(service: String = "com.analyticsplatform.sdk", account: String = "session") {
        self.service = service
        self.account = account
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public func load() async throws -> Tokens? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw AnalyticsPlatformError.decoding("keychain read failed (OSStatus \(status))")
        }
        return try JSONDecoder().decode(Tokens.self, from: data)
    }

    public func save(_ tokens: Tokens?) async throws {
        SecItemDelete(query as CFDictionary)
        guard let tokens else { return }
        var q = query
        q[kSecValueData as String] = try JSONEncoder().encode(tokens)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw AnalyticsPlatformError.decoding("keychain write failed (OSStatus \(status))") }
    }
}
#endif
