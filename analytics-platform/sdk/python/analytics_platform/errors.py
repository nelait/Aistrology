"""Typed errors raised by the SDK (SDK-008)."""

from __future__ import annotations

from typing import Any


class AnalyticsPlatformError(Exception):
    """Base class for every SDK error."""


class ApiError(AnalyticsPlatformError):
    def __init__(self, status: int, detail: Any, *, method: str = "", path: str = ""):
        self.status = status
        self.detail = detail
        self.code = detail.get("code") if isinstance(detail, dict) else None
        message = detail.get("message") if isinstance(detail, dict) and "message" in detail else detail
        super().__init__(f"{method} {path} → HTTP {status}: {message}")


class AuthenticationError(ApiError):
    """401: missing, invalid or expired credentials."""


class ForbiddenError(ApiError):
    """403: authenticated, but not allowed."""


class NotFoundError(ApiError):
    """404."""


class ConflictError(ApiError):
    """409."""


class ValidationError(ApiError):
    """422: the request was understood but is invalid."""


class RateLimitError(ApiError):
    """429: slow down; ``retry_after`` seconds if the server said so."""

    def __init__(self, *args: Any, retry_after: float | None = None, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self.retry_after = retry_after


class ServerError(ApiError):
    """5xx."""


class JobFailedError(AnalyticsPlatformError):
    def __init__(self, job: dict[str, Any]):
        self.job = job
        super().__init__(f"job {job.get('id')} {job.get('status')}: {job.get('error') or ''}".strip())


def error_for(status: int, detail: Any, *, method: str, path: str, retry_after: float | None = None) -> ApiError:
    cls = {
        401: AuthenticationError,
        403: ForbiddenError,
        404: NotFoundError,
        409: ConflictError,
        422: ValidationError,
        429: RateLimitError,
    }.get(status)
    if cls is RateLimitError:
        return RateLimitError(status, detail, method=method, path=path, retry_after=retry_after)
    if cls is None:
        cls = ServerError if status >= 500 else ApiError
    return cls(status, detail, method=method, path=path)
