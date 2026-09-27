import Foundation

// MARK: - Auth

/// A user session. Refresh tokens rotate: each one is valid for a single refresh.
public struct Tokens: Codable, Sendable, Equatable {
    public var accessToken: String
    public var refreshToken: String
    public var expiresIn: Int?
    public var tokenType: String?

    public init(accessToken: String, refreshToken: String, expiresIn: Int? = nil, tokenType: String? = nil) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresIn = expiresIn
        self.tokenType = tokenType
    }

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token", refreshToken = "refresh_token", expiresIn = "expires_in", tokenType = "token_type"
    }
}

public struct Me: Codable, Sendable, Equatable {
    public let tenantId: String
    public let id: String
    public let role: String
    /// `jwt`, `api_key`, `oauth_client`, ...
    public let method: String
    public let email: String?
    public let name: String?

    enum CodingKeys: String, CodingKey {
        case tenantId = "tenant_id", id, role, method, email, name
    }
}

// MARK: - Jobs and notifications

public struct Job: Codable, Sendable, Equatable {
    public let id: String
    public let type: String
    /// `queued`, `running`, `succeeded`, `failed` or `cancelled`.
    public let status: String
    public let progress: Double?
    public let message: String?
    public let params: [String: JSONValue]?
    public let result: [String: JSONValue]?
    public let error: String?
    public let createdAt: String?
    public let finishedAt: String?

    public var isTerminal: Bool { ["succeeded", "failed", "cancelled"].contains(status) }

    enum CodingKeys: String, CodingKey {
        case id, type, status, progress, message, params, result, error, createdAt = "created_at", finishedAt = "finished_at"
    }
}

public struct AppNotification: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    /// e.g. `job.succeeded`, `endpoint.threshold`, `comment.mention`.
    public let kind: String
    public let title: String
    public let body: [String: JSONValue]
    public let read: Bool
}

public struct NotificationPreferences: Codable, Sendable, Equatable {
    /// Kinds emailed to the user, e.g. `job.failed`, or `*`.
    public var email: [String]

    public init(email: [String]) { self.email = email }
}

// MARK: - Serving

public struct ModelVersionRef: Codable, Sendable, Equatable {
    public let modelId: String?
    public let version: Int?

    enum CodingKeys: String, CodingKey { case modelId = "model_id", version }
}

public struct EndpointRoute: Codable, Sendable, Equatable {
    public let modelVersionId: String
    public let weight: Double

    enum CodingKeys: String, CodingKey { case modelVersionId = "model_version_id", weight }
}

public struct Endpoint: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let routes: [EndpointRoute]
    public let status: String
    public let url: String?
    public let createdAt: String?

    enum CodingKeys: String, CodingKey { case id, name, routes, status, url, createdAt = "created_at" }
}

/// Response of `predict` for classification, regression, clustering and anomaly endpoints. `predictions` stays
/// JSON because its element type depends on the model; use `labels`, `values` or `anomalies`.
public struct PredictResponse: Codable, Sendable, Equatable {
    public let predictions: [JSONValue]
    public let probabilities: [[Double]]?
    public let classes: [JSONValue]?
    public let modelVersion: ModelVersionRef?
    /// Anomaly endpoints: the score above which a row is flagged.
    public let threshold: Double?

    /// Class labels as strings (classification).
    public var labels: [String?] { predictions.map { $0.stringValue } }
    /// Numeric predictions (regression, cluster ids).
    public var values: [Double?] { predictions.map { $0.doubleValue } }
    /// Anomaly endpoints: `predictions: [{is_anomaly, score}]`.
    public var anomalies: [AnomalyPrediction] {
        predictions.map { AnomalyPrediction(isAnomaly: $0["is_anomaly"]?.boolValue ?? false, score: $0["score"]?.doubleValue ?? .nan) }
    }

    enum CodingKeys: String, CodingKey { case predictions, probabilities, classes, modelVersion = "model_version", threshold }
}

public struct AnomalyPrediction: Sendable, Equatable {
    public let isAnomaly: Bool
    public let score: Double
}

/// Response of a forecasting endpoint.
public struct ForecastResponse: Codable, Sendable, Equatable {
    public let horizon: Int
    public let timestamps: [String]
    public let predictions: [Double]
    public let lower: [Double]?
    public let upper: [Double]?
    public let intervalLevel: Double?
    public let modelVersion: ModelVersionRef?

    enum CodingKeys: String, CodingKey {
        case horizon, timestamps, predictions, lower, upper, intervalLevel = "interval_level", modelVersion = "model_version"
    }
}

// MARK: - Dashboards

public struct Widget: Codable, Sendable, Equatable {
    public let id: String?
    public let type: String
    public let title: String?
    public let config: [String: JSONValue]?
    public let layout: [String: JSONValue]?
}

public struct DashboardPage: Codable, Sendable, Equatable {
    public let id: String?
    public let title: String?
    public let widgets: [Widget]?
}

public struct DashboardSpec: Codable, Sendable, Equatable {
    public let pages: [DashboardPage]?
    public let filters: [JSONValue]?
    public let refreshSeconds: Int?

    /// Every widget across pages.
    public var widgets: [Widget] { (pages ?? []).flatMap { $0.widgets ?? [] } }

    enum CodingKeys: String, CodingKey { case pages, filters, refreshSeconds = "refresh_seconds" }
}

public struct Dashboard: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let spec: DashboardSpec
    public let ownerId: String?
    public let archived: Bool?
    public let yourRole: String?
    public let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, name, spec, ownerId = "owner_id", archived, yourRole = "your_role", updatedAt = "updated_at"
    }
}

/// Data for one widget: `columns` and `rows`, plus widget-specific fields in `raw` (e.g. `value` for KPIs).
public struct WidgetData: Sendable, Equatable {
    public let columns: [String]
    public let rows: [[JSONValue]]
    public let raw: [String: JSONValue]

    init(raw: [String: JSONValue]) {
        let columns = raw["columns"]?.arrayValue?.compactMap { $0.stringValue } ?? []
        self.columns = columns
        self.rows = (raw["rows"]?.arrayValue ?? []).map { row in
            switch row {
            case .array(let a): return a
            case .object(let o): return columns.map { o[$0] ?? .null }
            default: return [row]
            }
        }
        self.raw = raw
    }
}
