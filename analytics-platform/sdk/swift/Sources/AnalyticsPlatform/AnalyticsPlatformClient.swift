import Foundation

/// Client for the Analytics Platform, focused on what mobile apps need: authentication (API key, or user login
/// with rotating refresh tokens persisted through a `TokenStore`), predictions (including anomaly and forecast
/// shapes), batch jobs, endpoint metadata, dashboards and notifications.
///
/// ```swift
/// let ap = AnalyticsPlatformClient(configuration: .init(baseURL: URL(string: "https://analytics.example.com")!,
///                                                       tokenStore: KeychainTokenStore()))
/// try await ap.auth.login(email: "ada@acme.example", password: password)
/// let out = try await ap.endpoints.predict("churn", instances: [["tenure": 3, "plan": "pro"]])
/// print(out.labels)
/// ```
public final class AnalyticsPlatformClient: Sendable {
    let transport: Transport

    public let auth: AuthAPI
    public let endpoints: EndpointsAPI
    public let jobs: JobsAPI
    public let dashboards: DashboardsAPI
    public let notifications: NotificationsAPI

    public init(configuration: ClientConfiguration) {
        let transport = Transport(config: configuration)
        self.transport = transport
        auth = AuthAPI(t: transport)
        endpoints = EndpointsAPI(t: transport)
        jobs = JobsAPI(t: transport)
        dashboards = DashboardsAPI(t: transport)
        notifications = NotificationsAPI(t: transport)
    }

    public convenience init(baseURL: URL, apiKey: String? = nil, tokenStore: TokenStore = InMemoryTokenStore()) {
        self.init(configuration: ClientConfiguration(baseURL: baseURL, apiKey: apiKey, tokenStore: tokenStore))
    }

    /// Escape hatch for endpoints this SDK does not wrap.
    public func request<T: Decodable>(
        _ type: T.Type, method: String, path: String, query: [String: String?] = [:], body: JSONValue? = nil, idempotent: Bool? = nil
    ) async throws -> T {
        try await transport.json(type, method, path, query: query, body: body, idempotent: idempotent)
    }
}

/// Percent-encodes one path segment.
func seg(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#"))) ?? value
}

public struct AuthAPI: Sendable {
    let t: Transport

    /// Log in with email and password (and a TOTP code when MFA is on). The tokens are saved to the `TokenStore`,
    /// used for later calls and refreshed automatically. Failures are `.authentication` with `code`
    /// `invalid_credentials`, `mfa_required`, `locked`, ...
    @discardableResult
    public func login(email: String, password: String, totp: String? = nil) async throws -> Tokens {
        var body: [String: JSONValue] = ["email": .string(email), "password": .string(password)]
        if let totp { body["totp"] = .string(totp) }
        let tokens = try await t.json(Tokens.self, "POST", "/v1/auth/login", body: .object(body), auth: false)
        try await t.config.tokenStore.save(tokens)
        return tokens
    }

    /// Refresh now (normally automatic on a 401). The rotated pair is saved to the `TokenStore`.
    @discardableResult
    public func refresh() async throws -> Tokens {
        try await t.refreshTokens(staleAccessToken: nil)
    }

    /// Revoke the refresh token and clear the stored session.
    public func logout() async throws {
        let store = t.config.tokenStore
        guard let tokens = try await store.load() else { return }
        do {
            _ = try await t.send("POST", "/v1/auth/logout", body: try JSONEncoder().encode(["refresh_token": tokens.refreshToken]),
                                 contentType: "application/json", auth: false)
        } catch {
            try? await store.save(nil)
            throw error
        }
        try await store.save(nil)
    }

    public func isLoggedIn() async throws -> Bool { try await t.config.tokenStore.load() != nil }

    /// The authenticated principal (user, API key or OAuth client).
    public func me() async throws -> Me { try await t.json(Me.self, "GET", "/v1/auth/me") }
}

public struct EndpointsAPI: Sendable {
    let t: Transport

    public func list() async throws -> [Endpoint] { try await t.json([Endpoint].self, "GET", "/v1/endpoints") }

    public func get(_ name: String) async throws -> Endpoint { try await t.json(Endpoint.self, "GET", "/v1/endpoints/\(seg(name))") }

    /// The endpoint's OpenAPI document, generated from the model signature (feature names, types, ranges).
    public func openAPI(_ name: String) async throws -> JSONValue {
        try await t.json(JSONValue.self, "GET", "/v1/endpoints/\(seg(name))/openapi.json")
    }

    /// Request counts and latency percentiles over the last `hours`.
    public func metrics(_ name: String, hours: Int = 24) async throws -> JSONValue {
        try await t.json(JSONValue.self, "GET", "/v1/endpoints/\(seg(name))/metrics", query: ["hours": String(hours)])
    }

    /// Real-time inference. Predictions have no side effects, so they are retried like reads (5xx, timeouts, 429
    /// honoring `Retry-After`). For anomaly endpoints use `PredictResponse.anomalies`.
    public func predict(_ name: String, instances: [[String: JSONValue]], explain: Bool = false) async throws -> PredictResponse {
        let body: JSONValue = ["instances": .array(instances.map { .object($0) }), "explain": .bool(explain)]
        return try await t.json(PredictResponse.self, "POST", "/v1/endpoints/\(seg(name))/predict", body: body, idempotent: true)
    }

