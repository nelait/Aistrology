/// Dart / Flutter client for the Analytics Platform API.
///
/// ```dart
/// final ap = AnalyticsPlatformClient(ClientConfig(
///   baseUrl: Uri.parse('https://analytics.example.com'),
///   tokenStore: mySecureStorageTokenStore,
/// ));
/// await ap.auth.login('ada@acme.example', password);
/// final out = await ap.endpoints.predict('churn', [{'tenure': 3, 'plan': 'pro'}]);
/// print(out.labels);
/// ```
library;

export 'src/client.dart';
export 'src/errors.dart';
export 'src/models.dart';
export 'src/token_store.dart';
