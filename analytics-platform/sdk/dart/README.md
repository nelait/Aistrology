# Analytics Platform: Dart / Flutter SDK

A pure-Dart client for Flutter apps (Android, iOS, web, desktop) and Dart servers (requirement SDK-005). It is built on `package:http` and does not import `dart:io`, so it also runs on the web. It covers what an app needs:

- **Auth:** an API key, or user login with rotating refresh tokens persisted through a pluggable `TokenStore`.
- **Predictions**, including anomaly (`anomalies`, `threshold`) and forecast (`ForecastResponse`) shapes.
- **Batch jobs:** submit a CSV or a stored dataset, poll with `jobs.wait`, download the result.
- **Endpoint metadata:** `get`, `list`, the generated OpenAPI document, and metrics.
- **Dashboards:** read them and fetch widget data with filters.
- **Notifications:** list, mark read, and email preferences.

For other endpoints, use `client.request(method, path, ...)`.

## Install

```yaml
dependencies:
  analytics_platform:
    path: ../analytics-platform/sdk/dart   # or a git dependency
```

## Usage

```dart
import 'package:analytics_platform/analytics_platform.dart';

final ap = AnalyticsPlatformClient(ClientConfig(
  baseUrl: Uri.parse('https://analytics.example.com'),
  tokenStore: SecureTokenStore(), // e.g. flutter_secure_storage; see TokenStore's doc comment
));

try {
  await ap.auth.login('ada@acme.example', password, totp: code);
} on AuthenticationException catch (e) {
  if (e.code == 'mfa_required') askForTotp();
}

final out = await ap.endpoints.predict('churn', [{'tenure': 3, 'plan': 'pro'}]);
out.labels;          // ['yes']
out.probabilities;   // [[0.2, 0.8]]

final fraud = await ap.endpoints.predict('fraud', [{'amount': 9000}]);
fraud.anomalies;     // [AnomalyPrediction(isAnomaly: true, score: 0.93)]
final sales = await ap.endpoints.forecast('sales', horizon: 14);

final job = await ap.endpoints.batch('churn', csvBytes, filename: 'customers.csv');
await ap.jobs.wait(job.id, onProgress: (j) => setState(() => progress = j.progress));
final csv = await ap.endpoints.batchResult('churn', job.id);

final spec = await ap.endpoints.openApi('churn'); // feature names, types and ranges, e.g. to build a form
final dashboard = await ap.dashboards.get(dashboardId);
final data = await ap.dashboards.widgetData(dashboardId, dashboard.widgets.first.id!, filters: {'region': ['eu']});
final unread = await ap.notifications.list(unreadOnly: true);
```

## Behaviour

- **Sessions:** refresh tokens are single use. Concurrent 401s share one in-flight refresh, and every rotated pair is saved to the `TokenStore`. If the refresh token is rejected, the store is cleared and `AuthenticationException` is thrown.
- **Retries:** exponential backoff with jitter. A `Retry-After` header is honored (seconds or HTTP date).
  - `predict`, `forecast`, widget data and GET/PUT/DELETE are idempotent. They are retried on 408/429/5xx, timeouts and connection errors.
  - Uploads (`batch` with a CSV) and other POSTs are **not** retried on 5xx or timeouts. They are retried only on 429/503, or when the connection could not be established (refused, or DNS failure).
- **Errors** mirror the other SDKs:
  - `ApiException`, with `status`, `code` and `detail`. Its subclasses are `AuthenticationException`, `ForbiddenException`, `NotFoundException`, `ConflictException`, `ValidationException`, `RateLimitException` (with `retryAfter`) and `ServerException`.
  - `NetworkException`, `RequestTimeoutException` and `JobFailedException`. All of them extend `AnalyticsPlatformException`.
- **Configuration:** `ClientConfig(maxRetries, retryBaseDelay, maxRetryDelay, timeout, httpClient, sleep)`. Inject any `http.Client`, such as `MockClient` in tests or a `cronet_http` / `cupertino_http` client in Flutter.

## Develop

```bash
cd analytics-platform/sdk/dart
dart pub get
dart format --output=none --set-exit-if-changed .
dart analyze --fatal-infos
dart test
```

Verified here with the Dart SDK 3.13.4: `dart analyze` reports no issues and `dart test` passes 12 tests (with `MockClient`). The tests cover auth, refresh rotation, retries, idempotency, typed errors, anomaly/forecast parsing, jobs, dashboards and notifications. CI runs the same steps (`sdk-dart` job).
