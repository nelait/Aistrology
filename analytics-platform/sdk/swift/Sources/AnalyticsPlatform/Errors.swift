import Foundation

/// Details of a non-2xx response. `detail` is the server's FastAPI `detail`; `code` is `detail.code` when present
/// (e.g. `invalid_credentials`, `mfa_required`, `quota_exceeded`).
public struct APIErrorInfo: Sendable, Equatable {
    public let status: Int
    public let code: String?
    public let message: String
    public let detail: JSONValue?
    public let method: String
    public let path: String
}

/// Every error the SDK throws. The cases mirror the Python and TypeScript SDKs' error classes.
public enum AnalyticsPlatformError: Error, Sendable, LocalizedError {
    /// 401: missing, invalid or expired credentials (also a rejected refresh token).
    case authentication(APIErrorInfo)
    /// 403: authenticated, but not allowed.
    case forbidden(APIErrorInfo)
    /// 404
    case notFound(APIErrorInfo)
    /// 409: wrong state (e.g. the job has not finished).
    case conflict(APIErrorInfo)
    /// 422: the request was rejected as invalid.
    case validation(APIErrorInfo)
    /// 429: rate limited; `retryAfter` seconds from the `Retry-After` header.
    case rateLimited(APIErrorInfo, retryAfter: TimeInterval?)
    /// 5xx
    case server(APIErrorInfo)
    /// Any other non-2xx status.
    case http(APIErrorInfo)
    /// No response (offline, DNS, connection reset).
    case network(String)
    /// The request or `jobs.wait` did not finish in time.
    case timeout(String)
    /// `jobs.wait` saw the job fail or get cancelled.
    case jobFailed(Job)
    /// The response could not be decoded.
    case decoding(String)

    /// The API error details, for HTTP errors.
    public var info: APIErrorInfo? {
        switch self {
        case .authentication(let i), .forbidden(let i), .notFound(let i), .conflict(let i), .validation(let i),
             .server(let i), .http(let i):
            return i
        case .rateLimited(let i, _):
            return i
        default:
            return nil
        }
    }

    public var status: Int? { info?.status }
    public var code: String? { info?.code }

    public var errorDescription: String? {
        switch self {
        case .network(let m), .timeout(let m), .decoding(let m): return m
        case .jobFailed(let job): return "job \(job.id) \(job.status)\(job.error.map { ": \($0)" } ?? "")"
        default:
            guard let i = info else { return nil }
            return "\(i.method) \(i.path) -> HTTP \(i.status): \(i.message)"
        }
    }

    static func from(status: Int, detail: JSONValue?, method: String, path: String, retryAfter: TimeInterval?) -> AnalyticsPlatformError {
        let code = detail?["code"]?.stringValue
        let message: String
        switch detail {
        case .string(let s)?: message = s
        case .object(let o)?: message = o["message"]?.stringValue ?? String(describing: o)
        case .array(let a)?: message = a.compactMap { $0["msg"]?.stringValue ?? $0["message"]?.stringValue }.joined(separator: "; ")
        default: message = "request failed"
        }
        let info = APIErrorInfo(status: status, code: code, message: message, detail: detail, method: method, path: path)
        switch status {
        case 401: return .authentication(info)
        case 403: return .forbidden(info)
        case 404: return .notFound(info)
        case 409: return .conflict(info)
        case 422: return .validation(info)
        case 429: return .rateLimited(info, retryAfter: retryAfter)
        case 500...: return .server(info)
        default: return .http(info)
        }
    }
}
