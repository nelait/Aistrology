"""Python SDK for the Analytics Platform API (SDK-002, SDK-007, SDK-008).

from analytics_platform import Client

ap = Client("https://api.example.com", api_key="ap_live_...")
ap.endpoints.predict("churn-prod", [{"age": 42, "plan": "pro"}])

# OAuth 2.0 client credentials (machine to machine): tokens are fetched from /oauth/token and renewed automatically.
ap = Client("https://api.example.com", client_id="apc_...", client_secret="...")
"""

from __future__ import annotations

import hashlib
import hmac
import json as _json
import os
import random
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, TypedDict

import httpx

from .errors import AuthenticationError, ConflictError, JobFailedError, ServerError, error_for

__all__ = ["Client", "ServerSentEvent", "verify_webhook_signature"]

DEFAULT_TIMEOUT = 60.0
RETRY_STATUSES = {408, 429, 500, 502, 503, 504}
POST_RETRY_STATUSES = {429, 503}  # safe to retry: the server did not process the request
RESUMABLE_THRESHOLD = 100 * 1024 * 1024  # datasets.upload switches to the resumable protocol above this size
TOKEN_REFRESH_MARGIN = 30.0  # renew OAuth client-credentials tokens this many seconds before they expire

FileInput = str | Path | bytes | BinaryIO


class Job(TypedDict, total=False):
    id: str
    type: str
    status: str
    progress: float
    message: str | None
    params: dict[str, Any]
    result: dict[str, Any] | None
    error: str | None


class QueryResult(TypedDict):
    columns: list[str]
    rows: list[list[Any]]
    row_count: int
    truncated: bool


class Prediction(TypedDict, total=False):
    predictions: list[Any]
    probabilities: list[list[float]]
    classes: list[Any]
    model_version: dict[str, Any]
    shap: list[dict[str, float]]
    explanations: list[dict[str, Any]]
    # anomaly endpoints
    threshold: float
    # forecasting endpoints
    horizon: int
    timestamps: list[str]
    lower: list[float]
    upper: list[float]
    interval_level: float


@dataclass(frozen=True)
class ServerSentEvent:
    """One event of ``endpoints.predict_stream`` (API-006): ``start``, ``prediction``, ``forecast`` or ``done``."""

    event: str
    data: Any


class Client:
    def __init__(
        self,
        base_url: str | None = None,
        *,
        api_key: str | None = None,
        access_token: str | None = None,
        refresh_token: str | None = None,
        on_tokens: Callable[[dict[str, Any]], None] | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
        scope: str | Iterable[str] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = 3,
        http: httpx.Client | None = None,
    ):
        self.base_url = (base_url or os.environ.get("AP_URL") or "http://localhost:8000").rstrip("/")
        # An explicitly configured OAuth client wins over an API key from the environment.
        if api_key is None and not client_id:
            api_key = os.environ.get("AP_API_KEY")
        self.api_key = api_key
        self.access_token = access_token
        self.refresh_token = refresh_token
        self.on_tokens = on_tokens
        self.client_id = client_id
        self.client_secret = client_secret
        self.scope = scope if scope is None or isinstance(scope, str) else " ".join(scope)
        self._token_expires_at = 0.0
        self.max_retries = max_retries
        self._http = http or httpx.Client(timeout=timeout, headers={"User-Agent": "analytics-platform-python/0.2"})
        self._refresh_lock = threading.Lock()
        self.auth = _Auth(self)
        self.tenant = _Tenant(self)
        self.projects = _Projects(self)
        self.teams = _Teams(self)
        self.schemas = _Schemas(self)
        self.datasets = _Datasets(self)
        self.streams = _Streams(self)
        self.connectors = _Connectors(self)
        self.pipelines = _Pipelines(self)
        self.jobs = _Jobs(self)
        self.schedules = _Schedules(self)
        self.notifications = _Notifications(self)
        self.experiments = _Experiments(self)
        self.training_templates = _TrainingTemplates(self)
        self.models = _Models(self)
        self.endpoints = _Endpoints(self)
        self.analytics = _Analytics(self)
        self.dashboards = _Dashboards(self)
        self.comments = _Comments(self)
        self.webhooks = _Webhooks(self)

    # -- transport ------------------------------------------------------------------------------
    @property
    def uses_client_credentials(self) -> bool:
        return bool(self.client_id and self.client_secret and not self.api_key)

    def _headers(self) -> dict[str, str]:
        if self.api_key:
            return {"X-API-Key": self.api_key}
        if self.uses_client_credentials:
            if not self.access_token or time.monotonic() >= self._token_expires_at - TOKEN_REFRESH_MARGIN:
                self.fetch_client_token()
            return {"Authorization": f"Bearer {self.access_token}"}
        if self.access_token:
            return {"Authorization": f"Bearer {self.access_token}"}
        return {}

    def _url(self, path: str) -> str:
        return path if path.startswith("http") else f"{self.base_url}{path}"

    def request(
        self, method: str, path: str, *, raw: bool = False, idempotent: bool | None = None, _refreshed: bool = False, **kwargs: Any
    ) -> Any:
        """Send a request with auth, token refresh and retries.

        ``idempotent`` decides whether server errors are retried; it defaults to True for GET/PUT/DELETE.
        """
        idempotent = method in ("GET", "PUT", "DELETE") if idempotent is None else idempotent
        extra_headers = kwargs.pop("headers", None) or {}  # kept for retries and the replay after a refresh
        attempt = 0
        while True:
            try:
                response = self._http.request(method, self._url(path), headers={**self._headers(), **extra_headers}, **kwargs)
            except (httpx.ConnectError, httpx.ConnectTimeout):
                # Nothing reached the server, so retrying is safe for any method.
                if attempt >= self.max_retries:
                    raise
                self._sleep(attempt, None)
                attempt += 1
                continue
            except httpx.TimeoutException:
                if not idempotent or attempt >= self.max_retries:
                    raise
                self._sleep(attempt, None)
                attempt += 1
                continue
            status = response.status_code
            if status == 401 and not _refreshed and self._can_reauthenticate(path):
                self._reauthenticate()
                return self.request(method, path, raw=raw, idempotent=idempotent, _refreshed=True, headers=extra_headers, **kwargs)
            retryable = status in (RETRY_STATUSES if idempotent else POST_RETRY_STATUSES)
            if retryable and attempt < self.max_retries:
                self._sleep(attempt, response.headers.get("retry-after"))
                attempt += 1
                continue
            if status >= 400:
                raise error_for(status, _detail(response), method=method, path=path, retry_after=_retry_after(response))
            if raw:
                return response
            if status == 204 or not response.content:
                return None
            if "json" in response.headers.get("content-type", ""):
                return response.json()
            return response.content

    def stream(self, method: str, path: str, *, json: Any = None, _refreshed: bool = False) -> Iterator[ServerSentEvent]:
        """Send a request and iterate over its ``text/event-stream`` response (API-006).

        Until the first byte arrives the usual rules apply: a 401 re-authenticates once, 429/503 are retried after
        ``Retry-After`` (the server did not start the stream) and other errors raise. An ``error`` event raises
        the matching typed error (e.g. ``RateLimitError`` when a later chunk is refused).
        """
        attempt = 0
        while True:
            headers = {**self._headers(), "Accept": "text/event-stream"}
            with self._http.stream(method, self._url(path), json=json, headers=headers) as response:
                status = response.status_code
                if status == 401 and not _refreshed and self._can_reauthenticate(path):
                    response.close()
                    self._reauthenticate()
                    yield from self.stream(method, path, json=json, _refreshed=True)
                    return
                if status in POST_RETRY_STATUSES and attempt < self.max_retries:
                    retry_after = response.headers.get("retry-after")
                    response.close()
                    self._sleep(attempt, retry_after)
                    attempt += 1
                    continue
                if status >= 400:
                    response.read()
                    raise error_for(status, _detail(response), method=method, path=path, retry_after=_retry_after(response))
                for event in parse_sse(response.iter_lines()):
                    if event.event == "error":
                        data = event.data if isinstance(event.data, dict) else {"status": 500, "detail": event.data}
                        raise error_for(int(data.get("status") or 500), data.get("detail"), method=method, path=path)
                    yield event
                return

    @staticmethod
    def _sleep(attempt: int, retry_after: str | None) -> None:
        if retry_after and retry_after.replace(".", "", 1).isdigit():
            delay = min(float(retry_after), 60.0)
        else:
            delay = min(0.5 * 2**attempt, 20.0) * (0.5 + random.random() / 2)
        time.sleep(delay)

    # -- credentials ----------------------------------------------------------------------------
    def _can_reauthenticate(self, path: str) -> bool:
        if self.api_key or path in ("/v1/auth/refresh", "/oauth/token"):
            return False
        return self.uses_client_credentials or bool(self.refresh_token)

    def _reauthenticate(self) -> None:
        if self.uses_client_credentials:
            self.fetch_client_token()
        else:
            self._refresh()

    def fetch_client_token(self) -> dict[str, Any]:
        """OAuth 2.0 client credentials grant (MGT-004a): ``POST /oauth/token``, form-encoded.

        Called automatically before the first request and whenever the token is about to expire or is rejected.
        """
        if not (self.client_id and self.client_secret):
            raise ValueError("client_id and client_secret are required for the client credentials grant")
        with self._refresh_lock:
            form = _clean(
                {"grant_type": "client_credentials", "client_id": self.client_id, "client_secret": self.client_secret, "scope": self.scope}
            )
            attempt = 0
            while True:
                try:
                    response = self._http.post(self._url("/oauth/token"), data=form)
                except httpx.TransportError:
                    # Issuing a token has no side effects, so every transport failure can be retried.
                    if attempt >= self.max_retries:
                        raise
                    self._sleep(attempt, None)
                    attempt += 1
                    continue
                if response.status_code in RETRY_STATUSES and attempt < self.max_retries:
                    self._sleep(attempt, response.headers.get("retry-after"))
                    attempt += 1
                    continue
                break
            if response.status_code != 200:
                self.access_token = None
                try:
                    body = response.json()
                    detail: Any = {"code": body.get("error"), "message": body.get("error_description") or body.get("error")}
                except ValueError:
                    detail = response.text
                raise error_for(response.status_code, detail, method="POST", path="/oauth/token", retry_after=_retry_after(response))
            tokens = response.json()
            self.access_token = tokens["access_token"]
            self._token_expires_at = time.monotonic() + float(tokens.get("expires_in") or 900)
            if self.on_tokens:
                self.on_tokens(tokens)
            return tokens

    def _refresh(self) -> None:
        with self._refresh_lock:
            token = self.refresh_token
            response = self._http.post(self._url("/v1/auth/refresh"), json={"refresh_token": token})
            if response.status_code != 200:
                self.access_token = self.refresh_token = None
                raise AuthenticationError(response.status_code, _detail(response), method="POST", path="/v1/auth/refresh")
            self._set_tokens(response.json())

    def _set_tokens(self, tokens: dict[str, Any]) -> None:
        self.access_token, self.refresh_token = tokens["access_token"], tokens["refresh_token"]
        if self.on_tokens:
            self.on_tokens(tokens)

    # -- verbs ----------------------------------------------------------------------------------
    def get(self, path: str, **kw: Any) -> Any:
        return self.request("GET", path, **kw)

    def post(self, path: str, json: Any = None, **kw: Any) -> Any:
        return self.request("POST", path, json=json, **kw)

    def put(self, path: str, json: Any = None, **kw: Any) -> Any:
        return self.request("PUT", path, json=json, **kw)

    def patch(self, path: str, json: Any = None, **kw: Any) -> Any:
        return self.request("PATCH", path, json=json, **kw)

    def delete(self, path: str, **kw: Any) -> Any:
        return self.request("DELETE", path, **kw)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Client:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


