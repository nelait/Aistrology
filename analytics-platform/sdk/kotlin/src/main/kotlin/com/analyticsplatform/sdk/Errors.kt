package com.analyticsplatform.sdk

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Error hierarchy, mirroring the Python and TypeScript SDKs.
 *
 * ```
 * AnalyticsPlatformException          every error the SDK throws
 * ├── ApiException                    the server answered with a non-2xx status
 * │   ├── AuthenticationException     401
 * │   ├── ForbiddenException          403
 * │   ├── NotFoundException           404
 * │   ├── ConflictException           409
 * │   ├── ValidationException         422
 * │   ├── RateLimitException          429 (retryAfterSeconds)
 * │   └── ServerException             5xx
 * ├── NetworkException                no response (offline, DNS, connection reset)
 * ├── RequestTimeoutException         the client-side timeout elapsed
 * └── JobFailedException              jobs.wait() saw a job fail or get cancelled
 * ```
 */
public open class AnalyticsPlatformException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** A non-2xx response. [detail] is the FastAPI `detail` field; [code] is `detail.code` when present (e.g. `mfa_required`). */
public open class ApiException(
    public val status: Int,
    public val detail: JsonElement?,
    public val method: String,
    public val path: String,
) : AnalyticsPlatformException("$method $path -> HTTP $status: ${describe(detail)}") {
    public val code: String? = (detail as? JsonObject)?.get("code")?.let { (it as? JsonPrimitive)?.contentOrNull }

    internal companion object {
        fun describe(detail: JsonElement?): String = when (detail) {
            null -> "request failed"
            is JsonPrimitive -> detail.contentOrNull ?: "request failed"
            is JsonObject -> (detail["message"] as? JsonPrimitive)?.contentOrNull ?: detail.toString()
            else -> detail.toString()
        }
    }
}

public class AuthenticationException(status: Int, detail: JsonElement?, method: String, path: String) : ApiException(status, detail, method, path)

public class ForbiddenException(status: Int, detail: JsonElement?, method: String, path: String) : ApiException(status, detail, method, path)

public class NotFoundException(status: Int, detail: JsonElement?, method: String, path: String) : ApiException(status, detail, method, path)

public class ConflictException(status: Int, detail: JsonElement?, method: String, path: String) : ApiException(status, detail, method, path)

public class ValidationException(status: Int, detail: JsonElement?, method: String, path: String) : ApiException(status, detail, method, path)

public class RateLimitException(
    status: Int,
    detail: JsonElement?,
    method: String,
    path: String,
    /** Seconds from the `Retry-After` header, when the server sent one. */
    public val retryAfterSeconds: Double?,
) : ApiException(status, detail, method, path)

public class ServerException(status: Int, detail: JsonElement?, method: String, path: String) : ApiException(status, detail, method, path)

/** No HTTP response was received. */
public class NetworkException(message: String, cause: Throwable? = null) : AnalyticsPlatformException(message, cause)

/** The request (or `jobs.wait`) did not finish in time. */
public class RequestTimeoutException(message: String, cause: Throwable? = null) : AnalyticsPlatformException(message, cause)

/** `jobs.wait` saw the job end as `failed` or `cancelled`. */
public class JobFailedException(public val job: Job) :
    AnalyticsPlatformException("job ${job.id} ${job.status}${job.error?.let { ": $it" } ?: ""}")

internal fun apiError(status: Int, detail: JsonElement?, method: String, path: String, retryAfter: Double?): ApiException = when {
    status == 401 -> AuthenticationException(status, detail, method, path)
    status == 403 -> ForbiddenException(status, detail, method, path)
    status == 404 -> NotFoundException(status, detail, method, path)
    status == 409 -> ConflictException(status, detail, method, path)
    status == 422 -> ValidationException(status, detail, method, path)
    status == 429 -> RateLimitException(status, detail, method, path, retryAfter)
    status >= 500 -> ServerException(status, detail, method, path)
    else -> ApiException(status, detail, method, path)
}

