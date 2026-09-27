import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Sends one HTTP request. `URLSessionTransport` is the default; tests and apps with custom networking
/// (certificate pinning, instrumentation) can supply their own.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport, @unchecked Sendable {
    public let session: URLSession

    public init(session: URLSession = URLSession(configuration: .ephemeral)) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            let task = session.dataTask(with: request) { data, response, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let http = response as? HTTPURLResponse {
                    continuation.resume(returning: (data ?? Data(), http))
                } else {
                    continuation.resume(throwing: URLError(.badServerResponse))
                }
            }
            task.resume()
        }
    }
}

/// Client configuration. Only `baseURL` is required.
public struct ClientConfiguration: Sendable {
    public var baseURL: URL
    /// An API key (`ap_live_…`), sent as `X-API-Key`. Takes precedence over user tokens.
    public var apiKey: String?
    /// Where user tokens are kept; rotated refresh tokens are written back here.
    public var tokenStore: TokenStore
    /// Retries after the first attempt for retryable failures.
    public var maxRetries: Int
    public var retryBaseDelay: TimeInterval
    /// Upper bound for one backoff or `Retry-After` wait.
    public var maxRetryDelay: TimeInterval
    /// Per-request timeout.
    public var timeout: TimeInterval
    public var transport: HTTPTransport
    public var userAgent: String
    /// How the client waits between retries and job polls (tests replace it).
    public var sleep: @Sendable (TimeInterval) async throws -> Void

    public init(
        baseURL: URL,
        apiKey: String? = nil,
        tokenStore: TokenStore = InMemoryTokenStore(),
        maxRetries: Int = 3,
        retryBaseDelay: TimeInterval = 0.5,
        maxRetryDelay: TimeInterval = 30,
        timeout: TimeInterval = 60,
        transport: HTTPTransport = URLSessionTransport(),
        userAgent: String = "analytics-platform-swift/0.1.0",
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }
    ) {
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.tokenStore = tokenStore
        self.maxRetries = maxRetries
        self.retryBaseDelay = retryBaseDelay
        self.maxRetryDelay = maxRetryDelay
        self.timeout = timeout
        self.transport = transport
        self.userAgent = userAgent
        self.sleep = sleep
    }
}

/// Serializes token refreshes: refresh tokens are single use, so concurrent 401s must share one refresh.
actor SessionCoordinator {
    private var inFlight: Task<Tokens, Error>?

    func refresh(staleAccessToken: String?, store: TokenStore, perform: @escaping @Sendable (Tokens) async throws -> Tokens) async throws -> Tokens {
        if let inFlight { return try await inFlight.value }
        // Create the task before any suspension point so concurrent callers find it.
        let task = Task { () async throws -> Tokens in
            guard let current = try await store.load() else {
                throw AnalyticsPlatformError.authentication(
                    APIErrorInfo(status: 401, code: "not_logged_in", message: "not logged in", detail: nil, method: "POST", path: "/v1/auth/refresh"))
            }
            // Someone else already refreshed while the failed request was in flight.
            if let stale = staleAccessToken, current.accessToken != stale { return current }
            return try await perform(current)
        }
        inFlight = task
        defer { inFlight = nil }
        return try await task.value
    }
}

struct Transport: Sendable {
    let config: ClientConfiguration
    let session = SessionCoordinator()

    static let idempotentMethods: Set<String> = ["GET", "PUT", "DELETE", "HEAD"]
    static let retryable: Set<Int> = [408, 429, 500, 502, 503, 504]
    static let retryableUnsafe: Set<Int> = [429, 503]

    func url(_ path: String, query: [String: String?] = [:]) -> URL {
        var components = URLComponents(url: config.baseURL, resolvingAgainstBaseURL: false)!
        // `path` is already percent-encoded (segments go through `seg`).
        let base = components.percentEncodedPath.hasSuffix("/") ? String(components.percentEncodedPath.dropLast()) : components.percentEncodedPath
        components.percentEncodedPath = base + (path.hasPrefix("/") ? path : "/" + path)
        let items = query.compactMap { key, value in value.map { URLQueryItem(name: key, value: $0) } }.sorted { $0.name < $1.name }
        components.queryItems = items.isEmpty ? nil : items
        return components.url!
    }

