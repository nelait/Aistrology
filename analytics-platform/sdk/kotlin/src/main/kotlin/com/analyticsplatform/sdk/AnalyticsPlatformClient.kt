package com.analyticsplatform.sdk

import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import kotlin.math.min

/**
 * Client for the Analytics Platform, focused on what mobile and JVM apps need: authentication (API key, or
 * user login with rotating refresh tokens persisted through a [TokenStore]), predictions (including anomaly
 * and forecast shapes), batch jobs, endpoint metadata, dashboards and notifications.
 *
 * ```kotlin
 * val ap = AnalyticsPlatformClient(ClientConfig("https://analytics.example.com", apiKey = "ap_live_…"))
 * val out = ap.endpoints.predict("churn", listOf(jsonObjectOf("tenure" to 3, "plan" to "pro")))
 * println(out.labels())
 * ```
 */
public class AnalyticsPlatformClient(config: ClientConfig) {
    internal val transport: Transport = Transport(config)

    public val auth: AuthApi = AuthApi(transport)
    public val endpoints: EndpointsApi = EndpointsApi(transport)
    public val jobs: JobsApi = JobsApi(transport)
    public val dashboards: DashboardsApi = DashboardsApi(transport)
    public val notifications: NotificationsApi = NotificationsApi(transport)

    public constructor(baseUrl: String, apiKey: String? = null, tokenStore: TokenStore = InMemoryTokenStore()) :
        this(ClientConfig(baseUrl, apiKey = apiKey, tokenStore = tokenStore))

    /** Escape hatch for endpoints this SDK does not wrap: returns the parsed JSON body (or `null` for 204). */
    public suspend fun request(
        method: String,
        path: String,
        query: Map<String, Any?> = emptyMap(),
        body: JsonElement? = null,
        idempotent: Boolean = method in Transport.IDEMPOTENT,
    ): JsonElement? = transport.request(method, path, query, body, idempotent)
}

public abstract class Resource internal constructor(internal val t: Transport) {
    internal suspend fun <T> call(
        serializer: KSerializer<T>,
        method: String,
        path: String,
        query: Map<String, Any?> = emptyMap(),
        body: JsonElement? = null,
        idempotent: Boolean = method in Transport.IDEMPOTENT,
        auth: Boolean = true,
    ): T {
        val element = t.request(method, path, query, body, idempotent, auth)
            ?: throw AnalyticsPlatformException("$method $path returned no body")
        return sdkJson.decodeFromJsonElement(serializer, element)
    }

    internal companion object {
        /** Percent-encoding happens in [Transport.url]; this only rejects separators inside a segment. */
        fun seg(value: String): String {
            require(value.isNotEmpty() && '/' !in value) { "invalid path segment: '$value'" }
            return value
        }
    }
}

public class AuthApi internal constructor(t: Transport) : Resource(t) {
    /**
     * Log in with email and password (and a TOTP code when MFA is on). The tokens are saved to the
     * [TokenStore]; later calls use them and refresh them automatically. A 401 carries `code`
     * `invalid_credentials`, `mfa_required`, `locked`, ... on the [AuthenticationException].
     */
    public suspend fun login(email: String, password: String, totp: String? = null): Tokens {
        val body = buildJsonObject {
            put("email", email)
            put("password", password)
            if (totp != null) put("totp", totp)
        }
        val tokens = call(Tokens.serializer(), "POST", "/v1/auth/login", body = body, auth = false)
        t.tokenStore.save(tokens)
        return tokens
    }

    /** Refresh now (normally automatic on a 401). The rotated pair is saved to the [TokenStore]. */
    public suspend fun refresh(): Tokens = t.refreshTokens(staleAccessToken = null)

    /** Revoke the refresh token and clear the stored session. */
    public suspend fun logout() {
        val tokens = t.tokenStore.load()
        try {
            if (tokens != null) {
                t.request("POST", "/v1/auth/logout", json = JsonObject(mapOf("refresh_token" to JsonPrimitive(tokens.refreshToken))), auth = false)
            }
        } finally {
            t.tokenStore.save(null)
        }
    }

