import 'models.dart';

/// Base class for every error the SDK throws. The hierarchy mirrors the Python and TypeScript SDKs:
///
/// ```
/// AnalyticsPlatformException
/// ├── ApiException                 non-2xx response
/// │   ├── AuthenticationException  401
/// │   ├── ForbiddenException       403
/// │   ├── NotFoundException        404
/// │   ├── ConflictException        409
/// │   ├── ValidationException      422
/// │   ├── RateLimitException       429 (retryAfter)
/// │   └── ServerException          5xx
/// ├── NetworkException             no response (offline, DNS, connection reset)
/// ├── RequestTimeoutException      client-side timeout
/// └── JobFailedException           jobs.wait() saw a job fail or get cancelled
/// ```
class AnalyticsPlatformException implements Exception {
  AnalyticsPlatformException(this.message, [this.cause]);

  final String message;
  final Object? cause;

  @override
  String toString() => '$runtimeType: $message';
}

/// A non-2xx response. [detail] is the server's FastAPI `detail`; [code] is `detail.code` when present
/// (e.g. `invalid_credentials`, `mfa_required`, `quota_exceeded`).
class ApiException extends AnalyticsPlatformException {
  ApiException(this.status, this.detail, {required this.method, required this.path})
      : code = detail is Map && detail['code'] is String ? detail['code'] as String : null,
        super('$method $path -> HTTP $status: ${_describe(detail)}');

  final int status;
  final Object? detail;
  final String? code;
  final String method;
  final String path;

  static String _describe(Object? detail) {
    if (detail == null) return 'request failed';
    if (detail is String) return detail;
    if (detail is Map && detail['message'] != null) return '${detail['message']}';
    if (detail is List) {
      return detail.map((d) => d is Map ? (d['msg'] ?? d['message'] ?? '$d') : '$d').join('; ');
    }
    return '$detail';
  }
}

class AuthenticationException extends ApiException {
  AuthenticationException(super.status, super.detail, {required super.method, required super.path});
}

class ForbiddenException extends ApiException {
  ForbiddenException(super.status, super.detail, {required super.method, required super.path});
}

class NotFoundException extends ApiException {
  NotFoundException(super.status, super.detail, {required super.method, required super.path});
}

class ConflictException extends ApiException {
  ConflictException(super.status, super.detail, {required super.method, required super.path});
}

class ValidationException extends ApiException {
  ValidationException(super.status, super.detail, {required super.method, required super.path});
}

class RateLimitException extends ApiException {
  RateLimitException(super.status, super.detail, {required super.method, required super.path, this.retryAfter});

  /// From the `Retry-After` header, when the server sent one.
  final Duration? retryAfter;
}

class ServerException extends ApiException {
  ServerException(super.status, super.detail, {required super.method, required super.path});
}

class NetworkException extends AnalyticsPlatformException {
  NetworkException(super.message, [super.cause]);
}

class RequestTimeoutException extends AnalyticsPlatformException {
  RequestTimeoutException(super.message, [super.cause]);
}

class JobFailedException extends AnalyticsPlatformException {
  JobFailedException(this.job) : super('job ${job.id} ${job.status}${job.error != null ? ': ${job.error}' : ''}');

  final Job job;
}

ApiException apiError(int status, Object? detail, String method, String path, Duration? retryAfter) {
  switch (status) {
    case 401:
      return AuthenticationException(status, detail, method: method, path: path);
    case 403:
      return ForbiddenException(status, detail, method: method, path: path);
    case 404:
      return NotFoundException(status, detail, method: method, path: path);
    case 409:
      return ConflictException(status, detail, method: method, path: path);
    case 422:
      return ValidationException(status, detail, method: method, path: path);
    case 429:
      return RateLimitException(status, detail, method: method, path: path, retryAfter: retryAfter);
  }
  if (status >= 500) return ServerException(status, detail, method: method, path: path);
  return ApiException(status, detail, method: method, path: path);
}
