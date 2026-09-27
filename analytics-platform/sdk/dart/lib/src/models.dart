// Typed models for the responses mobile apps use. Unknown fields are ignored and kept in `raw` where useful.

typedef Json = Map<String, dynamic>;

T? _opt<T>(Object? v) => v is T ? v : null;

double? _num(Object? v) => v is num ? v.toDouble() : null;

/// A user session. Refresh tokens rotate: each one is valid for a single refresh.
class Tokens {
  const Tokens({required this.accessToken, required this.refreshToken, this.expiresIn, this.tokenType});

  factory Tokens.fromJson(Json json) => Tokens(
        accessToken: json['access_token'] as String,
        refreshToken: json['refresh_token'] as String,
        expiresIn: _opt<int>(json['expires_in']),
        tokenType: _opt<String>(json['token_type']),
      );

  final String accessToken;
  final String refreshToken;
  final int? expiresIn;
  final String? tokenType;

  Json toJson() => {
        'access_token': accessToken,
        'refresh_token': refreshToken,
        if (expiresIn != null) 'expires_in': expiresIn,
        if (tokenType != null) 'token_type': tokenType,
      };

  @override
  bool operator ==(Object other) =>
      other is Tokens &&
      other.accessToken == accessToken &&
      other.refreshToken == refreshToken &&
      other.expiresIn == expiresIn &&
      other.tokenType == tokenType;

  @override
  int get hashCode => Object.hash(accessToken, refreshToken, expiresIn, tokenType);
}

class Me {
  Me.fromJson(Json json)
      : tenantId = json['tenant_id'] as String,
        id = json['id'] as String,
        role = json['role'] as String,
        method = json['method'] as String,
        email = _opt<String>(json['email']),
        name = _opt<String>(json['name']);

  final String tenantId;
  final String id;
  final String role;

  /// `jwt`, `api_key`, `oauth_client`, ...
  final String method;
  final String? email;
  final String? name;
}

class Job {
  Job.fromJson(Json json)
      : id = json['id'] as String,
        type = json['type'] as String,
        status = json['status'] as String,
        progress = _num(json['progress']) ?? 0,
        message = _opt<String>(json['message']),
        params = _opt<Json>(json['params']) ?? const {},
        result = _opt<Json>(json['result']),
        error = _opt<String>(json['error']),
        createdAt = _opt<String>(json['created_at']),
        finishedAt = _opt<String>(json['finished_at']);

  final String id;
  final String type;

  /// `queued`, `running`, `succeeded`, `failed` or `cancelled`.
  final String status;
  final double progress;
  final String? message;
  final Json params;
  final Json? result;
  final String? error;
  final String? createdAt;
  final String? finishedAt;

  bool get isTerminal => const {'succeeded', 'failed', 'cancelled'}.contains(status);
}

class AppNotification {
  AppNotification.fromJson(Json json)
      : id = json['id'] as String,
        kind = json['kind'] as String,
        title = json['title'] as String,
        body = _opt<Json>(json['body']) ?? const {},
        read = json['read'] == true;

  final String id;

  /// e.g. `job.succeeded`, `endpoint.threshold`, `comment.mention`.
  final String kind;
  final String title;
  final Json body;
  final bool read;
}

class ModelVersionRef {
  ModelVersionRef.fromJson(Json json)
      : modelId = _opt<String>(json['model_id']),
        version = _opt<int>(json['version']);

  final String? modelId;
  final int? version;
}

class EndpointRoute {
  EndpointRoute.fromJson(Json json)
      : modelVersionId = json['model_version_id'] as String,
        weight = _num(json['weight']) ?? 0;

  final String modelVersionId;
  final double weight;
}

class Endpoint {
  Endpoint.fromJson(Json json)
      : id = json['id'] as String,
        name = json['name'] as String,
        status = json['status'] as String,
        routes = ((json['routes'] as List?) ?? const []).map((r) => EndpointRoute.fromJson(r as Json)).toList(),
        url = _opt<String>(json['url']),
        createdAt = _opt<String>(json['created_at']);

  final String id;
  final String name;
  final String status;
  final List<EndpointRoute> routes;
  final String? url;
  final String? createdAt;
}

class AnomalyPrediction {
  const AnomalyPrediction(this.isAnomaly, this.score);

  final bool isAnomaly;
  final double score;

  @override
  bool operator ==(Object other) => other is AnomalyPrediction && other.isAnomaly == isAnomaly && other.score == score;

  @override
  int get hashCode => Object.hash(isAnomaly, score);

  @override
  String toString() => 'AnomalyPrediction(isAnomaly: $isAnomaly, score: $score)';
}