    public suspend fun isLoggedIn(): Boolean = t.tokenStore.load() != null

    /** The authenticated principal (user, API key or OAuth client). */
    public suspend fun me(): Me = call(Me.serializer(), "GET", "/v1/auth/me")
}

public class EndpointsApi internal constructor(t: Transport) : Resource(t) {
    public suspend fun list(): List<Endpoint> = call(ListSerializer(Endpoint.serializer()), "GET", "/v1/endpoints")

    public suspend fun get(name: String): Endpoint = call(Endpoint.serializer(), "GET", "/v1/endpoints/${seg(name)}")

    /** The endpoint's OpenAPI document, generated from the model signature (feature names, types, ranges). */
    public suspend fun openapi(name: String): JsonObject = call(JsonObject.serializer(), "GET", "/v1/endpoints/${seg(name)}/openapi.json")

    /** Request counts and latency percentiles over the last [hours]. */
    public suspend fun metrics(name: String, hours: Int = 24): JsonObject =
        call(JsonObject.serializer(), "GET", "/v1/endpoints/${seg(name)}/metrics", mapOf("hours" to hours))

    /**
     * Real-time inference. Predictions have no side effects, so they are retried like reads (5xx, timeouts,
     * 429 with `Retry-After`). Anomaly endpoints: use [PredictResponse.anomalies].
     */
    public suspend fun predict(name: String, instances: List<JsonObject>, explain: Boolean = false): PredictResponse {
        val body = buildJsonObject {
            put("instances", JsonArray(instances))
            put("explain", explain)
        }
        return call(PredictResponse.serializer(), "POST", "/v1/endpoints/${seg(name)}/predict", body = body, idempotent = true)
    }

    /** [predict] with plain Kotlin maps (values: strings, numbers, booleans, null, lists, maps). */
    public suspend fun predictRows(name: String, rows: List<Map<String, Any?>>, explain: Boolean = false): PredictResponse =
        predict(name, rows.map { it.toJsonObject() }, explain)

    /** Forecast [horizon] steps (default: the trained horizon), optionally refitting with recent [history]. */
    public suspend fun forecast(name: String, horizon: Int? = null, history: List<JsonObject>? = null): ForecastResponse {
        val body = buildJsonObject {
            if (horizon != null) put("horizon", horizon)
            if (history != null) put("history", JsonArray(history))
            put("explain", false)
        }
        return call(ForecastResponse.serializer(), "POST", "/v1/endpoints/${seg(name)}/predict", body = body, idempotent = true)
    }

    /**
     * Start a batch prediction job over an uploaded CSV. Uploads are not idempotent (each creates a job), so a
     * 5xx or timeout is not retried; only 429/503, which mean the server did not accept the request.
     */
    public suspend fun batch(name: String, csv: ByteArray, filename: String = "input.csv"): Job {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", filename, csv.toRequestBody("text/csv".toMediaType()))
            .build()
        return t.execute("POST", t.url("/v1/endpoints/${seg(name)}/batch"), body, idempotent = false).use {
            sdkJson.decodeFromString(Job.serializer(), it.body!!.string())
        }
    }

    /** Start a batch prediction job over a stored dataset. */
    public suspend fun batchFromDataset(name: String, datasetId: String): Job =
        call(Job.serializer(), "POST", "/v1/endpoints/${seg(name)}/batch", body = buildJsonObject { put("dataset_id", datasetId) })

    /** Download the CSV output of a finished batch job. */
    public suspend fun batchResult(name: String, jobId: String): ByteArray = t.bytes("GET", "/v1/endpoints/${seg(name)}/batch/${seg(jobId)}")
}

public class JobsApi internal constructor(t: Transport) : Resource(t) {
    public suspend fun get(jobId: String): Job = call(Job.serializer(), "GET", "/v1/jobs/${seg(jobId)}")

    public suspend fun list(status: String? = null): List<Job> = call(ListSerializer(Job.serializer()), "GET", "/v1/jobs", mapOf("status" to status))

    public suspend fun cancel(jobId: String): Job = call(Job.serializer(), "POST", "/v1/jobs/${seg(jobId)}/cancel")

