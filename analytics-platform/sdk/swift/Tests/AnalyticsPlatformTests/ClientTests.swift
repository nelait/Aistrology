import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import AnalyticsPlatform

/// Records requests and answers them from a handler; no network involved.
final class MockTransport: HTTPTransport, @unchecked Sendable {
    struct Reply {
        var status: Int = 200
        var body: String = "{}"
        var headers: [String: String] = ["Content-Type": "application/json"]
        var error: URLError? = nil
    }

    private let lock = NSLock()
    private var _requests: [URLRequest] = []
    private let handler: @Sendable (URLRequest, Int) -> Reply

    init(_ handler: @escaping @Sendable (URLRequest, Int) -> Reply) { self.handler = handler }

    convenience init(queue: [Reply]) {
        let box = QueueBox(queue)
        self.init { _, _ in box.next() }
    }

    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return _requests }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.lock()
        _requests.append(request)
        let index = _requests.count - 1
        lock.unlock()
        let reply = handler(request, index)
        if let error = reply.error { throw error }
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        return (Data(reply.body.utf8), response)
    }
}

final class QueueBox: @unchecked Sendable {
    private var queue: [MockTransport.Reply]
    private let lock = NSLock()
    init(_ queue: [MockTransport.Reply]) { self.queue = queue }
    func next() -> MockTransport.Reply {
        lock.lock(); defer { lock.unlock() }
        return queue.isEmpty ? MockTransport.Reply(status: 599, body: "{\"detail\":\"unexpected request\"}") : queue.removeFirst()
    }
}

final class SleepRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _values: [TimeInterval] = []
    var values: [TimeInterval] { lock.lock(); defer { lock.unlock() }; return _values }
    func record(_ v: TimeInterval) { lock.lock(); _values.append(v); lock.unlock() }
}

func body(_ request: URLRequest) -> JSONValue? {
    request.httpBody.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
}

final class ClientTests: XCTestCase {
    let sleeps = SleepRecorder()

    func client(_ transport: MockTransport, apiKey: String? = nil, store: TokenStore = InMemoryTokenStore(), maxRetries: Int = 3) -> AnalyticsPlatformClient {
        let sleeps = self.sleeps
        return AnalyticsPlatformClient(configuration: ClientConfiguration(
            baseURL: URL(string: "https://api.test")!, apiKey: apiKey, tokenStore: store, maxRetries: maxRetries,
            transport: transport, sleep: { sleeps.record($0) }))
    }

    func tokens(_ n: Int) -> String {
        #"{"access_token":"access-\#(n)","refresh_token":"refresh-\#(n)","expires_in":900,"token_type":"bearer"}"#
    }

