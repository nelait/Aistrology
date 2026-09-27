import 'models.dart';

/// Where the user session lives between app launches. Refresh tokens rotate on every refresh, so the store is
/// written after login and after every refresh; a stale refresh token is rejected by the server.
///
/// In Flutter, implement it with `flutter_secure_storage` (Keychain / Android Keystore):
///
/// ```dart
/// class SecureTokenStore implements TokenStore {
///   final _storage = const FlutterSecureStorage();
///   @override
///   Future<Tokens?> load() async {
///     final raw = await _storage.read(key: 'ap_session');
///     return raw == null ? null : Tokens.fromJson(jsonDecode(raw) as Map<String, dynamic>);
///   }
///   @override
///   Future<void> save(Tokens? tokens) => tokens == null
///       ? _storage.delete(key: 'ap_session')
///       : _storage.write(key: 'ap_session', value: jsonEncode(tokens.toJson()));
/// }
/// ```
abstract interface class TokenStore {
  Future<Tokens?> load();

  /// Persist [tokens], or clear the session when `null` (logout, or a rejected refresh token).
  Future<void> save(Tokens? tokens);
}

/// Keeps the session in memory only (the default): the user logs in again after a restart.
class InMemoryTokenStore implements TokenStore {
  InMemoryTokenStore([this._tokens]);

  Tokens? _tokens;

  @override
  Future<Tokens?> load() async => _tokens;

  @override
  Future<void> save(Tokens? tokens) async => _tokens = tokens;
}
