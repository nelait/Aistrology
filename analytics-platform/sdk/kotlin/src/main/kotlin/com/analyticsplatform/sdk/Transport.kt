package com.analyticsplatform.sdk

import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.time.Duration
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.min
import kotlin.math.pow

/** Client configuration. Only [baseUrl] is required. */
public class ClientConfig(
    /** API origin, e.g. `https://analytics.example.com`. */
    public val baseUrl: String,
    /** An API key (`ap_live_…`), sent as `X-API-Key`. Takes precedence over user tokens. */
    public val apiKey: String? = null,
    /** Where user tokens are kept; rotated refresh tokens are written back here. */
    public val tokenStore: TokenStore = InMemoryTokenStore(),
    /** Retries after the first attempt for retryable failures. */
    public val maxRetries: Int = 3,
    public val retryBaseDelayMillis: Long = 500,
    /** Upper bound for one backoff or `Retry-After` wait. */
    public val maxRetryDelayMillis: Long = 30_000,
    /** Per-call timeout. */
    public val timeoutMillis: Long = 60_000,
    /** Bring your own OkHttp client (interceptors, certificate pinning, ...). */
    public val httpClient: OkHttpClient? = null,
    public val userAgent: String = "analytics-platform-kotlin/0.1.0",
    /** How the client waits between retries and job polls (tests replace it). */
    public val sleeper: suspend (Long) -> Unit = { delay(it) },
)

internal val JSON_MEDIA = "application/json".toMediaType()

internal val sdkJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    isLenient = false
}

/** Authentication, single-flight token refresh, retries with backoff, and typed errors. */
internal class Transport(private val config: ClientConfig) {
    private val baseUrl: HttpUrl = config.baseUrl.trimEnd('/').toHttpUrl()
    private val http: OkHttpClient = (config.httpClient ?: OkHttpClient()).newBuilder()
        .callTimeout(config.timeoutMillis, TimeUnit.MILLISECONDS)
        .build()
    private val refreshLock = Mutex()

    val tokenStore: TokenStore get() = config.tokenStore
    val sleeper: suspend (Long) -> Unit get() = config.sleeper

    fun url(path: String, query: Map<String, Any?> = emptyMap()): HttpUrl {
        val builder = baseUrl.newBuilder()
        path.trim('/').split('/').filter { it.isNotEmpty() }.forEach { builder.addPathSegment(it) }
        query.forEach { (k, v) -> if (v != null) builder.addQueryParameter(k, v.toString()) }
        return builder.build()
    }

    /**
     * Send a request and return the successful response (the caller closes it).
     *
     * [idempotent] decides what is retried: idempotent requests on 408/429/5xx, timeouts and connection errors;
     * others only on 429/503 (the server did not process them) and when the connection failed before anything
     * was sent. [path] segments must already be split (use [Resource.path]).
     */
    suspend fun execute(
        method: String,
        url: HttpUrl,
        body: RequestBody? = null,
        idempotent: Boolean = method in IDEMPOTENT,
        auth: Boolean = true,
        headers: Map<String, String> = emptyMap(),
        maxRetries: Int = config.maxRetries,
    ): Response {
        val path = url.encodedPath
        var attempt = 0
        var refreshed = false
        while (true) {
            val sentToken = if (auth && config.apiKey.isNullOrEmpty()) tokenStore.load()?.accessToken else null
            val request = Request.Builder().url(url).method(method, body ?: if (method in BODY_REQUIRED) EMPTY_BODY else null).apply {
                header("Accept", "application/json")
                header("User-Agent", config.userAgent)
                if (auth) {
                    if (!config.apiKey.isNullOrEmpty()) header("X-API-Key", config.apiKey) else if (sentToken != null) header("Authorization", "Bearer $sentToken")
                }
                headers.forEach { (k, v) -> header(k, v) }
            }.build()

            val response = try {
                http.newCall(request).await()
            } catch (e: IOException) {
                val nothingSent = e is ConnectException || e is UnknownHostException || e is NoRouteToHostException
                val retryable = nothingSent || idempotent
                if (retryable && attempt < maxRetries) {
                    config.sleeper(backoff(attempt))
                    attempt++
                    continue
                }
                if (e is SocketTimeoutException || e.message?.contains("timeout", ignoreCase = true) == true) {
                    throw RequestTimeoutException("$method $path timed out", e)
                }
                throw NetworkException("$method $path failed: ${e.message}", e)
            }

            val status = response.code
            if (response.isSuccessful) return response

            if (status == 401 && auth && config.apiKey.isNullOrEmpty() && !refreshed && sentToken != null) {
                response.close()
                refreshed = true
                refreshTokens(sentToken)
                continue
            }

            val retryable = if (idempotent) status in RETRYABLE else status in RETRYABLE_UNSAFE
            if (retryable && attempt < maxRetries) {
                val retryAfter = parseRetryAfter(response.header("Retry-After"))
                response.close()
                config.sleeper(retryAfter?.let { min((it * 1000).toLong(), config.maxRetryDelayMillis) } ?: backoff(attempt))
                attempt++
                continue
            }
            throw toError(response, method, path)
        }
    }