    func testApiKeyHeaderAndTypedErrors() async throws {
        let mock = MockTransport(queue: [
            .init(body: #"[{"id":"e1","name":"churn","status":"active","routes":[{"model_version_id":"mv1","weight":100}]}]"#),
            .init(status: 422, body: #"{"detail":{"code":"bad_features","message":"missing feature: plan"}}"#),
            .init(status: 404, body: #"{"detail":"endpoint nope not found"}"#),
        ])
        let ap = client(mock, apiKey: "ap_live_123")
        let endpoints = try await ap.endpoints.list()
        XCTAssertEqual(endpoints.first?.routes.first?.modelVersionId, "mv1")
        XCTAssertEqual(mock.requests[0].value(forHTTPHeaderField: "X-API-Key"), "ap_live_123")
        XCTAssertNil(mock.requests[0].value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(mock.requests[0].url?.absoluteString, "https://api.test/v1/endpoints")

        do {
            _ = try await ap.endpoints.predict("churn", instances: [["age": 3]])
            XCTFail("expected an error")
        } catch let error as AnalyticsPlatformError {
            guard case .validation(let info) = error else { return XCTFail("wrong case \(error)") }
            XCTAssertEqual(info.code, "bad_features")
            XCTAssertTrue(error.localizedDescription.contains("missing feature: plan"))
        }
        do {
            _ = try await ap.endpoints.get("nope")
            XCTFail("expected an error")
        } catch let error as AnalyticsPlatformError {
            guard case .notFound = error else { return XCTFail("wrong case \(error)") }
            XCTAssertEqual(error.status, 404)
        }
    }

    func testLoginPersistsTokensAndConcurrentRefreshesShareOneRotation() async throws {
        final class State: @unchecked Sendable {
            let lock = NSLock()
            var current = "access-1"
            var refreshes = 0
        }
        let state = State()
        let pair = tokens
        let mock = MockTransport { request, _ in
            state.lock.lock(); defer { state.lock.unlock() }
            switch request.url!.path {
            case "/v1/auth/login":
                return .init(body: pair(1))
            case "/v1/auth/refresh":
                state.refreshes += 1
                state.current = "access-\(state.refreshes + 1)"
                return .init(body: pair(state.refreshes + 1))
            default:
                if request.value(forHTTPHeaderField: "Authorization") == "Bearer \(state.current)", state.current != "access-1" {
                    return .init(body: #"{"tenant_id":"acme","id":"u1","role":"admin","method":"jwt"}"#)
                }
                return .init(status: 401, body: #"{"detail":{"code":"token_expired"}}"#)
            }
        }
        let store = InMemoryTokenStore()
        let ap = client(mock, store: store)
        try await ap.auth.login(email: "ada@acme.example", password: "Correct-Horse-9", totp: "123456")
        let saved = try await store.load()
        XCTAssertEqual(saved?.refreshToken, "refresh-1")
        XCTAssertEqual(body(mock.requests[0]), ["email": "ada@acme.example", "password": "Correct-Horse-9", "totp": "123456"])
        XCTAssertNil(mock.requests[0].value(forHTTPHeaderField: "Authorization"))

        async let a = ap.auth.me()
        async let b = ap.auth.me()
        async let c = ap.auth.me()
        let ids = try await [a, b, c].map(\.id)
        XCTAssertEqual(ids, ["u1", "u1", "u1"])
        XCTAssertEqual(state.refreshes, 1)
        let rotated = try await store.load()
        XCTAssertEqual(rotated, Tokens(accessToken: "access-2", refreshToken: "refresh-2", expiresIn: 900, tokenType: "bearer"))
        let refreshBodies = mock.requests.filter { $0.url!.path == "/v1/auth/refresh" }.map(body)
        XCTAssertEqual(refreshBodies, [["refresh_token": "refresh-1"]])
    }

    func testRejectedRefreshClearsTheSession() async throws {
        let mock = MockTransport(queue: [
            .init(status: 401, body: #"{"detail":"expired"}"#),
            .init(status: 401, body: #"{"detail":{"code":"token_reuse"}}"#),
        ])
        let store = InMemoryTokenStore(Tokens(accessToken: "stale", refreshToken: "used"))
        let ap = client(mock, store: store)
        do {
            _ = try await ap.auth.me()
            XCTFail("expected an error")
        } catch let error as AnalyticsPlatformError {
            XCTAssertEqual(error.code, "token_reuse")
        }
        let cleared = try await store.load()
        XCTAssertNil(cleared)
        let loggedIn = try await ap.auth.isLoggedIn()
        XCTAssertFalse(loggedIn)
    }

    func testPredictIsRetriedOn5xxAndHonorsRetryAfter() async throws {
        let mock = MockTransport(queue: [
            .init(status: 502, body: #"{"detail":"bad gateway"}"#),
            .init(status: 429, body: #"{"detail":"slow down"}"#, headers: ["Retry-After": "2"]),
            .init(body: #"{"predictions":["yes"],"probabilities":[[0.2,0.8]],"classes":["no","yes"],"model_version":{"model_id":"m1","version":3}}"#),
        ])
        let out = try await client(mock, apiKey: "k").endpoints.predict("churn", instances: [["tenure": 3, "plan": "pro", "vip": nil]])
        XCTAssertEqual(out.labels, ["yes"])
        XCTAssertEqual(out.modelVersion?.version, 3)
        XCTAssertEqual(mock.requests.count, 3)
        XCTAssertEqual(sleeps.values[1], 2)
        XCTAssertEqual(body(mock.requests[0]), ["instances": [["tenure": 3, "plan": "pro", "vip": nil]], "explain": false])
        let raw = String(decoding: mock.requests[0].httpBody!, as: UTF8.self)
        XCTAssertTrue(raw.contains("\"tenure\":3"), raw)
    }

    func testBatchUploadIsNotRetriedOn5xxButIsOn503() async throws {
        let failing = MockTransport(queue: [.init(status: 500, body: #"{"detail":"boom"}"#)])
        do {
            _ = try await client(failing, apiKey: "k").endpoints.batch("churn", csv: Data("a,b\n1,2\n".utf8))
            XCTFail("expected an error")
        } catch let error as AnalyticsPlatformError {
            guard case .server = error else { return XCTFail("wrong case \(error)") }
        }
        XCTAssertEqual(failing.requests.count, 1)

        let busy = MockTransport(queue: [
            .init(status: 503, body: #"{"detail":"busy"}"#),
            .init(body: #"{"id":"j1","type":"serving.batch_predict","status":"queued"}"#),
        ])
        let job = try await client(busy, apiKey: "k").endpoints.batch("churn", csv: Data("a,b\n1,2\n".utf8), filename: "customers.csv")
        XCTAssertEqual(job.id, "j1")
        let upload = busy.requests[1]
        XCTAssertTrue(upload.value(forHTTPHeaderField: "Content-Type")!.hasPrefix("multipart/form-data; boundary="))
        XCTAssertTrue(String(decoding: upload.httpBody!, as: UTF8.self).contains("filename=\"customers.csv\""))
    }

    func testConnectionErrorsAreRetriedThenSurfaceAsNetwork() async throws {
        let flaky = MockTransport(queue: [
            .init(error: URLError(.cannotConnectToHost)),
            .init(body: #"{"id":"j1","type":"t","status":"running","progress":0.5}"#),
        ])
        let job = try await client(flaky, apiKey: "k").jobs.get("j1")
        XCTAssertEqual(job.status, "running")

        let down = MockTransport { _, _ in .init(error: URLError(.notConnectedToInternet)) }
        do {
            _ = try await client(down, apiKey: "k", maxRetries: 1).jobs.get("j1")
            XCTFail("expected an error")
        } catch let error as AnalyticsPlatformError {
            guard case .network = error else { return XCTFail("wrong case \(error)") }
        }
        XCTAssertEqual(down.requests.count, 2)

        // A timeout on a non-idempotent request is not retried: the server may have acted on it.
        let slow = MockTransport { _, _ in .init(error: URLError(.timedOut)) }
        do {
            _ = try await client(slow, apiKey: "k").jobs.cancel("j1")
            XCTFail("expected an error")
        } catch let error as AnalyticsPlatformError {
            guard case .timeout = error else { return XCTFail("wrong case \(error)") }
        }
        XCTAssertEqual(slow.requests.count, 1)
    }

    func testRateLimitCarriesRetryAfter() async throws {
        let mock = MockTransport(queue: [.init(status: 429, body: #"{"detail":"rate limit exceeded"}"#, headers: ["Retry-After": "7"])])
        do {
            _ = try await client(mock, apiKey: "k", maxRetries: 0).jobs.list()
            XCTFail("expected an error")
        } catch AnalyticsPlatformError.rateLimited(_, let retryAfter) {
            XCTAssertEqual(retryAfter, 7)
        }
    }

    func testAnomalyAndForecastShapes() async throws {
        let mock = MockTransport(queue: [
            .init(body: #"{"predictions":[{"is_anomaly":true,"score":0.91},{"is_anomaly":false,"score":0.12}],"threshold":0.5,"model_version":{"model_id":"m","version":1}}"#),
            .init(body: #"{"horizon":2,"timestamps":["2026-10-01","2026-10-02"],"predictions":[10.5,11.0],"lower":[9.0,9.2],"upper":[12.0,12.8],"interval_level":0.9,"model_version":{"model_id":"f","version":2}}"#),
        ])
        let ap = client(mock, apiKey: "k")
        let anomalies = try await ap.endpoints.predict("fraud", instances: [["amount": 9000]])
        XCTAssertEqual(anomalies.anomalies, [AnomalyPrediction(isAnomaly: true, score: 0.91), AnomalyPrediction(isAnomaly: false, score: 0.12)])
        XCTAssertEqual(anomalies.threshold, 0.5)
        let forecast = try await ap.endpoints.forecast("sales", horizon: 2, history: [["timestamp": "2026-09-30", "value": 10]])
        XCTAssertEqual(forecast.predictions, [10.5, 11.0])
        XCTAssertEqual(forecast.intervalLevel, 0.9)
        XCTAssertEqual(body(mock.requests[1]), ["horizon": 2, "history": [["timestamp": "2026-09-30", "value": 10]], "explain": false])
    }

    func testJobWaitPollsWithGrowingIntervalsAndFails() async throws {
        let mock = MockTransport(queue: [
            .init(body: #"{"id":"j","type":"t","status":"queued"}"#),
            .init(body: #"{"id":"j","type":"t","status":"running","progress":0.5}"#),
            .init(body: #"{"id":"j","type":"t","status":"succeeded","progress":1.0,"result":{"rows":10}}"#),
            .init(body: #"{"id":"j2","type":"t","status":"failed","error":"bad data"}"#),
        ])
        let ap = client(mock, apiKey: "k")
        let job = try await ap.jobs.wait("j", interval: 0.1)
        XCTAssertEqual(job.result?["rows"], 10)
        XCTAssertEqual(sleeps.values.count, 2)
        XCTAssertEqual(sleeps.values[1], 0.15, accuracy: 1e-9)
        do {
            _ = try await ap.jobs.wait("j2")
            XCTFail("expected an error")
        } catch AnalyticsPlatformError.jobFailed(let failed) {
            XCTAssertEqual(failed.error, "bad data")
        }
    }

    func testBatchResultOpenAPIAndDashboards() async throws {
        let mock = MockTransport(queue: [
            .init(body: "id,prediction\n1,yes\n", headers: ["Content-Type": "text/csv"]),
            .init(body: #"{"openapi":"3.1.0","paths":{"/predict":{}}}"#),
            .init(body: #"{"id":"d1","name":"Sales","owner_id":"u1","archived":false,"your_role":"viewer","shares":{},"spec":{"pages":[{"id":"p1","title":"Overview","widgets":[{"id":"w1","type":"kpi","title":"Revenue","config":{"measure":"amount"}}]}],"filters":[]}}"#),
            .init(body: #"{"columns":["region","total"],"rows":[["eu",10],["us",20]],"dataset_version":3}"#),
        ])
        let ap = client(mock, apiKey: "k")
        let csv = try await ap.endpoints.batchResult("churn", jobId: "j1")
        XCTAssertEqual(String(decoding: csv, as: UTF8.self), "id,prediction\n1,yes\n")
        let doc = try await ap.endpoints.openAPI("churn")
        XCTAssertEqual(doc["openapi"], "3.1.0")
        let dash = try await ap.dashboards.get("d1")
        XCTAssertEqual(dash.spec.widgets.map(\.id), ["w1"])
        let data = try await ap.dashboards.widgetData("d1", widgetId: "w1", filters: ["region": ["eu", "us"]])
        XCTAssertEqual(data.columns, ["region", "total"])
        XCTAssertEqual(data.rows[1][1], 20)
        XCTAssertEqual(data.raw["dataset_version"], 3)
        XCTAssertEqual(mock.requests[3].url?.path, "/v1/dashboards/d1/widgets/w1/data")
        XCTAssertEqual(body(mock.requests[3]), ["filters": ["region": ["eu", "us"]]])
    }

    func testNotificationsAndLogout() async throws {
        let mock = MockTransport(queue: [
            .init(body: #"[{"id":"n1","kind":"job.failed","title":"Training failed","body":{"job_id":"j1"},"read":false}]"#),
            .init(status: 204, body: ""),
            .init(body: #"{"email":["job.failed"]}"#),
            .init(status: 204, body: ""),
        ])
        let store = InMemoryTokenStore(Tokens(accessToken: "a", refreshToken: "r1"))
        let ap = client(mock, store: store)
        let notes = try await ap.notifications.list(unreadOnly: true)
        XCTAssertEqual(notes.first?.body["job_id"], "j1")
        XCTAssertEqual(mock.requests[0].url?.query, "unread_only=true")
        XCTAssertEqual(mock.requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer a")
        try await ap.notifications.markRead("n1")
        try await ap.notifications.setPreferences(NotificationPreferences(email: ["job.failed"]))
        XCTAssertEqual(mock.requests[2].httpMethod, "PUT")
        try await ap.auth.logout()
        XCTAssertEqual(body(mock.requests[3]), ["refresh_token": "r1"])
        let cleared = try await store.load()
        XCTAssertNil(cleared)
    }

    func testRetryAfterParsingAndURLs() {
        XCTAssertEqual(Transport.parseRetryAfter("1.5"), 1.5)
        XCTAssertNil(Transport.parseRetryAfter("soon"))
        XCTAssertEqual(Transport.parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT"), 0)
        let t = Transport(config: ClientConfiguration(baseURL: URL(string: "https://api.test/base/")!))
        XCTAssertEqual(t.url("/v1/endpoints/\(seg("churn model"))", query: ["hours": "6", "x": nil]).absoluteString,
                       "https://api.test/base/v1/endpoints/churn%20model?hours=6")
    }
}