    /**
     * Poll until the job finishes: the interval starts at [intervalMillis] and grows 1.5x up to 10 s.
     * Throws [JobFailedException] when it fails or is cancelled, [RequestTimeoutException] after [timeoutMillis].
     */
    public suspend fun wait(
        jobId: String,
        intervalMillis: Long = 1_000,
        timeoutMillis: Long? = null,
        onProgress: ((Job) -> Unit)? = null,
    ): Job {
        val deadline = timeoutMillis?.let { System.currentTimeMillis() + it }
        var interval = intervalMillis
        while (true) {
            val job = get(jobId)
            onProgress?.invoke(job)
            when (job.status) {
                "succeeded" -> return job
                "failed", "cancelled" -> throw JobFailedException(job)
            }
            if (deadline != null && System.currentTimeMillis() >= deadline) {
                throw RequestTimeoutException("job $jobId did not finish within $timeoutMillis ms (status ${job.status})")
            }
            t.sleeper(interval)
            interval = min((interval * 1.5).toLong(), 10_000)
        }
    }
}

public class DashboardsApi internal constructor(t: Transport) : Resource(t) {
    public suspend fun list(): List<Dashboard> = call(ListSerializer(Dashboard.serializer()), "GET", "/v1/dashboards")

    public suspend fun get(dashboardId: String): Dashboard = call(Dashboard.serializer(), "GET", "/v1/dashboards/${seg(dashboardId)}")

    /**
     * Data for one widget with the dashboard's global [filters] applied (`{column: value | [values] | {min, max}}`).
     * Read-only, so it is retried like a GET.
     */
    public suspend fun widgetData(dashboardId: String, widgetId: String, filters: JsonObject = JsonObject(emptyMap())): WidgetData {
        val out = t.request(
            "POST",
            "/v1/dashboards/${seg(dashboardId)}/widgets/${seg(widgetId)}/data",
            json = buildJsonObject { put("filters", filters) },
            idempotent = true,
        )
        return WidgetData.of(out?.jsonObject ?: JsonObject(emptyMap()))
    }
}

public class NotificationsApi internal constructor(t: Transport) : Resource(t) {
    public suspend fun list(unreadOnly: Boolean = false): List<Notification> =
        call(ListSerializer(Notification.serializer()), "GET", "/v1/notifications", mapOf("unread_only" to unreadOnly))

    public suspend fun markRead(notificationId: String) {
        t.request("POST", "/v1/notifications/${seg(notificationId)}/read", idempotent = true)
    }

    public suspend fun preferences(): NotificationPreferences = call(NotificationPreferences.serializer(), "GET", "/v1/notifications/preferences")

    public suspend fun setPreferences(email: List<String>): NotificationPreferences =
        call(NotificationPreferences.serializer(), "PUT", "/v1/notifications/preferences", body = sdkJson.encodeToJsonElement(NotificationPreferences.serializer(), NotificationPreferences(email)))
}

// -- JSON helpers --------------------------------------------------------------------------------------

/** `jsonObjectOf("age" to 42, "plan" to "pro")`. */
public fun jsonObjectOf(vararg pairs: Pair<String, Any?>): JsonObject = mapOf(*pairs).toJsonObject()

/** Convert plain Kotlin values (String, Number, Boolean, null, Map, Iterable, Array, JsonElement) to JSON. */
public fun Map<String, Any?>.toJsonObject(): JsonObject = JsonObject(mapValues { (_, v) -> v.toJsonElement() })

public fun Any?.toJsonElement(): JsonElement = when (this) {
    null -> JsonNull
    is JsonElement -> this
    is String -> JsonPrimitive(this)
    is Number -> JsonPrimitive(this)
    is Boolean -> JsonPrimitive(this)
    is Map<*, *> -> JsonObject(entries.associate { (k, v) -> k.toString() to v.toJsonElement() })
    is Iterable<*> -> JsonArray(map { it.toJsonElement() })
    is Array<*> -> JsonArray(map { it.toJsonElement() })
    else -> JsonPrimitive(toString())
}
