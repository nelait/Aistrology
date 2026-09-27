import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'errors.dart';
import 'models.dart';
import 'token_store.dart';

/// Client configuration. Only [baseUrl] is required.
class ClientConfig {
  ClientConfig({
    required this.baseUrl,
    this.apiKey,
    TokenStore? tokenStore,
    this.maxRetries = 3,
    this.retryBaseDelay = const Duration(milliseconds: 500),
    this.maxRetryDelay = const Duration(seconds: 30),
    this.timeout = const Duration(seconds: 60),
    http.Client? httpClient,
    this.userAgent = 'analytics-platform-dart/0.1.0',
    Future<void> Function(Duration)? sleep,
    math.Random? random,
  })  : tokenStore = tokenStore ?? InMemoryTokenStore(),
        httpClient = httpClient ?? http.Client(),
        sleep = sleep ?? ((d) => Future<void>.delayed(d)),
        random = random ?? math.Random();

  /// API origin, e.g. `https://analytics.example.com`.
  final Uri baseUrl;

  /// An API key (`ap_live_…`), sent as `X-API-Key`. Takes precedence over user tokens.
  final String? apiKey;

  /// Where user tokens are kept; rotated refresh tokens are written back here.
  final TokenStore tokenStore;

  /// Retries after the first attempt for retryable failures.
  final int maxRetries;
  final Duration retryBaseDelay;

  /// Upper bound for one backoff or `Retry-After` wait.
  final Duration maxRetryDelay;

  /// Per-request timeout.
  final Duration timeout;
  final http.Client httpClient;
  final String userAgent;

  /// How the client waits between retries and job polls (tests replace it).
  final Future<void> Function(Duration) sleep;
  final math.Random random;
}

const _idempotentMethods = {'GET', 'PUT', 'DELETE', 'HEAD'};
const _retryable = {408, 429, 500, 502, 503, 504};
const _retryableUnsafe = {429, 503};

/// Authentication, single-flight token refresh, retries with backoff, and typed errors.
class Transport {
  Transport(this.config);

  final ClientConfig config;
  Future<Tokens>? _refreshing;

  bool get _usesApiKey => config.apiKey != null && config.apiKey!.isNotEmpty;

  Uri url(String path, [Map<String, Object?> query = const {}]) {
    final base = config.baseUrl.path.endsWith('/') ? config.baseUrl.path.substring(0, config.baseUrl.path.length - 1) : config.baseUrl.path;
    final q = <String, String>{
      for (final e in query.entries)
        if (e.value != null) e.key: '${e.value}',
    };
    return config.baseUrl.replace(path: '$base${path.startsWith('/') ? path : '/$path'}', queryParameters: q.isEmpty ? null : q);
  }

  /// Send a request (rebuilt by [build] for every attempt) with auth, token refresh and retries, and return the
  /// successful response.
  ///
  /// Idempotent requests are retried on 408/429/5xx, timeouts and connection errors; others only on 429/503
  /// (the server did not process them) and when the connection could not be established.
  Future<http.Response> send(
    String method,
    String path, {
    Map<String, Object?> query = const {},
    Object? json,
    http.BaseRequest Function(Uri url)? build,
    bool? idempotent,
    bool auth = true,
    String accept = 'application/json',
  }) async {
    final isIdempotent = idempotent ?? _idempotentMethods.contains(method);
    final target = url(path, query);
    var attempt = 0;
    var refreshed = false;
    while (true) {
      final request = build != null ? build(target) : http.Request(method, target);
      if (json != null && request is http.Request) {
        request.headers['Content-Type'] = 'application/json';
        request.body = jsonEncode(json);
      }
      request.headers['Accept'] = accept;
      request.headers['User-Agent'] = config.userAgent;
      String? sentToken;
      if (auth) {
        if (_usesApiKey) {
          request.headers['X-API-Key'] = config.apiKey!;
        } else {
          sentToken = (await config.tokenStore.load())?.accessToken;
          if (sentToken != null) request.headers['Authorization'] = 'Bearer $sentToken';
        }
      }

      http.Response response;
      try {
        response = await http.Response.fromStream(await config.httpClient.send(request).timeout(config.timeout)).timeout(config.timeout);
      } on TimeoutException catch (e) {
        if (isIdempotent && attempt < config.maxRetries) {
          await config.sleep(_backoff(attempt++));
          continue;
        }
        throw RequestTimeoutException('$method $path timed out', e);
      } on http.ClientException catch (e) {
        if ((_nothingSent(e) || isIdempotent) && attempt < config.maxRetries) {
          await config.sleep(_backoff(attempt++));
          continue;
        }
        throw NetworkException('$method $path failed: ${e.message}', e);
      }

      final status = response.statusCode;
      if (status >= 200 && status < 300) return response;

      if (status == 401 && auth && !_usesApiKey && !refreshed && sentToken != null) {
        refreshed = true;
        await refreshTokens(staleAccessToken: sentToken);
        continue;
      }

      final retryAfter = parseRetryAfter(response.headers['retry-after']);
      final canRetry = isIdempotent ? _retryable.contains(status) : _retryableUnsafe.contains(status);
      if (canRetry && attempt < config.maxRetries) {
        final wait = retryAfter == null ? _backoff(attempt) : (retryAfter > config.maxRetryDelay ? config.maxRetryDelay : retryAfter);
        attempt++;
        await config.sleep(wait);
        continue;
      }
      Object? detail;
      try {
        final parsed = jsonDecode(response.body);
        detail = parsed is Map && parsed.containsKey('detail') ? parsed['detail'] : parsed;
      } on FormatException {
        detail = response.body.isEmpty ? response.reasonPhrase : response.body;
      }
      throw apiError(status, detail, method, path, retryAfter);
    }
  }

