"""CORS (MGT-008): a global allowlist for the web app plus per-endpoint origins for model inference."""

from __future__ import annotations

import re
import time

from sqlalchemy import select
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from .db.models import Endpoint

PREDICT_RE = re.compile(r"^/v1/endpoints/([a-z0-9-]+)/predict$")
ALLOW_HEADERS = "Authorization, Content-Type, X-API-Key, X-Content-SHA256"
ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS"


class CorsMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, *, state, global_origins: list[str]):
        super().__init__(app)
        self.state = state
        self.global_origins = set(global_origins)
        self._cache: dict[str, tuple[float, set[str]]] = {}

    def _endpoint_origins(self, name: str) -> set[str]:
        hit = self._cache.get(name)
        if hit and time.monotonic() - hit[0] < 30:
            return hit[1]
        with self.state.db.session() as s:
            origins = {o for (cors,) in s.execute(select(Endpoint.cors_origins).where(Endpoint.name == name)).all() for o in cors}
        self._cache[name] = (time.monotonic(), origins)
        return origins

    def _allowed(self, request: Request, origin: str) -> bool:
        if origin in self.global_origins or "*" in self.global_origins:
            return True
        match = PREDICT_RE.match(request.url.path)
        return bool(match and origin in self._endpoint_origins(match.group(1)))

    async def dispatch(self, request: Request, call_next):
        origin = request.headers.get("origin")
        allowed = bool(origin) and self._allowed(request, origin)
        if request.method == "OPTIONS" and origin and request.headers.get("access-control-request-method"):
            if not allowed:
                return Response(status_code=403)
            response = Response(status_code=204)
        else:
            response = await call_next(request)
        if allowed:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Headers"] = ALLOW_HEADERS
            response.headers["Access-Control-Allow-Methods"] = ALLOW_METHODS
            response.headers["Access-Control-Max-Age"] = "600"
            response.headers["Vary"] = "Origin"
        return response