def _detail(response: httpx.Response) -> Any:
    try:
        return response.json().get("detail", response.text)
    except (ValueError, AttributeError):
        return response.text


def _retry_after(response: httpx.Response) -> float | None:
    value = response.headers.get("retry-after", "")
    return float(value) if value.replace(".", "", 1).isdigit() else None


def _clean(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def _read_file(file: FileInput, filename: str | None, default: str) -> tuple[bytes, str]:
    if isinstance(file, (str, Path)):
        path = Path(file)
        return path.read_bytes(), filename or path.name
    if isinstance(file, bytes):
        return file, filename or default
    name = getattr(file, "name", None)
    return file.read(), filename or (Path(name).name if isinstance(name, str) else default)


def _size_of(file: FileInput) -> int | None:
    if isinstance(file, (str, Path)):
        return Path(file).stat().st_size
    if isinstance(file, bytes):
        return len(file)
    try:
        pos = file.tell()
        end = file.seek(0, os.SEEK_END)
        file.seek(pos)
        return end - pos
    except (AttributeError, OSError, ValueError):
        return None


class _Source:
    """Random access to an upload source without loading files from disk into memory."""

    def __init__(self, file: FileInput, filename: str | None):
        self._fh: BinaryIO | None = None
        self._data: bytes | None = None
        self._base = 0
        if isinstance(file, (str, Path)):
            path = Path(file)
            self._fh, self.name, self.size = path.open("rb"), filename or path.name, path.stat().st_size
            self._owned = True
        elif isinstance(file, bytes):
            self._data, self.name, self.size = file, filename or "upload.csv", len(file)
            self._owned = False
        else:
            name = getattr(file, "name", None)
            self.name = filename or (Path(name).name if isinstance(name, str) else "upload.csv")
            size = _size_of(file)
            if size is None or not getattr(file, "seekable", lambda: False)():
                self._data = file.read()
                self.size = len(self._data)
            else:
                self._fh, self._base, self.size = file, file.tell(), size
            self._owned = False

    def read(self, offset: int, length: int) -> bytes:
        if self._data is not None:
            return self._data[offset : offset + length]
        assert self._fh is not None
        self._fh.seek(self._base + offset)
        return self._fh.read(length)

    def sha256(self) -> str:
        h = hashlib.sha256()
        offset = 0
        while offset < self.size:
            block = self.read(offset, 8 * 1024 * 1024)
            if not block:
                break
            h.update(block)
            offset += len(block)
        return h.hexdigest()

    def close(self) -> None:
        if self._owned and self._fh is not None:
            self._fh.close()


def parse_sse(lines: Iterable[str]) -> Iterator[ServerSentEvent]:
    """Parse ``text/event-stream`` lines: ``event:`` and (multi-line) ``data:`` fields; a blank line ends an event.

    ``data`` is decoded as JSON when possible.
    """
    event, data = "message", []

    def build() -> ServerSentEvent:
        raw = "\n".join(data)
        try:
            return ServerSentEvent(event, _json.loads(raw))
        except ValueError:
            return ServerSentEvent(event, raw)

    for line in lines:
        line = line.rstrip("\r")
        if not line:
            if data:
                yield build()
            event, data = "message", []
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if field == "event":
            event = value
        elif field == "data":
            data.append(value)
    if data:
        yield build()


class _Resource:
    def __init__(self, client: Client):
        self._c = client

    def _job(self, job: Job, wait: bool, timeout: float) -> Job:
        return self._c.jobs.wait(job["id"], timeout=timeout) if wait else job


class _Auth(_Resource):
    def signup(self, tenant_id: str, org_name: str, email: str, password: str, **kw: Any) -> dict[str, Any]:
        return self._c.post("/v1/auth/signup", {"tenant_id": tenant_id, "org_name": org_name, "email": email, "password": password, **kw})

    def login(self, email: str, password: str, totp: str | None = None) -> dict[str, Any]:
        tokens = self._c.post("/v1/auth/login", _clean({"email": email, "password": password, "totp": totp}))
        self._c._set_tokens(tokens)
        return tokens

    def logout(self) -> None:
        if self._c.refresh_token:
            self._c.post("/v1/auth/logout", {"refresh_token": self._c.refresh_token})
        self._c.access_token = self._c.refresh_token = None

    def me(self) -> dict[str, Any]:
        return self._c.get("/v1/auth/me")

    def client_credentials(self) -> dict[str, Any]:
        """Fetch a fresh OAuth client-credentials token now (normally automatic)."""
        return self._c.fetch_client_token()


class _Tenant(_Resource):
    def get(self) -> dict[str, Any]:
        return self._c.get("/v1/tenant")

    def users(self) -> list[dict[str, Any]]:
        return self._c.get("/v1/tenant/users")

    def create_user(self, email: str, role: str, password: str, name: str | None = None) -> dict[str, Any]:
        return self._c.post("/v1/tenant/users", _clean({"email": email, "role": role, "password": password, "name": name}))

    def create_api_key(self, name: str, role: str = "data_scientist", **kw: Any) -> dict[str, Any]:
        return self._c.post("/v1/tenant/api-keys", {"name": name, "role": role, **kw})

    def api_keys(self) -> list[dict[str, Any]]:
        return self._c.get("/v1/tenant/api-keys")

    def rotate_api_key(self, key_id: str) -> dict[str, Any]:
        return self._c.post(f"/v1/tenant/api-keys/{key_id}/rotate")

    def revoke_api_key(self, key_id: str) -> None:
        self._c.delete(f"/v1/tenant/api-keys/{key_id}")

    def create_oauth_client(self, name: str, role: str = "data_scientist", scopes: Iterable[str] = ()) -> dict[str, Any]:
        """Register an OAuth client (MGT-004a). ``client_secret`` is only in this response."""
        return self._c.post("/v1/tenant/oauth-clients", {"name": name, "role": role, "scopes": list(scopes)})

    def oauth_clients(self) -> list[dict[str, Any]]:
        return self._c.get("/v1/tenant/oauth-clients")

    def revoke_oauth_client(self, client_row_id: str) -> None:
        self._c.delete(f"/v1/tenant/oauth-clients/{client_row_id}")

    def retention(self) -> dict[str, Any]:
        """Retention policy (SOC-PRV-002): ``{llm_bodies_days, llm_metadata_days, audit_days, inference_logs_days}``."""
        return self._c.get("/v1/tenant/retention")

    def set_retention(self, **days: int) -> dict[str, Any]:
        """Change some retention periods, e.g. ``set_retention(inference_logs_days=14)`` (``audit_days`` >= 365)."""
        return self._c.put("/v1/tenant/retention", {**self.retention(), **days})

    def apply_retention(self) -> dict[str, Any]:
        """Apply the policy now; returns the counts of redacted and deleted records."""
        return self._c.post("/v1/tenant/retention/apply")

    def llm_config(self) -> dict[str, Any]:
        return self._c.get("/v1/tenant/llm-config")

    def set_llm_config(self, config: dict[str, Any]) -> dict[str, Any]:
        return self._c.put("/v1/tenant/llm-config", config)

    def put_secret(self, name: str, value: str) -> None:
        self._c.put(f"/v1/tenant/secrets/{name}", {"value": value})

    def usage(self) -> dict[str, Any]:
        return self._c.get("/v1/tenant/usage")

    def audit(self, action: str | None = None) -> list[dict[str, Any]]:
        return self._c.get("/v1/tenant/audit", params=_clean({"action": action}))


class _Projects(_Resource):
    def list(self) -> list[dict[str, Any]]:
        return self._c.get("/v1/projects")

    def create(self, name: str, *, open: bool = False, members: Iterable[str] = ()) -> dict[str, Any]:  # noqa: A002
        return self._c.post("/v1/projects", {"name": name, "open": open, "members": list(members)})

    def add_member(self, project_id: str, user_id: str) -> Any:
        return self._c.post(f"/v1/projects/{project_id}/members", {"user_id": user_id})

    def remove_member(self, project_id: str, user_id: str) -> None:
        self._c.delete(f"/v1/projects/{project_id}/members/{user_id}")

    def add_team(self, project_id: str, team_id: str) -> Any:
        return self._c.post(f"/v1/projects/{project_id}/teams", {"team_id": team_id})

    def remove_team(self, project_id: str, team_id: str) -> None:
        self._c.delete(f"/v1/projects/{project_id}/teams/{team_id}")


class _Teams(_Resource):
    def create(self, name: str, *, description: str | None = None, members: Iterable[str] = ()) -> dict[str, Any]:
        return self._c.post("/v1/teams", _clean({"name": name, "description": description, "members": list(members)}))

    def list(self) -> list[dict[str, Any]]:
        return self._c.get("/v1/teams")

    def get(self, team_id: str) -> dict[str, Any]:
        return self._c.get(f"/v1/teams/{team_id}")

    def delete(self, team_id: str) -> None:
        self._c.delete(f"/v1/teams/{team_id}")

    def add_member(self, team_id: str, user_id: str) -> Any:
        return self._c.post(f"/v1/teams/{team_id}/members", {"user_id": user_id})

    def remove_member(self, team_id: str, user_id: str) -> None:
        self._c.delete(f"/v1/teams/{team_id}/members/{user_id}")


class _Schemas(_Resource):
    def parse(self, content: str, format: str = "json_schema") -> dict[str, Any]:  # noqa: A002
        return self._c.post("/v1/schemas/parse", {"format": format, "content": content})

    def validate(self, schema: dict[str, Any]) -> dict[str, Any]:
        return self._c.post("/v1/schemas/validate", schema)

    def preview(self, schema: dict[str, Any], **options: Any) -> dict[str, Any]:
        return self._c.post("/v1/generate/preview", {"schema": schema, "options": options})

    def generate(self, schema: dict[str, Any], *, format: str = "csv", save_as: str | None = None, **options: Any) -> Any:  # noqa: A002
        return self._c.post("/v1/generate", _clean({"schema": schema, "options": options, "format": format, "save_as": save_as}))

    # -- schema history (SCH-010) --
    def save(
        self,
        name: str,
        schema: dict[str, Any],
        *,
        project_id: str | None = None,
        message: str | None = None,
        source_format: str | None = None,
    ) -> dict[str, Any]:
        """Save a new version (``created: False`` when identical to the latest). Returns ``{schema_record, version, created, diff?}``."""
        body = _clean({"name": name, "schema": schema, "project_id": project_id, "message": message, "source_format": source_format})
        return self._c.post("/v1/schemas", body)

    def list(self, project_id: str | None = None) -> list[dict[str, Any]]:
        return self._c.get("/v1/schemas", params=_clean({"project_id": project_id}))

    def get(self, schema_id: str) -> dict[str, Any]:
        return self._c.get(f"/v1/schemas/{schema_id}")

    def versions(self, schema_id: str) -> list[dict[str, Any]]:
        return self._c.get(f"/v1/schemas/{schema_id}/versions")

    def version(self, schema_id: str, version: int) -> dict[str, Any]:
        return self._c.get(f"/v1/schemas/{schema_id}/versions/{version}")

    def diff(self, schema_id: str, from_version: int | None = None, to_version: int | None = None) -> dict[str, Any]:
        """SchemaDiff between two saved versions (default: previous -> latest)."""
        return self._c.get(f"/v1/schemas/{schema_id}/diff", params=_clean({"from_version": from_version, "to_version": to_version}))

    def diff_schemas(self, a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
        """SchemaDiff between two arbitrary schemas."""
        return self._c.post("/v1/schemas/diff", {"a": a, "b": b})


class _Datasets(_Resource):
    def upload(
        self,
        file: FileInput,
        filename: str | None = None,
        *,
        sha256: bool = True,
        project_id: str | None = None,
        resumable: bool | None = None,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> dict[str, Any]:
        """Upload a file (path, bytes or binary file object). Sends a SHA-256 so corruption in transit is detected (ING-009).

        Files above 100 MB (or with ``resumable=True``) go through the resumable protocol (``upload_resumable``).
        """
        size = _size_of(file)
        if resumable or (resumable is None and size is not None and size > RESUMABLE_THRESHOLD):
            return self.upload_resumable(file, filename, sha256=sha256, project_id=project_id, on_progress=on_progress)
        data, name = _read_file(file, filename, "upload.csv")
        headers = {"X-Content-SHA256": hashlib.sha256(data).hexdigest()} if sha256 else {}
        # Not idempotent: each upload creates a dataset, so a 5xx is not retried.
        return self._c.request(
            "PUT",
            "/v1/datasets/upload",
            idempotent=False,
            content=data,
            params=_clean({"filename": name, "project_id": project_id}),
            headers=headers,
        )

    # -- resumable uploads (ING-NFR-001) --
    def upload_resumable(
        self,
        file: FileInput,
        filename: str | None = None,
        *,
        part_size: int | None = None,
        sha256: bool = True,
        project_id: str | None = None,
        upload_id: str | None = None,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> dict[str, Any]:
        """Upload in parts that survive network failures (tus-style), then ingest. Returns ``{dataset, inference}``.

        After a connection error, timeout, 5xx or offset conflict the client asks the server for its offset and resumes
        from there. Pass ``upload_id`` to resume a session started earlier (e.g. by a process that crashed).
        ``on_progress(sent_bytes, total_bytes)`` is called after every part.
        """
        source = _Source(file, filename)
        try:
            if upload_id is None:
                digest = source.sha256() if sha256 else None
                body = _clean({"filename": source.name, "size": source.size, "sha256": digest, "project_id": project_id})
                session = self._c.post("/v1/datasets/uploads", body)
            else:
                session = self.upload_status(upload_id)
            upload_id, size = session["id"], session["size"]
            if size != source.size:
                raise ValueError(f"upload {upload_id} expects {size} bytes, the file has {source.size}")
            part = max(1, min(part_size or session["part_max_bytes"], session["part_max_bytes"]))
            offset = session["offset"]
            failures = 0
            while True:
                while offset < size:
                    chunk = source.read(offset, part)
                    try:
                        status = self._c.request(
                            "PATCH",
                            f"/v1/datasets/uploads/{upload_id}",
                            content=chunk,
                            headers={"Upload-Offset": str(offset), "Content-Type": "application/offset+octet-stream"},
                        )
                        offset, failures = status["offset"], 0
                    except (ConflictError, ServerError, httpx.TransportError) as exc:
                        failures += 1
                        if failures > self._c.max_retries:
                            raise
                        if not isinstance(exc, ConflictError):
                            self._c._sleep(failures - 1, None)
                        offset = self._resync_offset(upload_id, exc)
                    if on_progress:
                        on_progress(offset, size)
                try:
                    # Completing is idempotent once it succeeded, so it is retried like a GET.
                    return self._c.request("POST", f"/v1/datasets/uploads/{upload_id}/complete", idempotent=True)
                except ConflictError as exc:  # bytes missing (e.g. a lost part): resync and continue
                    failures += 1
                    if failures > self._c.max_retries:
                        raise
                    offset = self._resync_offset(upload_id, exc)
        finally:
            source.close()

    def _resync_offset(self, upload_id: str, exc: Exception) -> int:
        detail = getattr(exc, "detail", None)
        if isinstance(detail, dict) and isinstance(detail.get("offset"), int):
            return detail["offset"]
        return self.upload_status(upload_id)["offset"]

    def upload_status(self, upload_id: str) -> dict[str, Any]:
        """``{id, filename, size, offset, status, part_max_bytes, expires_at, dataset_id?}``."""
        return self._c.get(f"/v1/datasets/uploads/{upload_id}")

    def abort_upload(self, upload_id: str) -> None:
        self._c.delete(f"/v1/datasets/uploads/{upload_id}")

    def list(self, project_id: str | None = None) -> list[dict[str, Any]]:
        return self._c.get("/v1/datasets", params=_clean({"project_id": project_id}))

    def get(self, dataset_id: str, version: int | None = None) -> dict[str, Any]:
        return self._c.get(f"/v1/datasets/{dataset_id}", params=_clean({"version": version}))

    def versions(self, dataset_id: str) -> list[dict[str, Any]]:
        return self._c.get(f"/v1/datasets/{dataset_id}/versions")

    def add_version(
        self, dataset_id: str, file: FileInput, filename: str | None = None, *, mode: str = "append", sha256: bool = True
    ) -> dict[str, Any]:
        """Upload the next version (INF-007/008): ``mode`` is ``append`` or ``replace``. Returns ``{dataset, previous_version, mode, inference, diff}``."""
        data, name = _read_file(file, filename, "upload.csv")
        headers = {"X-Content-SHA256": hashlib.sha256(data).hexdigest()} if sha256 else {}
        return self._c.request(
            "POST", f"/v1/datasets/{dataset_id}/versions", params={"mode": mode}, files={"file": (name, data)}, headers=headers
        )

    def append(self, dataset_id: str, file: FileInput, filename: str | None = None) -> dict[str, Any]:
        return self.add_version(dataset_id, file, filename, mode="append")

    def replace(self, dataset_id: str, file: FileInput, filename: str | None = None) -> dict[str, Any]:
        return self.add_version(dataset_id, file, filename, mode="replace")

    def delete(self, dataset_id: str) -> None:
        self._c.delete(f"/v1/datasets/{dataset_id}")

    def confirm_schema(self, dataset_id: str, schema: dict[str, Any]) -> dict[str, Any]:
        return self._c.put(f"/v1/datasets/{dataset_id}/schema", schema)

    def profile(self, dataset_id: str, version: int | None = None) -> dict[str, Any]:
        return self._c.get(f"/v1/datasets/{dataset_id}/profile", params=_clean({"version": version}))

    def advanced_profile(
        self, dataset_id: str, *, version: int | None = None, table: str | None = None, **sections: dict[str, Any] | None
    ) -> dict[str, Any]:
        """Isolation-forest outliers, near duplicates and missingness patterns. Pass e.g. ``near_duplicates={"enabled": False}``."""
        return self._c.post(
            f"/v1/datasets/{dataset_id}/profile/advanced", sections or None, params=_clean({"version": version, "table": table})
        )

    def annotations(self, dataset_id: str, version: int | None = None) -> dict[str, Any]:
        return self._c.get(f"/v1/datasets/{dataset_id}/annotations", params=_clean({"version": version}))

    def set_annotations(
        self,
        dataset_id: str,
        columns: dict[str, list[str]],
        *,
        entity: str | None = None,
        version: int | None = None,
        replace: bool = True,
    ) -> dict[str, Any]:
        """Tag columns with ``pii``, ``sensitive``, ``derived``, ``target`` or ``id`` (ANA-010)."""
        body = _clean({"columns": columns, "entity": entity, "version": version, "replace": replace})
        return self._c.put(f"/v1/datasets/{dataset_id}/annotations", body)

    def projection(self, dataset_id: str, *, version: int | None = None, **options: Any) -> dict[str, Any]:
        """2-D UMAP/t-SNE/PCA projection for visualization (FE-005a)."""
        return self._c.post(f"/v1/datasets/{dataset_id}/projection", options or None, params=_clean({"version": version}))

    def query(self, dataset_id: str, sql: str, row_limit: int = 1000, version: int | None = None) -> QueryResult:
        return self._c.post(f"/v1/datasets/{dataset_id}/query", {"sql": sql, "row_limit": row_limit}, params=_clean({"version": version}))

    def suggestions(self, dataset_id: str, question: str | None = None) -> list[dict[str, Any]]:
        return self._c.post(f"/v1/datasets/{dataset_id}/suggestions", _clean({"question": question}))

    def suggestion_feedback(self, dataset_id: str, accepted: bool, suggestion: dict[str, Any]) -> dict[str, Any]:
        """Teach the suggestion ranking (LLM-009). ``suggestion`` needs ``chart_type`` and ``category`` (``title`` optional)."""
        keep = {k: suggestion[k] for k in ("chart_type", "category", "title") if suggestion.get(k) is not None}
        return self._c.post(f"/v1/datasets/{dataset_id}/suggestions/feedback", {"accepted": accepted, "suggestion": keep})


class _Streams(_Resource):
    """Append-only streaming datasets (ING-008)."""

    def create(
        self,
        name: str,
        *,
        project_id: str | None = None,
        columns: Iterable[dict[str, Any]] | None = None,
        compact_rows: int | None = None,
        compact_bytes: int | None = None,
    ) -> dict[str, Any]:
        body = _clean(
            {
                "name": name,
                "project_id": project_id,
                "columns": list(columns) if columns is not None else None,
                "compact_rows": compact_rows,
                "compact_bytes": compact_bytes,
            }
        )
        return self._c.post("/v1/streams", body)

    def get(self, dataset_id: str) -> dict[str, Any]:
        """Buffer and storage status."""
        return self._c.get(f"/v1/streams/{dataset_id}")

    def send(self, dataset_id: str, records: Iterable[dict[str, Any]]) -> dict[str, Any]:
        """Append a micro-batch (up to 10,000 flat records / 10 MB). Not retried on 5xx, which could duplicate records."""
        return self._c.post(f"/v1/streams/{dataset_id}/records", {"records": list(records)})

    def compact(self, dataset_id: str, *, wait: bool = False, timeout: float = 3600) -> Job:
        """Fold the buffer into the next dataset version now (or return the compaction already in flight)."""
        return self._job(self._c.post(f"/v1/streams/{dataset_id}/compact"), wait, timeout)


class _Connectors(_Resource):
    """External sources: S3, GCS, PostgreSQL, MySQL (ING-007)."""

    def create(self, name: str, kind: str, config: dict[str, Any], credentials: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._c.post("/v1/connectors", {"name": name, "kind": kind, "config": config, "credentials": credentials or {}})

    def list(self) -> list[dict[str, Any]]:
        return self._c.get("/v1/connectors")

    def get(self, connector_id: str) -> dict[str, Any]:
        return self._c.get(f"/v1/connectors/{connector_id}")

    def delete(self, connector_id: str) -> None:
        self._c.delete(f"/v1/connectors/{connector_id}")

    def import_data(
        self,
        connector_id: str,
        *,
        key: str | None = None,
        prefix: str | None = None,
        query: str | None = None,
        name: str | None = None,
        project_id: str | None = None,
        row_limit: int | None = None,
        wait: bool = False,
        timeout: float = 3600,
    ) -> Job:
        """Import an object (``key``), objects under ``prefix``, or a SELECT ``query`` into a new dataset (a job)."""
        body = _clean({"key": key, "prefix": prefix, "query": query, "name": name, "project_id": project_id, "row_limit": row_limit})
        return self._job(self._c.post(f"/v1/connectors/{connector_id}/import", body), wait, timeout)

    def allowlist(self) -> dict[str, Any]:
        return self._c.get("/v1/connectors/allowlist")

    def set_allowlist(self, hosts: Iterable[str]) -> dict[str, Any]:
        return self._c.put("/v1/connectors/allowlist", {"hosts": list(hosts)})


class _Pipelines(_Resource):
    def create(self, dataset_id: str, name: str, steps: Iterable[dict[str, Any]] = ()) -> dict[str, Any]:
        return self._c.post("/v1/pipelines", {"dataset_id": dataset_id, "name": name, "steps": list(steps)})

    def add_step(self, pipeline_id: str, step: dict[str, Any]) -> dict[str, Any]:
        return self._c.post(f"/v1/pipelines/{pipeline_id}/steps", {"step": step})

    def undo(self, pipeline_id: str) -> dict[str, Any]:
        return self._c.post(f"/v1/pipelines/{pipeline_id}/undo")

    def redo(self, pipeline_id: str) -> dict[str, Any]:
        return self._c.post(f"/v1/pipelines/{pipeline_id}/redo")

    def preview(self, pipeline_id: str, step: dict[str, Any] | None = None, rows: int = 50) -> dict[str, Any]:
        return self._c.post(f"/v1/pipelines/{pipeline_id}/preview", _clean({"step": step, "rows": rows}))

    def apply(self, pipeline_id: str, *, wait: bool = False, timeout: float = 3600) -> Job:
        return self._job(self._c.post(f"/v1/pipelines/{pipeline_id}/apply"), wait, timeout)


class _Jobs(_Resource):
    def list(self, status: str | None = None) -> list[Job]:
        return self._c.get("/v1/jobs", params=_clean({"status": status}))

    def get(self, job_id: str) -> Job:
        return self._c.get(f"/v1/jobs/{job_id}")

    def cancel(self, job_id: str) -> Job:
        return self._c.post(f"/v1/jobs/{job_id}/cancel")

    def wait(self, job_id: str, *, timeout: float = 3600, interval: float = 1.0, on_progress: Callable[[Job], None] | None = None) -> Job:
        """Poll until the job finishes. Raises JobFailedError if it failed or was cancelled."""
        deadline = time.monotonic() + timeout
        while True:
            job = self.get(job_id)
            if on_progress:
                on_progress(job)
            if job["status"] == "succeeded":
                return job
            if job["status"] in ("failed", "cancelled"):
                raise JobFailedError(job)
            if time.monotonic() > deadline:
                raise TimeoutError(f"job {job_id} did not finish within {timeout}s")
            time.sleep(interval)
            interval = min(interval * 1.5, 10.0)


class _Schedules(_Resource):
    """Cron schedules for allowlisted job types (Phase 3)."""

    def types(self) -> list[dict[str, Any]]:
        """``[{job_type, permission, description, allowed}]``."""
        return self._c.get("/v1/schedules/types")

    def create(
        self,
        name: str,
        cron: str,
        job_type: str,
        params: dict[str, Any] | None = None,
        *,
        timezone: str = "UTC",
        enabled: bool = True,
    ) -> dict[str, Any]:
        body = {"name": name, "cron": cron, "timezone": timezone, "job_type": job_type, "params": params or {}, "enabled": enabled}
        return self._c.post("/v1/schedules", body)

    def list(self, job_type: str | None = None) -> list[dict[str, Any]]:
        return self._c.get("/v1/schedules", params=_clean({"job_type": job_type}))

    def get(self, schedule_id: str) -> dict[str, Any]:
        return self._c.get(f"/v1/schedules/{schedule_id}")

    def update(self, schedule_id: str, **patch: Any) -> dict[str, Any]:
        """Change ``name``, ``cron``, ``timezone``, ``params`` or ``enabled``."""
        return self._c.patch(f"/v1/schedules/{schedule_id}", patch)

    def pause(self, schedule_id: str) -> dict[str, Any]:
        return self.update(schedule_id, enabled=False)

    def resume(self, schedule_id: str) -> dict[str, Any]:
        return self.update(schedule_id, enabled=True)

    def delete(self, schedule_id: str) -> None:
        self._c.delete(f"/v1/schedules/{schedule_id}")

    def run(self, schedule_id: str, *, wait: bool = False, timeout: float = 3600) -> dict[str, Any]:
        """Run once now. Returns ``{schedule_id, status: "submitted", job_id}``, or the finished job with ``wait=True``."""
        out = self._c.post(f"/v1/schedules/{schedule_id}/run")
        return self._c.jobs.wait(out["job_id"], timeout=timeout) if wait else out


class _Notifications(_Resource):
    def list(self, unread_only: bool = False) -> list[dict[str, Any]]:
        return self._c.get("/v1/notifications", params={"unread_only": str(unread_only).lower()})

    def mark_read(self, notification_id: str) -> Any:
        return self._c.post(f"/v1/notifications/{notification_id}/read")

    def preferences(self) -> dict[str, Any]:
        return self._c.get("/v1/notifications/preferences")

    def set_preferences(self, email: Iterable[str]) -> dict[str, Any]:
        return self._c.put("/v1/notifications/preferences", {"email": list(email)})


class _Experiments(_Resource):
    def algorithms(self) -> list[dict[str, Any]]:
        return self._c.get("/v1/algorithms")

    def detect(self, dataset_id: str, target: str | None = None) -> dict[str, Any]:
        return self._c.post("/v1/experiments/detect", _clean({"dataset_id": dataset_id, "target": target}))

    def create(
        self, name: str, dataset_id: str, target: str | None, *, wait: bool = False, timeout: float = 3600, **config: Any
    ) -> dict[str, Any]:
        out = self._c.post("/v1/experiments", _clean({"name": name, "dataset_id": dataset_id, "target": target, **config}))
        if wait:
            self._c.jobs.wait(out["job"]["id"], timeout=timeout)
            return self.get(out["experiment"]["id"])
        return out

    def list(self) -> list[dict[str, Any]]:
        return self._c.get("/v1/experiments")

    def get(self, experiment_id: str) -> dict[str, Any]:
        return self._c.get(f"/v1/experiments/{experiment_id}")

    def best_run(self, experiment_id: str) -> dict[str, Any]:
        runs = self.get(experiment_id)["runs"]
        best = next(r for r in runs if r["artifacts"].get("is_best"))
        return self.run(best["id"])

    def run(self, run_id: str) -> dict[str, Any]:
        return self._c.get(f"/v1/runs/{run_id}")

    def compare(self, run_ids: Iterable[str]) -> dict[str, Any]:
        return self._c.get("/v1/experiments/compare", params={"run_ids": ",".join(run_ids)})

    def explain(self, run_id: str, instances: list[dict[str, Any]]) -> dict[str, Any]:
        return self._c.post(f"/v1/runs/{run_id}/explain", {"instances": instances})

    def explanation_text(self, run_id: str) -> dict[str, Any]:
        return self._c.post(f"/v1/runs/{run_id}/explanation-text")

    def fairness(self, run_id: str, protected: Iterable[str], *, positive_class: Any = None, min_group_size: int = 10) -> dict[str, Any]:
        """Group fairness metrics on the held-out test set (XAI-004)."""
        body = _clean({"protected": list(protected), "positive_class": positive_class, "min_group_size": min_group_size})
        return self._c.post(f"/v1/runs/{run_id}/fairness", body)

    def projection(self, run_id: str, **options: Any) -> dict[str, Any]:
        """2-D projection through the run's fitted preprocessing, coloured by its predictions (FE-005a)."""
        return self._c.post(f"/v1/runs/{run_id}/projection", options or None)

    def onnx(self, run_id: str) -> bytes:
        """Download the run's model as ONNX (409 ``onnx_unsupported`` when the pipeline can't be exported)."""
        return self._c.request("GET", f"/v1/runs/{run_id}/onnx", raw=True).content


class _TrainingTemplates(_Resource):
    """Reusable training configurations (CFG-007)."""

    def list(self) -> list[dict[str, Any]]:
        return self._c.get("/v1/training-templates")

    def create(self, name: str, config: dict[str, Any], description: str | None = None) -> dict[str, Any]:
        return self._c.post("/v1/training-templates", _clean({"name": name, "config": config, "description": description}))

    def get(self, template_id: str) -> dict[str, Any]:
        return self._c.get(f"/v1/training-templates/{template_id}")

    def update(self, template_id: str, *, config: dict[str, Any] | None = None, description: str | None = None) -> dict[str, Any]:
        return self._c.patch(f"/v1/training-templates/{template_id}", _clean({"config": config, "description": description}))

    def delete(self, template_id: str) -> None:
        self._c.delete(f"/v1/training-templates/{template_id}")

    def apply(
        self,
        template_id: str,
        name: str,
        dataset_id: str,
        overrides: dict[str, Any] | None = None,
        *,
        dataset_version: int | None = None,
        wait: bool = False,
        timeout: float = 3600,
    ) -> dict[str, Any]:
        """Start an experiment from the template; ``overrides`` (e.g. ``{"target": "churn"}``) are deep-merged over it."""
        body = _clean({"name": name, "dataset_id": dataset_id, "overrides": overrides or {}, "dataset_version": dataset_version})
        out = self._c.post(f"/v1/training-templates/{template_id}/apply", body)
        if wait:
            self._c.jobs.wait(out["job"]["id"], timeout=timeout)
            return self._c.experiments.get(out["experiment"]["id"])
        return out


class _Models(_Resource):
    def register(self, name: str, run_id: str, description: str | None = None) -> dict[str, Any]:
        return self._c.post("/v1/models", _clean({"name": name, "run_id": run_id, "description": description}))

    def upload(
        self,
        file: FileInput,
        signature: dict[str, Any],
        name: str,
        *,
        description: str | None = None,
        dataset_id: str | None = None,
        filename: str | None = None,
    ) -> dict[str, Any]:
        """Register a custom ONNX model (TRN-010). Validated server side; 422 ``model_rejected`` on failure. Not retried."""
        data, fname = _read_file(file, filename, "model.onnx")
        form = _clean({"signature": _json.dumps(signature), "name": name, "description": description, "dataset_id": dataset_id})
        return self._c.request("POST", "/v1/models/upload", data=form, files={"file": (fname, data, "application/octet-stream")})

    def list(self) -> list[dict[str, Any]]:
        return self._c.get("/v1/models")

    def get(self, model_id: str) -> dict[str, Any]:
        return self._c.get(f"/v1/models/{model_id}")

    def set_stage(self, model_id: str, version: int, stage: str) -> dict[str, Any]:
        return self._c.post(f"/v1/models/{model_id}/versions/{version}/stage", {"stage": stage})


class _Endpoints(_Resource):
    def deploy(self, name: str, model_id: str | None = None, version: int | None = None, **kw: Any) -> dict[str, Any]:
        return self._c.post("/v1/endpoints", _clean({"name": name, "model_id": model_id, "version": version, **kw}))

    def list(self) -> list[dict[str, Any]]:
        return self._c.get("/v1/endpoints")

    def get(self, name: str) -> dict[str, Any]:
        return self._c.get(f"/v1/endpoints/{name}")

    def update(self, name: str, **patch: Any) -> dict[str, Any]:
        return self._c.patch(f"/v1/endpoints/{name}", patch)

    def delete(self, name: str) -> None:
        self._c.delete(f"/v1/endpoints/{name}")

    def predict(
        self,
        name: str,
        instances: list[dict[str, Any]] | dict[str, Any] | None = None,
        *,
        explain: bool = False,
        horizon: int | None = None,
        history: list[dict[str, Any]] | None = None,
    ) -> Prediction:
        """Real-time inference.

        Classification/regression: ``predictions`` (+ ``probabilities``, ``classes``). Anomaly endpoints:
        ``predictions: [{is_anomaly, score}]`` and ``threshold``. Forecasting endpoints take ``horizon``/``history``
        instead of instances and return ``timestamps``, ``predictions``, ``lower`` and ``upper``.
        """
        if isinstance(instances, dict):
            instances = [instances]
        body: dict[str, Any] = _clean({"instances": instances, "horizon": horizon, "history": history})
        body["explain"] = explain
        # Inference has no side effects, so it is retried like a GET.
        return self._c.request("POST", f"/v1/endpoints/{name}/predict", idempotent=True, json=body)

    def forecast(self, name: str, horizon: int | None = None, history: list[dict[str, Any]] | None = None) -> Prediction:
        return self.predict(name, None, horizon=horizon, history=history)

    def predict_stream(
        self,
        name: str,
        instances: list[dict[str, Any]] | None = None,
        *,
        chunk_size: int = 100,
        explain: bool = False,
        horizon: int | None = None,
        history: list[dict[str, Any]] | None = None,
    ) -> Iterator[ServerSentEvent]:
        """Stream predictions as Server-Sent Events (API-006).

        Yields ``start``, then one ``prediction`` per chunk (or one ``forecast`` per horizon step), then ``done``.
        An ``error`` event raises the matching typed error.

        for event in ap.endpoints.predict_stream("churn-prod", rows, chunk_size=500):
            if event.event == "prediction":
                handle(event.data["offset"], event.data["predictions"])
        """
        body: dict[str, Any] = _clean({"instances": instances, "horizon": horizon, "history": history})
        body.update(explain=explain, chunk_size=chunk_size)
        return self._c.stream("POST", f"/v1/endpoints/{name}/predict/stream", json=body)

    def stream_token(self, name: str) -> dict[str, Any]:
        """Single-use token (60 s) for the WebSocket ``/v1/endpoints/{name}/ws?token=``: ``{token, expires_in, url}``."""
        return self._c.post(f"/v1/endpoints/{name}/stream-token")

    def batch(
        self, name: str, *, file: str | Path | bytes | None = None, dataset_id: str | None = None, wait: bool = False, timeout: float = 3600
    ) -> Any:
        if file is not None:
            data = Path(file).read_bytes() if isinstance(file, (str, Path)) else file
            job = self._c.post(f"/v1/endpoints/{name}/batch", files={"file": ("input.csv", data, "text/csv")})
        else:
            job = self._c.post(f"/v1/endpoints/{name}/batch", {"dataset_id": dataset_id})
        if not wait:
            return job
        self._c.jobs.wait(job["id"], timeout=timeout)
        return self.batch_result(name, job["id"])

    def batch_result(self, name: str, job_id: str) -> bytes:
        return self._c.get(f"/v1/endpoints/{name}/batch/{job_id}")

    def openapi(self, name: str) -> dict[str, Any]:
        return self._c.get(f"/v1/endpoints/{name}/openapi.json")

    def metrics(self, name: str, hours: int = 24) -> dict[str, Any]:
        return self._c.get(f"/v1/endpoints/{name}/metrics", params={"hours": hours})

    # -- canary rollouts (API-009) --
    def canary_start(
        self,
        name: str,
        model_version_id: str,
        *,
        steps: Iterable[int] | None = None,
        step_minutes: float | None = None,
        max_error_rate: float | None = None,
        max_p95_ms_increase: float | None = None,
        min_requests: int | None = None,
    ) -> dict[str, Any]:
        body = _clean(
            {
                "model_version_id": model_version_id,
                "steps": list(steps) if steps is not None else None,
                "step_minutes": step_minutes,
                "max_error_rate": max_error_rate,
                "max_p95_ms_increase": max_p95_ms_increase,
                "min_requests": min_requests,
            }
        )
        return self._c.post(f"/v1/endpoints/{name}/canary", body)

    def canary(self, name: str) -> dict[str, Any]:
        """The latest rollout: ``{id, status: running|completed|rolled_back|aborted, weight, history, live?, ...}``."""
        return self._c.get(f"/v1/endpoints/{name}/canary")

    def canary_promote(self, name: str) -> dict[str, Any]:
        return self._c.post(f"/v1/endpoints/{name}/canary/promote")

    def canary_abort(self, name: str) -> dict[str, Any]:
        return self._c.post(f"/v1/endpoints/{name}/canary/abort")

    def evaluate_canaries(self) -> Job:
        """Evaluate every due rollout step (point a scheduler at this)."""
        return self._c.post("/v1/endpoints/canary-steps")

    # -- drift (API-011) --
    def drift(self, name: str, hours: int = 24) -> dict[str, Any]:
        """PSI per feature and for the prediction distribution: ``{status, features, prediction, ...}``."""
        return self._c.get(f"/v1/endpoints/{name}/drift", params={"hours": hours})

    def drift_check(self, name: str, hours: int | None = None, *, wait: bool = False, timeout: float = 3600) -> Job:
        """Queue a drift check that alerts (notification + webhook) when the endpoint drifted."""
        return self._job(self._c.post(f"/v1/endpoints/{name}/drift/check", _clean({"hours": hours}) or None), wait, timeout)

    def drift_check_all(self, hours: int | None = None, *, wait: bool = False, timeout: float = 3600) -> Job:
        return self._job(self._c.post("/v1/endpoints/drift-checks", _clean({"hours": hours}) or None), wait, timeout)


class _Analytics(_Resource):
    def create(self, dataset_id: str, name: str, sql: str, **kw: Any) -> dict[str, Any]:
        return self._c.post("/v1/analytics", {"dataset_id": dataset_id, "name": name, "sql": sql, **kw})

    def list(self) -> list[dict[str, Any]]:
        return self._c.get("/v1/analytics")

    def run(self, analytic_id: str, params: dict[str, Any] | None = None, filters: dict[str, Any] | None = None) -> QueryResult:
        return self._c.post(f"/v1/analytics/{analytic_id}/run", {"params": params or {}, "filters": filters or {}})

    # -- multi-dataset analytics (LLM-008) --
    def query(self, datasets: dict[str, str], sql: str, row_limit: int = 1000) -> QueryResult:
        """SQL across 1-5 datasets, each loaded as a table named by its alias: ``{"orders": "ds_1", "customers": "ds_2"}``."""
        return self._c.post("/v1/analytics/query", {"datasets": datasets, "sql": sql, "row_limit": row_limit})

    def suggestions(self, datasets: dict[str, str], question: str | None = None) -> dict[str, Any]:
        """Cross-dataset suggestions and join candidates: ``{suggestions, join_candidates}``."""
        return self._c.post("/v1/analytics/suggestions", _clean({"datasets": datasets, "question": question}))

    def join_suggestions(self, datasets: dict[str, str]) -> list[dict[str, Any]]:
        """Just the join candidates ``[{left_table, left_column, right_table, right_column, containment}]``."""
        return self.suggestions(datasets)["join_candidates"]

    def suggestion_feedback(self, dataset_id: str, accepted: bool, suggestion: dict[str, Any]) -> dict[str, Any]:
        return self._c.datasets.suggestion_feedback(dataset_id, accepted, suggestion)

    def suggestion_preferences(self) -> dict[str, Any]:
        return self._c.get("/v1/suggestions/preferences")

    def reset_suggestion_preferences(self) -> None:
        self._c.delete("/v1/suggestions/preferences")


class _Dashboards(_Resource):
    def create(self, name: str, spec: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._c.post("/v1/dashboards", _clean({"name": name, "spec": spec}))

    def list(self) -> list[dict[str, Any]]:
        return self._c.get("/v1/dashboards")

    def get(self, dashboard_id: str) -> dict[str, Any]:
        return self._c.get(f"/v1/dashboards/{dashboard_id}")

    def update(self, dashboard_id: str, name: str | None = None, spec: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._c.put(f"/v1/dashboards/{dashboard_id}", _clean({"name": name, "spec": spec}))

    def widget_data(self, dashboard_id: str, widget_id: str, filters: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._c.post(f"/v1/dashboards/{dashboard_id}/widgets/{widget_id}/data", {"filters": filters or {}})

    def export_html(self, dashboard_id: str) -> bytes:
        return self._c.post(f"/v1/dashboards/{dashboard_id}/export", {})

    def share(self, dashboard_id: str, user_id: str, role: str = "viewer") -> dict[str, Any]:
        return self._c.post(f"/v1/dashboards/{dashboard_id}/share", {"user_id": user_id, "role": role})


class _Comments(_Resource):
    """Dashboard comment threads (SHR-005)."""

    def list(self, dashboard_id: str, *, widget_id: str | None = None, include_resolved: bool = True) -> list[dict[str, Any]]:
        params = _clean({"widget_id": widget_id, "include_resolved": str(include_resolved).lower()})
        return self._c.get(f"/v1/dashboards/{dashboard_id}/comments", params=params)

    def create(self, dashboard_id: str, body: str, *, widget_id: str | None = None, parent_id: str | None = None) -> dict[str, Any]:
        return self._c.post(
            f"/v1/dashboards/{dashboard_id}/comments", _clean({"body": body, "widget_id": widget_id, "parent_id": parent_id})
        )

    def reply(self, dashboard_id: str, parent_id: str, body: str) -> dict[str, Any]:
        return self.create(dashboard_id, body, parent_id=parent_id)

    def update(self, dashboard_id: str, comment_id: str, *, body: str | None = None, resolved: bool | None = None) -> dict[str, Any]:
        return self._c.patch(f"/v1/dashboards/{dashboard_id}/comments/{comment_id}", _clean({"body": body, "resolved": resolved}))

    def resolve(self, dashboard_id: str, comment_id: str, resolved: bool = True) -> dict[str, Any]:
        return self.update(dashboard_id, comment_id, resolved=resolved)

    def delete(self, dashboard_id: str, comment_id: str) -> None:
        self._c.delete(f"/v1/dashboards/{dashboard_id}/comments/{comment_id}")


class _Webhooks(_Resource):
    def create(self, url: str, events: list[str]) -> dict[str, Any]:
        return self._c.post("/v1/webhooks", {"url": url, "events": events})

    def list(self) -> list[dict[str, Any]]:
        return self._c.get("/v1/webhooks")

    def deliveries(self, webhook_id: str) -> list[dict[str, Any]]:
        return self._c.get(f"/v1/webhooks/{webhook_id}/deliveries")


def verify_webhook_signature(secret: str, body: bytes, header: str, tolerance_seconds: int = 300) -> bool:
    """Verify an ``X-AP-Signature`` header (``t=<unix>,v1=<hex hmac-sha256(secret, t + '.' + body)>``)."""
    try:
        parts = dict(p.split("=", 1) for p in header.split(","))
        ts = int(parts["t"])
        expected = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    except (ValueError, KeyError):
        return False
    return abs(time.time() - ts) <= tolerance_seconds and hmac.compare_digest(expected, parts.get("v1", ""))