    /// Forecast `horizon` steps (default: the trained horizon), optionally refitting with recent `history`.
    public func forecast(_ name: String, horizon: Int? = nil, history: [[String: JSONValue]]? = nil) async throws -> ForecastResponse {
        var body: [String: JSONValue] = ["explain": false]
        if let horizon { body["horizon"] = .number(Double(horizon)) }
        if let history { body["history"] = .array(history.map { .object($0) }) }
        return try await t.json(ForecastResponse.self, "POST", "/v1/endpoints/\(seg(name))/predict", body: .object(body), idempotent: true)
    }

    /// Start a batch prediction job over a CSV. Uploads are not idempotent (each creates a job): a 5xx or timeout
    /// is not retried, only 429/503, which mean the server did not accept the request.
    public func batch(_ name: String, csv: Data, filename: String = "input.csv") async throws -> Job {
        let boundary = "ap-\(UUID().uuidString)"
        var body = Data()
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename.replacingOccurrences(of: "\"", with: ""))\"\r\n".utf8))
        body.append(Data("Content-Type: text/csv\r\n\r\n".utf8))
        body.append(csv)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        let (data, _) = try await t.send("POST", "/v1/endpoints/\(seg(name))/batch", body: body,
                                         contentType: "multipart/form-data; boundary=\(boundary)", idempotent: false)
        return try decode(Job.self, data)
    }

    /// Start a batch prediction job over a stored dataset.
    public func batch(_ name: String, datasetId: String) async throws -> Job {
        try await t.json(Job.self, "POST", "/v1/endpoints/\(seg(name))/batch", body: ["dataset_id": .string(datasetId)])
    }

    /// Download the CSV output of a finished batch job.
    public func batchResult(_ name: String, jobId: String) async throws -> Data {
        try await t.send("GET", "/v1/endpoints/\(seg(name))/batch/\(seg(jobId))", accept: "text/csv, */*").0
    }
}

public struct JobsAPI: Sendable {
    let t: Transport

    public func get(_ id: String) async throws -> Job { try await t.json(Job.self, "GET", "/v1/jobs/\(seg(id))") }

    public func list(status: String? = nil) async throws -> [Job] {
        try await t.json([Job].self, "GET", "/v1/jobs", query: ["status": status])
    }

    public func cancel(_ id: String) async throws -> Job { try await t.json(Job.self, "POST", "/v1/jobs/\(seg(id))/cancel") }

    /// Poll until the job finishes: the interval starts at `interval` and grows 1.5x up to 10 s. Throws
    /// `.jobFailed` when it fails or is cancelled and `.timeout` after `timeout`.
    public func wait(_ id: String, interval: TimeInterval = 1, timeout: TimeInterval? = nil,
                     onProgress: (@Sendable (Job) -> Void)? = nil) async throws -> Job {
        let deadline = timeout.map { Date().addingTimeInterval($0) }
        var delay = interval
        while true {
            let job = try await get(id)
            onProgress?(job)
            switch job.status {
            case "succeeded": return job
            case "failed", "cancelled": throw AnalyticsPlatformError.jobFailed(job)
            default: break
            }
            if let deadline, Date() >= deadline {
                throw AnalyticsPlatformError.timeout("job \(id) did not finish within \(timeout ?? 0) s (status \(job.status))")
            }
            try await t.config.sleep(delay)
            delay = min(delay * 1.5, 10)
        }
    }
}

public struct DashboardsAPI: Sendable {
    let t: Transport

    public func list() async throws -> [Dashboard] { try await t.json([Dashboard].self, "GET", "/v1/dashboards") }

    public func get(_ id: String) async throws -> Dashboard { try await t.json(Dashboard.self, "GET", "/v1/dashboards/\(seg(id))") }

    /// Data for one widget with global `filters` applied (`{column: value | [values] | {min, max}}`). Read-only,
    /// so it is retried like a GET.
    public func widgetData(_ dashboardId: String, widgetId: String, filters: [String: JSONValue] = [:]) async throws -> WidgetData {
        let raw = try await t.json([String: JSONValue].self, "POST", "/v1/dashboards/\(seg(dashboardId))/widgets/\(seg(widgetId))/data",
                                   body: ["filters": .object(filters)], idempotent: true)
        return WidgetData(raw: raw)
    }
}

public struct NotificationsAPI: Sendable {
    let t: Transport

    public func list(unreadOnly: Bool = false) async throws -> [AppNotification] {
        try await t.json([AppNotification].self, "GET", "/v1/notifications", query: ["unread_only": unreadOnly ? "true" : "false"])
    }

    public func markRead(_ id: String) async throws {
        _ = try await t.send("POST", "/v1/notifications/\(seg(id))/read", idempotent: true)
    }

    public func preferences() async throws -> NotificationPreferences {
        try await t.json(NotificationPreferences.self, "GET", "/v1/notifications/preferences")
    }

    @discardableResult
    public func setPreferences(_ preferences: NotificationPreferences) async throws -> NotificationPreferences {
        try await t.json(NotificationPreferences.self, "PUT", "/v1/notifications/preferences",
                         body: ["email": .array(preferences.email.map { .string($0) })])
    }
}

func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
    do {
        return try JSONDecoder().decode(type, from: data)
    } catch {
        throw AnalyticsPlatformError.decoding("could not decode \(T.self): \(error)")
    }
}