/// Response of `predict` for classification, regression, clustering and anomaly endpoints. [predictions] stays
/// dynamic because its element type depends on the model; use [labels], [values] or [anomalies].
class PredictResponse {
  PredictResponse.fromJson(Json json)
      : predictions = (json['predictions'] as List?) ?? const [],
        probabilities = (json['probabilities'] as List?)?.map((row) => (row as List).map((p) => (p as num).toDouble()).toList()).toList(),
        classes = json['classes'] as List?,
        modelVersion = json['model_version'] is Map ? ModelVersionRef.fromJson(json['model_version'] as Json) : null,
        threshold = _num(json['threshold']),
        raw = json;

  final List<dynamic> predictions;
  final List<List<double>>? probabilities;
  final List<dynamic>? classes;
  final ModelVersionRef? modelVersion;

  /// Anomaly endpoints: the score above which a row is flagged.
  final double? threshold;
  final Json raw;

  /// Class labels as strings (classification).
  List<String?> get labels => predictions.map((p) => p?.toString()).toList();

  /// Numeric predictions (regression, cluster ids).
  List<double?> get values => predictions.map(_num).toList();

  /// Anomaly endpoints: `predictions: [{is_anomaly, score}]`.
  List<AnomalyPrediction> get anomalies => predictions.map((p) {
        final m = p as Map;
        return AnomalyPrediction(m['is_anomaly'] == true, _num(m['score']) ?? double.nan);
      }).toList();
}

/// Response of a forecasting endpoint.
class ForecastResponse {
  ForecastResponse.fromJson(Json json)
      : horizon = json['horizon'] as int,
        timestamps = ((json['timestamps'] as List?) ?? const []).cast<String>(),
        predictions = _doubles(json['predictions']),
        lower = _doubles(json['lower']),
        upper = _doubles(json['upper']),
        intervalLevel = _num(json['interval_level']),
        modelVersion = json['model_version'] is Map ? ModelVersionRef.fromJson(json['model_version'] as Json) : null;

  final int horizon;
  final List<String> timestamps;
  final List<double> predictions;
  final List<double> lower;
  final List<double> upper;
  final double? intervalLevel;
  final ModelVersionRef? modelVersion;

  static List<double> _doubles(Object? v) => ((v as List?) ?? const []).map((e) => (e as num).toDouble()).toList();
}

class Widget {
  Widget.fromJson(Json json)
      : id = _opt<String>(json['id']),
        type = json['type'] as String,
        title = _opt<String>(json['title']),
        config = _opt<Json>(json['config']) ?? const {},
        layout = _opt<Json>(json['layout']);

  final String? id;
  final String type;
  final String? title;
  final Json config;
  final Json? layout;
}

class DashboardPage {
  DashboardPage.fromJson(Json json)
      : id = _opt<String>(json['id']),
        title = _opt<String>(json['title']),
        widgets = ((json['widgets'] as List?) ?? const []).map((w) => Widget.fromJson(w as Json)).toList();

  final String? id;
  final String? title;
  final List<Widget> widgets;
}

class Dashboard {
  Dashboard.fromJson(Json json)
      : id = json['id'] as String,
        name = json['name'] as String,
        pages = (((json['spec'] as Map?)?['pages'] as List?) ?? const []).map((p) => DashboardPage.fromJson(p as Json)).toList(),
        filters = ((json['spec'] as Map?)?['filters'] as List?) ?? const [],
        ownerId = _opt<String>(json['owner_id']),
        yourRole = _opt<String>(json['your_role']),
        archived = json['archived'] == true,
        spec = _opt<Json>(json['spec']) ?? const {};

  final String id;
  final String name;
  final List<DashboardPage> pages;

  /// Global filters (`{id, column, kind?, default?}`).
  final List<dynamic> filters;
  final String? ownerId;
  final String? yourRole;
  final bool archived;

  /// The full spec, for fields not modelled here.
  final Json spec;

  /// Every widget across pages.
  List<Widget> get widgets => pages.expand((p) => p.widgets).toList();
}

/// Data for one widget: [columns] and [rows], plus widget-specific fields in [raw] (e.g. `value` for KPIs).
class WidgetData {
  WidgetData.fromJson(Json json)
      : columns = ((json['columns'] as List?) ?? const []).map((c) => '$c').toList(),
        rows = _rows(json),
        raw = json;

  final List<String> columns;
  final List<List<dynamic>> rows;
  final Json raw;

  static List<List<dynamic>> _rows(Json json) {
    final columns = ((json['columns'] as List?) ?? const []).map((c) => '$c').toList();
    return ((json['rows'] as List?) ?? const []).map<List<dynamic>>((row) {
      if (row is List) return row;
      if (row is Map) return columns.map((c) => row[c]).toList();
      return [row];
    }).toList();
  }
}
