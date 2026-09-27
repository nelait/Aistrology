# Analytics Platform: Kotlin SDK (Android / JVM)

A Kotlin client for mobile and JVM apps (requirement SDK-004). It is built on OkHttp, kotlinx.serialization and coroutines. It covers what an app needs:

- **Auth:** an API key, or user login with rotating refresh tokens persisted through a pluggable `TokenStore`.
- **Predictions**, including anomaly (`[{is_anomaly, score}]` + `threshold`) and forecast (`timestamps`, `predictions`, `lower`, `upper`) shapes.
- **Batch jobs:** submit a CSV or a stored dataset, poll with `jobs.wait`, download the result.
- **Endpoint metadata:** `get`, `list`, the generated OpenAPI document, and metrics.
- **Dashboards:** read them and fetch widget data with filters.
- **Notifications:** list, mark read, and email preferences.

For admin and data-science workflows (training, pipelines, schedules and so on), use the Python or TypeScript SDK, or `client.request(...)`.

## Install

The library targets JVM 11 bytecode, so it can be used from Android (minSdk 26+) and from server-side Kotlin or Java.

```kotlin
// settings.gradle.kts: includeBuild("path/to/analytics-platform/sdk/kotlin"), or publish it with `gradle publishToMavenLocal`
dependencies { implementation("com.analyticsplatform:analytics-platform-sdk:0.1.0") }
```

## Usage

```kotlin
val ap = AnalyticsPlatformClient(
    ClientConfig(
        baseUrl = "https://analytics.example.com",
        tokenStore = EncryptedPrefsTokenStore(context), // your implementation; see below
    ),
)

// Log in once; afterwards the session is refreshed automatically, and each rotated refresh token is saved.
try {
    ap.auth.login("ada@acme.example", password, totp = codeOrNull)
} catch (e: AuthenticationException) {
    if (e.code == "mfa_required") askForTotp()
}

val out = ap.endpoints.predictRows("churn", listOf(mapOf("tenure" to 3, "plan" to "pro")))
out.labels()          // ["yes"]
out.probabilities     // [[0.2, 0.8]]

ap.endpoints.predict("fraud", listOf(jsonObjectOf("amount" to 9000))).anomalies() // [AnomalyPrediction(isAnomaly=true, score=0.93)]
ap.endpoints.forecast("sales", horizon = 14).predictions

val job = ap.endpoints.batch("churn", csvBytes, "customers.csv")
ap.jobs.wait(job.id, onProgress = { showProgress(it.progress) })
val predictionsCsv: ByteArray = ap.endpoints.batchResult("churn", job.id)

val schema = ap.endpoints.openapi("churn")   // feature names, types and ranges, e.g. to build a form
val dash = ap.dashboards.get(dashboardId)
val data = ap.dashboards.widgetData(dashboardId, dash.spec.widgets.first().id!!, jsonObjectOf("region" to listOf("eu")))
val unread = ap.notifications.list(unreadOnly = true)

// API key instead of a user session (e.g. a kiosk app):
val kiosk = AnalyticsPlatformClient("https://analytics.example.com", apiKey = BuildConfig.AP_KEY)
```

### Persisting the session

```kotlin
class EncryptedPrefsTokenStore(context: Context) : TokenStore {
    private val prefs = EncryptedSharedPreferences.create(/* MasterKey + AES256 schemes */)
    override suspend fun load(): Tokens? = prefs.getString("ap_session", null)?.let { Json.decodeFromString<Tokens>(it) }
    override suspend fun save(tokens: Tokens?) {
        prefs.edit().apply { if (tokens == null) remove("ap_session") else putString("ap_session", Json.encodeToString(tokens)) }.apply()
    }
}
```

Refresh tokens are single use. The client serializes refreshes behind a mutex, so concurrent 401s share one refresh. If the server rejects the refresh token (expired, reused or revoked), the store is cleared and `AuthenticationException` is thrown, so the app can show the login screen.

## Behaviour

- **Retries:** exponential backoff with jitter. A `Retry-After` header is honored (seconds or HTTP date) and capped at `maxRetryDelayMillis`.
  - `predict`, `forecast`, widget data and GET/PUT/DELETE are idempotent. They are retried on 408/429/5xx, timeouts and connection errors.
  - Uploads (`batch` with a CSV) and other POSTs are **not** retried on 5xx or timeouts. They are retried only on 429/503 (the server did not accept them) or when the connection could not be established.
- **Errors** mirror the other SDKs:
  - `ApiException`, with `status`, `code` and `detail`. Its subclasses are `AuthenticationException` (401), `ForbiddenException` (403), `NotFoundException` (404), `ConflictException` (409), `ValidationException` (422), `RateLimitException` (429, with `retryAfterSeconds`) and `ServerException` (5xx).
  - `NetworkException`, `RequestTimeoutException` and `JobFailedException`. All of them extend `AnalyticsPlatformException`.
- **Configuration:** `ClientConfig(maxRetries, retryBaseDelayMillis, maxRetryDelayMillis, timeoutMillis, httpClient, sleeper)`. Pass your own `OkHttpClient` for certificate pinning or interceptors.

## Build and test

```bash
cd analytics-platform/sdk/kotlin
gradle build        # compiles and runs the MockWebServer tests (JDK 17+, Gradle 8.x)
```

Verified here with Gradle 8.14.3, Kotlin 2.0.21 and OpenJDK 21: `gradle build` passes 14 unit tests against MockWebServer. The tests cover auth, refresh rotation, retries, idempotency, typed errors, anomaly/forecast parsing, jobs, dashboards and notifications. CI runs the same build (`sdk-kotlin` job).