    suspend fun request(
        method: String,
        path: String,
        query: Map<String, Any?> = emptyMap(),
        json: JsonElement? = null,
        idempotent: Boolean = method in IDEMPOTENT,
        auth: Boolean = true,
    ): JsonElement? {
        val body = json?.let { sdkJson.encodeToString(JsonElement.serializer(), it).toRequestBody(JSON_MEDIA) }
        return execute(method, url(path, query), body, idempotent, auth).use { response ->
            val text = response.body?.string().orEmpty()
            if (response.code == 204 || text.isEmpty()) null else sdkJson.parseToJsonElement(text)
        }
    }

    suspend fun bytes(method: String, path: String, query: Map<String, Any?> = emptyMap()): ByteArray =
        execute(method, url(path, query), headers = mapOf("Accept" to "*/*")).use { it.body?.bytes() ?: ByteArray(0) }

    /**
     * Exchange the refresh token for a new pair. Refresh tokens are single use, so concurrent 401s share one
     * refresh: whoever gets the lock second sees that the access token already changed and just retries.
     */
    suspend fun refreshTokens(staleAccessToken: String?): Tokens = refreshLock.withLock {
        val current = tokenStore.load() ?: throw AuthenticationException(401, JsonPrimitive("not logged in"), "POST", "/v1/auth/refresh")
        if (staleAccessToken != null && current.accessToken != staleAccessToken) return@withLock current
        val body = sdkJson.encodeToString(JsonObject.serializer(), JsonObject(mapOf("refresh_token" to JsonPrimitive(current.refreshToken))))
        val response = try {
            execute("POST", url("/v1/auth/refresh"), body.toRequestBody(JSON_MEDIA), idempotent = false, auth = false)
        } catch (e: AuthenticationException) {
            // Expired, reused or revoked: the session is over.
            tokenStore.save(null)
            throw e
        }
        val tokens = response.use { sdkJson.decodeFromString(Tokens.serializer(), it.body!!.string()) }
        tokenStore.save(tokens)
        tokens
    }

    private fun backoff(attempt: Int): Long {
        val d = min(config.maxRetryDelayMillis.toDouble(), config.retryBaseDelayMillis * 2.0.pow(attempt))
        return (d / 2 + Math.random() * d / 2).toLong()
    }

    private fun toError(response: Response, method: String, path: String): ApiException = response.use {
        val text = runCatching { it.body?.string() }.getOrNull().orEmpty()
        val parsed = runCatching { sdkJson.parseToJsonElement(text) }.getOrNull()
        val detail = (parsed as? JsonObject)?.get("detail") ?: parsed ?: JsonPrimitive(text.ifEmpty { it.message })
        apiError(it.code, detail, method, path, parseRetryAfter(it.header("Retry-After")))
    }

    internal companion object {
        val IDEMPOTENT = setOf("GET", "PUT", "DELETE", "HEAD")
        val BODY_REQUIRED = setOf("POST", "PUT", "PATCH")
        val RETRYABLE = setOf(408, 429, 500, 502, 503, 504)
        val RETRYABLE_UNSAFE = setOf(429, 503)
        val EMPTY_BODY: RequestBody = ByteArray(0).toRequestBody(null)

        /** `Retry-After` as seconds: delta-seconds or an HTTP date. */
        fun parseRetryAfter(value: String?): Double? {
            if (value.isNullOrBlank()) return null
            value.trim().toDoubleOrNull()?.let { return maxOf(0.0, it) }
            return runCatching {
                val at = ZonedDateTime.parse(value.trim(), DateTimeFormatter.RFC_1123_DATE_TIME)
                maxOf(0.0, Duration.between(ZonedDateTime.now(at.zone), at).toMillis() / 1000.0)
            }.getOrNull()
        }
    }
}

private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = cont.resume(response)

        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }
    })
    cont.invokeOnCancellation { runCatching { cancel() } }
}
