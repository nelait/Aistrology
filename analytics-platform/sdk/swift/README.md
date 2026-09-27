# Analytics Platform: Swift SDK (iOS / macOS)

A Swift package for iOS 15+ and macOS 12+ apps (requirement SDK-003). It uses `async`/`await` and `URLSession`, and has no dependencies. It covers what an app needs:

- **Auth:** an API key, or user login with rotating refresh tokens persisted through a pluggable `TokenStore`. A `KeychainTokenStore` is included.
- **Predictions**, including anomaly (`anomalies`, `threshold`) and forecast (`ForecastResponse`) shapes.
- **Batch jobs:** submit a CSV or a stored dataset, poll with `jobs.wait`, download the result.
- **Endpoint metadata:** `get`, `list`, the generated OpenAPI document, and metrics.
- **Dashboards:** read them and fetch widget data with filters.
- **Notifications:** list, mark read, and email preferences.

For other endpoints, use `client.request(_:method:path:query:body:)`.

## Install

```swift
// Package.swift
.package(path: "../analytics-platform/sdk/swift")   // or a git URL
.product(name: "AnalyticsPlatform", package: "AnalyticsPlatform")
```

## Usage

```swift
import AnalyticsPlatform

let ap = AnalyticsPlatformClient(configuration: .init(
    baseURL: URL(string: "https://analytics.example.com")!,
    tokenStore: KeychainTokenStore()       // survives app restarts; InMemoryTokenStore() is the default
))

do {
    try await ap.auth.login(email: "ada@acme.example", password: password, totp: code)
} catch let error as AnalyticsPlatformError where error.code == "mfa_required" {
    // ask for the TOTP code
}

let out = try await ap.endpoints.predict("churn", instances: [["tenure": 3, "plan": "pro"]])
out.labels            // ["yes"]
out.probabilities     // [[0.2, 0.8]]

let fraud = try await ap.endpoints.predict("fraud", instances: [["amount": 9000]])
fraud.anomalies       // [AnomalyPrediction(isAnomaly: true, score: 0.93)]
let sales = try await ap.endpoints.forecast("sales", horizon: 14)

let job = try await ap.endpoints.batch("churn", csv: csvData, filename: "customers.csv")
_ = try await ap.jobs.wait(job.id) { progress in print(progress.progress ?? 0) }
let result = try await ap.endpoints.batchResult("churn", jobId: job.id)

let spec = try await ap.endpoints.openAPI("churn")        // JSONValue: feature names, types, ranges
let dashboard = try await ap.dashboards.get(dashboardId)
let data = try await ap.dashboards.widgetData(dashboardId, widgetId: "w1", filters: ["region": ["eu"]])
let unread = try await ap.notifications.list(unreadOnly: true)
```

Dynamic payloads (instances, filters, predictions, widget rows) use `JSONValue`, which supports literals: `["plan": "pro", "tenure": 3, "vip": nil]`.

## Behaviour

- **Sessions:** refresh tokens are single use. An actor serializes refreshes, so concurrent 401s share one refresh, and every rotated pair is saved to the `TokenStore`. If the refresh token is rejected, the store is cleared and `.authentication` is thrown.
- **Retries:** exponential backoff with jitter. A `Retry-After` header is honored (seconds or HTTP date).
  - `predict`, `forecast`, widget data and GET/PUT/DELETE are idempotent. They are retried on 408/429/5xx, timeouts and connection errors.
  - Uploads (`batch(_:csv:)`) and other POSTs are **not** retried on 5xx or timeouts. They are retried only on 429/503, or when the connection could not be established.
- **Errors:** `AnalyticsPlatformError` mirrors the other SDKs' classes.
  - HTTP errors: `.authentication`, `.forbidden`, `.notFound`, `.conflict`, `.validation`, `.rateLimited(_, retryAfter:)`, `.server` and `.http`. Each carries `APIErrorInfo` with `status`, `code` and `detail`.
  - Other errors: `.network`, `.timeout`, `.jobFailed(Job)` and `.decoding`.
- **Testing and custom networking:** inject an `HTTPTransport` (see `Tests/`) or your own `URLSession`, for example for certificate pinning.

## Build and test

```bash
cd analytics-platform/sdk/swift
swift build && swift test
```

Verified here on Linux with Swift 6.0.3. The official swift.org download is blocked in this sandbox, so the toolchain came from Ubuntu's `swiftlang` 6.0.3 package. `swift build` succeeds and `swift test` passes 12 XCTest cases. The cases cover auth, refresh rotation, retries, idempotency, typed errors, anomaly/forecast decoding, jobs, dashboards and notifications.

`KeychainTokenStore` is compiled only where the `Security` framework exists (`#if canImport(Security)`), so it was **not** compiled or tested here. The CI `sdk-swift` job builds and tests the package on both `ubuntu-latest` and `macos-latest`, and the macOS run compiles the Keychain store.
