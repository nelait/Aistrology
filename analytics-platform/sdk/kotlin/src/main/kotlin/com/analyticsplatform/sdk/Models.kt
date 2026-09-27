package com.analyticsplatform.sdk

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

// -- auth -----------------------------------------------------------------------------------------

/** A user session. Refresh tokens rotate: each one is valid for a single refresh. */
@Serializable
public data class Tokens(
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String,
    @SerialName("expires_in") val expiresIn: Long? = null,
    @SerialName("token_type") val tokenType: String? = null,
)

@Serializable
public data class Me(
    @SerialName("tenant_id") val tenantId: String,
    val id: String,
    val role: String,
    /** `jwt`, `api_key`, `oauth_client`, ... */
    val method: String,
    val email: String? = null,
    val name: String? = null,
    @SerialName("mfa_enabled") val mfaEnabled: Boolean? = null,
)

// -- jobs and notifications -----------------------------------------------------------------------

@Serializable
public data class Job(
    val id: String,
    val type: String,
    /** `queued`, `running`, `succeeded`, `failed` or `cancelled`. */
    val status: String,
    val progress: Double = 0.0,
    val message: String? = null,
    val params: JsonObject = JsonObject(emptyMap()),
    val result: JsonObject? = null,
    val error: String? = null,
    val attempts: Int = 0,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("finished_at") val finishedAt: String? = null,
) {
    val isTerminal: Boolean get() = status in TERMINAL_STATUSES

    public companion object {
        public val TERMINAL_STATUSES: Set<String> = setOf("succeeded", "failed", "cancelled")
    }
}

@Serializable
public data class Notification(
    val id: String,
    /** e.g. `job.succeeded`, `endpoint.threshold`, `comment.mention`. */
    val kind: String,
    val title: String,
    val body: JsonObject = JsonObject(emptyMap()),
    val read: Boolean = false,
)

@Serializable
public data class NotificationPreferences(
    /** Kinds emailed to the user, e.g. `job.failed`, or `*`. */
    val email: List<String>,
)

// -- serving --------------------------------------------------------------------------------------

@Serializable
public data class ModelVersionRef(
    @SerialName("model_id") val modelId: String? = null,
    val version: Int? = null,
    @SerialName("model_version_id") val modelVersionId: String? = null,
)

@Serializable
public data class EndpointRoute(
    @SerialName("model_version_id") val modelVersionId: String,
    val weight: Double,
    @SerialName("model_id") val modelId: String? = null,
    val version: Int? = null,
)

@Serializable
public data class Endpoint(
    val id: String,
    val name: String,
    val routes: List<EndpointRoute> = emptyList(),
    val status: String,
    @SerialName("min_replicas") val minReplicas: Int = 0,
    @SerialName("log_payloads") val logPayloads: Boolean = false,
    @SerialName("cors_origins") val corsOrigins: List<String> = emptyList(),
    @SerialName("created_at") val createdAt: String? = null,
    val url: String? = null,
)

/**
 * Response of `POST /v1/endpoints/{name}/predict` for classification, regression, clustering and anomaly
 * endpoints. [predictions] stays raw JSON because its element type depends on the model; use the typed
 * accessors ([labels], [values], [anomalies]).
 */
@Serializable
public data class PredictResponse(
    val predictions: JsonArray,
    val probabilities: List<List<Double>>? = null,
    val classes: JsonArray? = null,
    @SerialName("model_version") val modelVersion: ModelVersionRef? = null,
    /** Anomaly endpoints: the score above which a row is flagged. */
    val threshold: Double? = null,
    val shap: List<Map<String, Double>>? = null,
) {
    /** Class labels (classification) as strings. */
    public fun labels(): List<String?> = predictions.map { (it as? JsonPrimitive)?.content }

    /** Numeric predictions (regression, clustering ids). */
    public fun values(): List<Double?> = predictions.map { (it as? JsonPrimitive)?.doubleOrNull }

    /** Anomaly endpoints: `predictions: [{is_anomaly, score}]`. */
    public fun anomalies(): List<AnomalyPrediction> = predictions.map { el ->
        val obj = el as? JsonObject ?: throw AnalyticsPlatformException("not an anomaly prediction: $el")
        AnomalyPrediction(
            isAnomaly = (obj["is_anomaly"] as? JsonPrimitive)?.booleanOrNull ?: false,
            score = (obj["score"] as? JsonPrimitive)?.doubleOrNull ?: Double.NaN,
        )
    }
}

public data class AnomalyPrediction(val isAnomaly: Boolean, val score: Double)

/** Response of a forecasting endpoint. */
@Serializable
public data class ForecastResponse(
    val horizon: Int,
    val timestamps: List<String>,
    val predictions: List<Double>,
    val lower: List<Double> = emptyList(),
    val upper: List<Double> = emptyList(),
    @SerialName("interval_level") val intervalLevel: Double? = null,
    @SerialName("model_version") val modelVersion: ModelVersionRef? = null,
)

// -- dashboards -----------------------------------------------------------------------------------

@Serializable
public data class Widget(
    val id: String? = null,
    val type: String,
    val title: String? = null,
    val config: JsonObject = JsonObject(emptyMap()),
    val layout: JsonObject? = null,
)

@Serializable
public data class DashboardPage(
    val id: String? = null,
    val title: String? = null,
    val widgets: List<Widget> = emptyList(),
)

@Serializable
public data class DashboardSpec(
    val pages: List<DashboardPage> = emptyList(),
    val filters: JsonArray = JsonArray(emptyList()),
    val theme: JsonElement? = null,
    @SerialName("refresh_seconds") val refreshSeconds: Int? = null,
) {
    /** Every widget across pages. */
    val widgets: List<Widget> get() = pages.flatMap { it.widgets }
}

@Serializable
public data class Dashboard(
    val id: String,
    val name: String,
    val spec: DashboardSpec = DashboardSpec(),
    @SerialName("owner_id") val ownerId: String? = null,
    val archived: Boolean = false,
    @SerialName("your_role") val yourRole: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
)

/** Data for one widget: [columns] and [rows] plus widget-specific fields in [raw] (e.g. `value` for KPIs). */
public data class WidgetData(val columns: List<String>, val rows: List<List<JsonElement>>, val raw: JsonObject) {
    internal companion object {
        fun of(obj: JsonObject): WidgetData {
            val columns = (obj["columns"] as? JsonArray)?.map { it.jsonPrimitive.content } ?: emptyList()
            val rows = (obj["rows"] as? JsonArray)?.map { row ->
                when (row) {
                    is JsonArray -> row.toList()
                    is JsonObject -> columns.map { row[it] ?: JsonNull }
                    else -> listOf(row)
                }
            } ?: emptyList()
            return WidgetData(columns, rows, obj)
        }
    }
}