  Future<dynamic> json(String method, String path,
      {Map<String, Object?> query = const {}, Object? body, bool? idempotent, bool auth = true}) async {
    final response = await send(method, path, query: query, json: body, idempotent: idempotent, auth: auth);
    if (response.statusCode == 204 || response.body.isEmpty) return null;
    return jsonDecode(utf8.decode(response.bodyBytes));
  }

  /// Exchange the refresh token for a new pair. Refresh tokens are single use, so concurrent 401s share one
  /// in-flight refresh; a caller whose token was already replaced just retries.
  Future<Tokens> refreshTokens({String? staleAccessToken}) {
    final inFlight = _refreshing;
    if (inFlight != null) return inFlight;
    final future = _doRefresh(staleAccessToken);
    _refreshing = future;
    return future.whenComplete(() {
      if (identical(_refreshing, future)) _refreshing = null;
    });
  }

  Future<Tokens> _doRefresh(String? staleAccessToken) async {
    final current = await config.tokenStore.load();
    if (current == null) {
      throw AuthenticationException(401, 'not logged in', method: 'POST', path: '/v1/auth/refresh');
    }
    if (staleAccessToken != null && current.accessToken != staleAccessToken) return current;
    try {
      final body = await json('POST', '/v1/auth/refresh', body: {'refresh_token': current.refreshToken}, idempotent: false, auth: false);
      final tokens = Tokens.fromJson(body as Json);
      await config.tokenStore.save(tokens);
      return tokens;
    } on AuthenticationException {
      // Expired, reused or revoked: the session is over.
      await config.tokenStore.save(null);
      rethrow;
    }
  }

  Duration _backoff(int attempt) {
    final d =
        math.min(config.maxRetryDelay.inMicroseconds.toDouble(), config.retryBaseDelay.inMicroseconds * math.pow(2, attempt).toDouble());
    return Duration(microseconds: (d / 2 + config.random.nextDouble() * d / 2).round());
  }

  static bool _nothingSent(http.ClientException e) {
    final m = e.message.toLowerCase();
    return m.contains('connection refused') || m.contains('failed host lookup') || m.contains('network is unreachable');
  }

  /// `Retry-After` as a duration: delta-seconds or an HTTP date.
  static Duration? parseRetryAfter(String? value) {
    if (value == null || value.trim().isEmpty) return null;
    final seconds = double.tryParse(value.trim());
    if (seconds != null) return Duration(milliseconds: (math.max(0, seconds) * 1000).round());
    final at = _parseHttpDate(value.trim());
    if (at == null) return null;
    final diff = at.difference(DateTime.now().toUtc());
    return diff.isNegative ? Duration.zero : diff;
  }

  static const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /// IMF-fixdate (`Wed, 21 Oct 2015 07:28:00 GMT`), without dart:io so it also works on the web.
  static DateTime? _parseHttpDate(String value) {
    final m = RegExp(r'^\w{3}, (\d{2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$').firstMatch(value);
    if (m == null) return null;
    final month = _months.indexOf(m.group(2)!) + 1;
    if (month == 0) return null;
    int g(int i) => int.parse(m.group(i)!);
    return DateTime.utc(g(3), month, g(1), g(4), g(5), g(6));
  }
}

/// Percent-encodes one path segment.
String _seg(String value) => Uri.encodeComponent(value);

