"""Python SDK and CLI for the Analytics Platform."""

from .client import Client, ServerSentEvent, parse_sse, verify_webhook_signature
from .errors import (
    AnalyticsPlatformError,
    ApiError,
    AuthenticationError,
    ConflictError,
    ForbiddenError,
    JobFailedError,
    NotFoundError,
    RateLimitError,
    ServerError,
    ValidationError,
)

__all__ = [
    "Client",
    "ServerSentEvent",
    "parse_sse",
    "verify_webhook_signature",
    "AnalyticsPlatformError",
    "ApiError",
    "AuthenticationError",
    "ConflictError",
    "ForbiddenError",
    "JobFailedError",
    "NotFoundError",
    "RateLimitError",
    "ServerError",
    "ValidationError",
]
__version__ = "0.2.0"