    /// Send a request with auth, token refresh and retries; returns the body of a 2xx response.
    ///
    /// `idempotent` requests are retried on 408/429/5xx, timeouts and connection errors; others only on 429/503
    /// (the server did not process them) and when the connection could not be established.
    func send(
        _ method: String,
        _ path: String,
        query: [String: String?] = [:],
        body: Data? = nil,
        contentType: String? = nil,
        idempotent: Bool? = nil,
        auth: Bool = true,
        accept: String = "application/json"
    ) async throws -> (Data, HTTPURLResponse) {
        let idempotent = idempotent ?? Self.idempotentMethods.contains(method)
        let target = url(path, query: query)
        var attempt = 0
        var refreshed = false
        while true {
            try Task.checkCancellation()
            var request = URLRequest(url: target, timeoutInterval: config.timeout)
            request.httpMethod = method
            request.httpBody = body
            request.setValue(accept, forHTTPHeaderField: "Accept")
            request.setValue(config.userAgent, forHTTPHeaderField: "User-Agent")
            if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
            var sentToken: String?
            if auth {
                if let key = config.apiKey, !key.isEmpty {
                    request.setValue(key, forHTTPHeaderField: "X-API-Key")
                } else if let tokens = try await config.tokenStore.load() {
                    sentToken = tokens.accessToken
                    request.setValue("Bearer \(tokens.accessToken)", forHTTPHeaderField: "Authorization")
                }
            }

            let data: Data
            let response: HTTPURLResponse
            do {
                (data, response) = try await config.transport.send(request)
            } catch let error as URLError {
                let nothingSent = [.cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .notConnectedToInternet].contains(error.code)
                if (nothingSent || idempotent) && attempt < config.maxRetries {
                    try await config.sleep(backoff(attempt))
                    attempt += 1
                    continue
                }
                if error.code == .timedOut { throw AnalyticsPlatformError.timeout("\(method) \(path) timed out") }
                throw AnalyticsPlatformError.network("\(method) \(path) failed: \(error.localizedDescription)")
            }

            let status = response.statusCode
            if (200..<300).contains(status) { return (data, response) }

            if status == 401, auth, config.apiKey?.isEmpty ?? true, !refreshed, let sentToken {
                refreshed = true
                _ = try await refreshTokens(staleAccessToken: sentToken)
                continue
            }

            let canRetry = idempotent ? Self.retryable.contains(status) : Self.retryableUnsafe.contains(status)
            let retryAfter = Self.parseRetryAfter(response.value(forHTTPHeaderField: "Retry-After"))
            if canRetry && attempt < config.maxRetries {
                try await config.sleep(retryAfter.map { min($0, config.maxRetryDelay) } ?? backoff(attempt))
                attempt += 1
                continue
            }
            let parsed = try? JSONDecoder().decode(JSONValue.self, from: data)
            let detail = parsed?["detail"] ?? parsed ?? (data.isEmpty ? nil : .string(String(decoding: data, as: UTF8.self)))
            throw AnalyticsPlatformError.from(status: status, detail: detail, method: method, path: path, retryAfter: retryAfter)
        }
    }

    func json<T: Decodable>(
        _ type: T.Type, _ method: String, _ path: String, query: [String: String?] = [:], body: JSONValue? = nil,
        idempotent: Bool? = nil, auth: Bool = true
    ) async throws -> T {
        let payload = try body.map { try JSONEncoder().encode($0) }
        let (data, _) = try await send(method, path, query: query, body: payload, contentType: payload == nil ? nil : "application/json",
                                       idempotent: idempotent, auth: auth)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw AnalyticsPlatformError.decoding("\(method) \(path): could not decode \(T.self): \(error)")
        }
    }

    func refreshTokens(staleAccessToken: String?) async throws -> Tokens {
        let store = config.tokenStore
        return try await session.refresh(staleAccessToken: staleAccessToken, store: store) { current in
            do {
                let tokens = try await json(Tokens.self, "POST", "/v1/auth/refresh", body: ["refresh_token": .string(current.refreshToken)],
                                            idempotent: false, auth: false)
                try await store.save(tokens)
                return tokens
            } catch let error as AnalyticsPlatformError {
                // Expired, reused or revoked: the session is over.
                if case .authentication = error { try await store.save(nil) }
                throw error
            }
        }
    }

    func backoff(_ attempt: Int) -> TimeInterval {
        let d = min(config.maxRetryDelay, config.retryBaseDelay * pow(2, Double(attempt)))
        return d / 2 + Double.random(in: 0...1) * d / 2
    }

    /// `Retry-After` in seconds: delta-seconds or an HTTP date.
    static func parseRetryAfter(_ value: String?) -> TimeInterval? {
        guard let value = value?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
        if let seconds = Double(value) { return max(0, seconds) }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        guard let date = formatter.date(from: value) else { return nil }
        return max(0, date.timeIntervalSinceNow)
    }
}