/// Client for the Analytics Platform, focused on what mobile apps need: authentication (API key, or user login
/// with rotating refresh tokens persisted through a [TokenStore]), predictions (including anomaly and forecast
/// shapes), batch jobs, endpoint metadata, dashboards and notifications.
class AnalyticsPlatformClient {
  AnalyticsPlatformClient(ClientConfig config) : transport = Transport(config) {
    auth = AuthApi._(transport);
    endpoints = EndpointsApi._(transport);
    jobs = JobsApi._(transport);
    dashboards = DashboardsApi._(transport);
    notifications = NotificationsApi._(transport);
  }

  final Transport transport;
  late final AuthApi auth;
  late final EndpointsApi endpoints;
  late final JobsApi jobs;
  late final DashboardsApi dashboards;
  late final NotificationsApi notifications;

  /// Escape hatch for endpoints this SDK does not wrap: returns decoded JSON (or `null` for 204).
  Future<dynamic> request(String method, String path, {Map<String, Object?> query = const {}, Object? body, bool? idempotent}) =>
      transport.json(method, path, query: query, body: body, idempotent: idempotent);

  void close() => transport.config.httpClient.close();
}

class AuthApi {
  AuthApi._(this._t);

  final Transport _t;

  /// Log in with email and password (and a TOTP code when MFA is on). The tokens are saved to the [TokenStore],
  /// used for later calls and refreshed automatically. Failures throw [AuthenticationException] with `code`
  /// `invalid_credentials`, `mfa_required`, `locked`, ...
  Future<Tokens> login(String email, String password, {String? totp}) async {
    final body =
        await _t.json('POST', '/v1/auth/login', body: {'email': email, 'password': password, if (totp != null) 'totp': totp}, auth: false);
    final tokens = Tokens.fromJson(body as Json);
    await _t.config.tokenStore.save(tokens);
    return tokens;
  }

  /// Refresh now (normally automatic on a 401). The rotated pair is saved to the [TokenStore].
  Future<Tokens> refresh() => _t.refreshTokens();

  /// Revoke the refresh token and clear the stored session.
  Future<void> logout() async {
    final tokens = await _t.config.tokenStore.load();
    try {
      if (tokens != null) await _t.json('POST', '/v1/auth/logout', body: {'refresh_token': tokens.refreshToken}, auth: false);
    } finally {
      await _t.config.tokenStore.save(null);
    }
  }

  Future<bool> isLoggedIn() async => await _t.config.tokenStore.load() != null;

  /// The authenticated principal (user, API key or OAuth client).
  Future<Me> me() async => Me.fromJson(await _t.json('GET', '/v1/auth/me') as Json);
}

class EndpointsApi {
  EndpointsApi._(this._t);

  final Transport _t;

  Future<List<Endpoint>> list() async =>
      ((await _t.json('GET', '/v1/endpoints')) as List).map((e) => Endpoint.fromJson(e as Json)).toList();

  Future<Endpoint> get(String name) async => Endpoint.fromJson(await _t.json('GET', '/v1/endpoints/${_seg(name)}') as Json);

  /// The endpoint's OpenAPI document, generated from the model signature (feature names, types, ranges).
  Future<Json> openApi(String name) async => await _t.json('GET', '/v1/endpoints/${_seg(name)}/openapi.json') as Json;

  /// Request counts and latency percentiles over the last [hours].
  Future<Json> metrics(String name, {int hours = 24}) async =>
      await _t.json('GET', '/v1/endpoints/${_seg(name)}/metrics', query: {'hours': hours}) as Json;

  /// Real-time inference. Predictions have no side effects, so they are retried like reads (5xx, timeouts, 429
  /// honoring `Retry-After`). For anomaly endpoints use [PredictResponse.anomalies].
  Future<PredictResponse> predict(String name, List<Map<String, Object?>> instances, {bool explain = false}) async {
    final out =
        await _t.json('POST', '/v1/endpoints/${_seg(name)}/predict', body: {'instances': instances, 'explain': explain}, idempotent: true);
    return PredictResponse.fromJson(out as Json);
  }

  /// Forecast [horizon] steps (default: the trained horizon), optionally refitting with recent [history].
  Future<ForecastResponse> forecast(String name, {int? horizon, List<Map<String, Object?>>? history}) async {
    final body = {if (horizon != null) 'horizon': horizon, if (history != null) 'history': history, 'explain': false};
    return ForecastResponse.fromJson(await _t.json('POST', '/v1/endpoints/${_seg(name)}/predict', body: body, idempotent: true) as Json);
  }

