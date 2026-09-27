"""Streaming inference (API-006): Server-Sent Events and WebSocket.

* **SSE** (``POST /v1/endpoints/{name}/predict/stream``): large requests (up to ``STREAM_MAX_INSTANCES``) are split into
  chunks of ``chunk_size`` instances (1 = one event per instance); each chunk is a normal prediction (logged, metered,
  drift-sampled) and becomes one ``prediction`` event. Forecasting endpoints stream the horizon step by step
  (``forecast`` events). Events: ``start``, ``prediction`` / ``forecast``, ``error``, ``done``.
* **WebSocket** (``/v1/endpoints/{name}/ws``): authenticate with ``?token=`` (a 60-second, single-use stream token from
  ``POST /v1/endpoints/{name}/stream-token``) or with a first message ``{"type": "auth", "api_key": …}`` /
  ``{"type": "auth", "token": <access token>}``. Then send ``{"id"?, "instances": [...]}`` (or ``horizon`` /
  ``history`` for forecasting) and receive ``{"id", ...prediction}`` or ``{"id", "error": {status, detail}}``.

Rate limits: every chunk / message costs one request against the caller's per-minute limit (MGT-002), and each tenant
may hold at most ``MAX_STREAMS_PER_TENANT`` open streams.
"""

from __future__ import annotations

import secrets
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

import jwt

from ..auth.service import ISSUER, JWT_ALG, AuthError, Principal

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState

STREAM_MAX_INSTANCES = 10_000
MAX_STREAMS_PER_TENANT = 8
WS_MAX_MESSAGE_BYTES = 1_000_000
STREAM_TOKEN_TTL = 60
STREAM_AUDIENCE = "ap-stream"
DEFAULT_RATE_LIMIT = 1200


class StreamLimitExceeded(RuntimeError):
    pass


class _StreamSlots:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._open: dict[str, int] = {}

    def available(self, tenant_id: str) -> bool:
        with self._lock:
            return self._open.get(tenant_id, 0) < MAX_STREAMS_PER_TENANT

    @contextmanager
    def hold(self, tenant_id: str) -> Iterator[None]:
        with self._lock:
            if self._open.get(tenant_id, 0) >= MAX_STREAMS_PER_TENANT:
                raise StreamLimitExceeded(f"at most {MAX_STREAMS_PER_TENANT} concurrent streams per organization")
            self._open[tenant_id] = self._open.get(tenant_id, 0) + 1
        try:
            yield
        finally:
            with self._lock:
                self._open[tenant_id] -= 1


def slots(state: AppState) -> _StreamSlots:
    with state._lock:
        return state.extras.setdefault("stream_slots", _StreamSlots())


def allow(state: AppState, principal: Principal) -> bool:
    """One streamed chunk / message = one request against the caller's rate limit (MGT-002)."""
    limit = principal.rate_limit_per_minute or DEFAULT_RATE_LIMIT
    return state.rate_limiter.allow(f"{principal.tenant_id}:{principal.user_id}", limit)


# -- short-lived stream tokens ------------------------------------------------------------------------------------------


def issue_stream_token(state: AppState, principal: Principal, endpoint: str) -> dict[str, Any]:
    now = datetime.now(UTC)
    claims = {
        "iss": ISSUER,
        "aud": STREAM_AUDIENCE,
        "sub": principal.user_id,
        "tid": principal.tenant_id,
        "role": principal.role,
        "method": principal.method,
        "scopes": list(principal.scopes),
        "rl": principal.rate_limit_per_minute,
        "ep": endpoint,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=STREAM_TOKEN_TTL)).timestamp()),
        "jti": secrets.token_urlsafe(16),
    }
    token = jwt.encode(claims, state.auth.signing_key(), algorithm=JWT_ALG)
    return {"token": token, "expires_in": STREAM_TOKEN_TTL, "url": f"/v1/endpoints/{endpoint}/ws?token={token}"}


def verify_stream_token(state: AppState, token: str, endpoint: str) -> Principal:
    """Validate a stream token for ``endpoint``. Tokens are single use (per API process)."""
    try:
        claims = jwt.decode(
            token,
            state.auth.signing_key(),
            algorithms=[JWT_ALG],
            audience=STREAM_AUDIENCE,
            issuer=ISSUER,
            options={"require": ["exp", "sub", "tid", "aud", "jti", "ep"]},
        )
    except jwt.PyJWTError as exc:
        raise AuthError("invalid or expired stream token", "invalid_token") from exc
    if claims["ep"] != endpoint:
        raise AuthError("stream token was issued for another endpoint", "invalid_token")
    with state._lock:
        used: dict[str, float] = state.extras.setdefault("stream_token_jti", {})
        now = time.time()
        for jti, exp in list(used.items()):
            if exp < now:
                used.pop(jti, None)
        if claims["jti"] in used:
            raise AuthError("stream token already used", "invalid_token")
        used[claims["jti"]] = float(claims["exp"])
    return Principal(
        tenant_id=claims["tid"],
        user_id=claims["sub"],
        role=claims["role"],
        method=claims.get("method") or "jwt",
        scopes=list(claims.get("scopes") or []),
        rate_limit_per_minute=claims.get("rl"),
    )


def authenticate_message(state: AppState, message: dict[str, Any], client_ip: str | None) -> Principal:
    """First-message WebSocket auth: ``{"type": "auth", "api_key": …}`` or ``{"type": "auth", "token": <bearer>}``."""
    from ..auth.oauth import OAuthService, is_oauth_token

    if message.get("type") != "auth":
        raise AuthError("the first message must be {type: auth, api_key | token}", "auth_required")
    key, token = message.get("api_key"), message.get("token")
    if isinstance(key, str) and key:
        return state.auth.verify_api_key(key, client_ip)
    if isinstance(token, str) and token:
        if token.startswith("ap_"):
            return state.auth.verify_api_key(token, client_ip)
        if is_oauth_token(token):
            return OAuthService(state).verify_token(token)
        return state.auth.verify_access_token(token)
    raise AuthError("missing credentials", "auth_required")


# -- SSE ------------------------------------------------------------------------------------------------------------------


def sse(event: str, data: Any) -> str:
    import json

    from ..export_utils import jsonable

    return f"event: {event}\ndata: {json.dumps(jsonable(data), separators=(',', ':'))}\n\n"


def forecast_steps(out: dict[str, Any]) -> Iterator[dict[str, Any]]:
    for i, ts in enumerate(out.get("timestamps") or []):
        yield {
            "step": i + 1,
            "timestamp": ts,
            "prediction": out["predictions"][i],
            "lower": (out.get("lower") or [None] * (i + 1))[i],
            "upper": (out.get("upper") or [None] * (i + 1))[i],
        }