  /// Start a batch prediction job over a CSV. Uploads are not idempotent (each creates a job): a 5xx or timeout
  /// is not retried, only 429/503, which mean the server did not accept the request.
  Future<Job> batch(String name, Uint8List csv, {String filename = 'input.csv'}) async {
    final response = await _t.send(
      'POST',
      '/v1/endpoints/${_seg(name)}/batch',
      idempotent: false,
      build: (url) => http.MultipartRequest('POST', url)..files.add(http.MultipartFile.fromBytes('file', csv, filename: filename)),
    );
    return Job.fromJson(jsonDecode(response.body) as Json);
  }

  /// Start a batch prediction job over a stored dataset.
  Future<Job> batchFromDataset(String name, String datasetId) async =>
      Job.fromJson(await _t.json('POST', '/v1/endpoints/${_seg(name)}/batch', body: {'dataset_id': datasetId}) as Json);

  /// Download the CSV output of a finished batch job.
  Future<Uint8List> batchResult(String name, String jobId) async =>
      (await _t.send('GET', '/v1/endpoints/${_seg(name)}/batch/${_seg(jobId)}', accept: 'text/csv, */*')).bodyBytes;
}

class JobsApi {
  JobsApi._(this._t);

  final Transport _t;

  Future<Job> get(String id) async => Job.fromJson(await _t.json('GET', '/v1/jobs/${_seg(id)}') as Json);

  Future<List<Job>> list({String? status}) async =>
      ((await _t.json('GET', '/v1/jobs', query: {'status': status})) as List).map((j) => Job.fromJson(j as Json)).toList();

  Future<Job> cancel(String id) async => Job.fromJson(await _t.json('POST', '/v1/jobs/${_seg(id)}/cancel') as Json);

  /// Poll until the job finishes: the interval starts at [interval] and grows 1.5x up to 10 s. Throws
  /// [JobFailedException] when it fails or is cancelled and [RequestTimeoutException] after [timeout].
  Future<Job> wait(String id, {Duration interval = const Duration(seconds: 1), Duration? timeout, void Function(Job)? onProgress}) async {
    final deadline = timeout == null ? null : DateTime.now().add(timeout);
    var delay = interval;
    while (true) {
      final job = await get(id);
      onProgress?.call(job);
      if (job.status == 'succeeded') return job;
      if (job.status == 'failed' || job.status == 'cancelled') throw JobFailedException(job);
      if (deadline != null && !DateTime.now().isBefore(deadline)) {
        throw RequestTimeoutException('job $id did not finish within $timeout (status ${job.status})');
      }
      await _t.config.sleep(delay);
      final next = Duration(microseconds: (delay.inMicroseconds * 1.5).round());
      delay = next > const Duration(seconds: 10) ? const Duration(seconds: 10) : next;
    }
  }
}

class DashboardsApi {
  DashboardsApi._(this._t);

  final Transport _t;

  Future<List<Dashboard>> list() async =>
      ((await _t.json('GET', '/v1/dashboards')) as List).map((d) => Dashboard.fromJson(d as Json)).toList();

  Future<Dashboard> get(String id) async => Dashboard.fromJson(await _t.json('GET', '/v1/dashboards/${_seg(id)}') as Json);

  /// Data for one widget with global [filters] applied (`{column: value | [values] | {min, max}}`). Read-only,
  /// so it is retried like a GET.
  Future<WidgetData> widgetData(String dashboardId, String widgetId, {Map<String, Object?> filters = const {}}) async {
    final out = await _t.json('POST', '/v1/dashboards/${_seg(dashboardId)}/widgets/${_seg(widgetId)}/data',
        body: {'filters': filters}, idempotent: true);
    return WidgetData.fromJson(out as Json);
  }
}

class NotificationsApi {
  NotificationsApi._(this._t);

  final Transport _t;

  Future<List<AppNotification>> list({bool unreadOnly = false}) async =>
      ((await _t.json('GET', '/v1/notifications', query: {'unread_only': unreadOnly})) as List)
          .map((n) => AppNotification.fromJson(n as Json))
          .toList();

  Future<void> markRead(String id) => _t.json('POST', '/v1/notifications/${_seg(id)}/read', idempotent: true);

  /// Notification kinds emailed to the user (users only).
  Future<List<String>> preferences() async =>
      ((await _t.json('GET', '/v1/notifications/preferences') as Json)['email'] as List).cast<String>();

  Future<List<String>> setPreferences(List<String> email) async =>
      ((await _t.json('PUT', '/v1/notifications/preferences', body: {'email': email}) as Json)['email'] as List).cast<String>();
}
