"""Python SDK for the Analytics Platform API (SDK-002, SDK-007, SDK-008).

from analytics_platform import Client

ap = Client("https://api.example.com", api_key="ap_live_...")
ap.endpoints.predict("churn-prod", [{"age": 42, "plan": "pro"}])
"""

from __future__ import annotations

import hashlib
import hmac
import os
import random
import threading
import time
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any, BinaryIO, TypedDict

import httpx

from .errors import AuthenticationError, JobFailedError, error_for

__all__ = ["Client", "verify_webhook_signature"]

DEFAULT_TIMEOUT = 60.0
RETRY_STATUSES = {408, 429, 500, 502, 503, 504}
POST_RETRY_STATUSES = {429, 503}  # safe to retry: the server did not process the request


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


class Client:
    def __init__(
        self,
        base_url: str | None = None,
        *,
        api_key: str | None = None,
        access_token: str | None = None,
        refresh_token: str | None = None,
        on_tokens: Callable[[dict[str, Any]], None] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = 3,
        http: httpx.Client | None = None,
    ):
        self.base_url = (base_url or os.environ.get("AP_URL") or "http://localhost:8000").rstrip("/")
        self.api_key = api_key if api_key is not None else os.environ.get("AP_API_KEY")
        self.access_token = access_token
        self.refresh_token = refresh_token
        self.on_tokens = on_tokens
        self.max_retries = max_retries
        self._http = http or httpx.Client(timeout=timeout, headers={"User-Agent": "analytics-platform-python/0.1"})
        self._refresh_lock = threading.Lock()
        self.auth = _Auth(self)
        self.tenant = _Tenant(self)
        self.schemas = _Schemas(self)
        self.datasets = _Datasets(self)
        self.pipelines = _Pipelines(self)
        self.jobs = _Jobs(self)
        self.experiments = _Experiments(self)
        self.models = _Models(self)
        self.endpoints = _Endpoints(self)
        self.analytics = _Analytics(self)
        self.dashboards = _Dashboards(self)
        self.webhooks = _Webhooks(self)

    # -- transport ------------------------------------------------------------------------------
    def _headers(self) -> dict[str, str]:
        if self.api_key:
            return {"X-API-Key": self.api_key}
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
        attempt = 0
        while True:
            try:
                response = self._http.request(method, self._url(path), headers={**self._headers(), **kwargs.pop("headers", {})}, **kwargs)
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
            if status == 401 and not _refreshed and self.refresh_token and not self.api_key and path != "/v1/auth/refresh":
                self._refresh()
                return self.request(method, path, raw=raw, idempotent=idempotent, _refreshed=True, **kwargs)
            retryable = status in (RETRY_STATUSES if idempotent else POST_RETRY_STATUSES)
            if retryable and attempt < self.max_retries:
                self._sleep(attempt, response.headers.get("retry-after"))
                attempt += 1
                continue
            if status >= 400:
                try:
                    detail = response.json().get("detail", response.text)
                except ValueError:
                    detail = response.text
                retry_after = float(response.headers["retry-after"]) if response.headers.get("retry-after", "").isdigit() else None
                raise error_for(status, detail, method=method, path=path, retry_after=retry_after)
            if raw:
                return response
            if status == 204 or not response.content:
                return None
            if "json" in response.headers.get("content-type", ""):
                return response.json()
            return response.content

    @staticmethod
    def _sleep(attempt: int, retry_after: str | None) -> None:
        if retry_after and retry_after.replace(".", "", 1).isdigit():
            delay = min(float(retry_after), 60.0)
        else:
            delay = min(0.5 * 2**attempt, 20.0) * (0.5 + random.random() / 2)
        time.sleep(delay)

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
    except ValueError:
        return response.text


def _clean(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


class _Resource:
    def __init__(self, client: Client):
        self._c = client


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


class _Schemas(_Resource):
    def parse(self, content: str, format: str = "json_schema") -> dict[str, Any]:  # noqa: A002
        return self._c.post("/v1/schemas/parse", {"format": format, "content": content})

    def preview(self, schema: dict[str, Any], **options: Any) -> dict[str, Any]:
        return self._c.post("/v1/generate/preview", {"schema": schema, "options": options})

    def generate(self, schema: dict[str, Any], *, format: str = "csv", save_as: str | None = None, **options: Any) -> Any:  # noqa: A002
        return self._c.post("/v1/generate", _clean({"schema": schema, "options": options, "format": format, "save_as": save_as}))


class _Datasets(_Resource):
    def upload(self, file: str | Path | bytes | BinaryIO, filename: str | None = None, *, sha256: bool = True) -> dict[str, Any]:
        """Upload a file (path, bytes or binary file object). Sends a SHA-256 so corruption in transit is detected (ING-009)."""
        if isinstance(file, (str, Path)):
            path = Path(file)
            data, filename = path.read_bytes(), filename or path.name
        elif isinstance(file, bytes):
            data = file
        else:
            data = file.read()
        headers = {"X-Content-SHA256": hashlib.sha256(data).hexdigest()} if sha256 else {}
        # Not idempotent: each upload creates a dataset, so a 5xx is not retried.
        return self._c.request(
            "PUT", "/v1/datasets/upload", idempotent=False, content=data, params={"filename": filename or "upload.csv"}, headers=headers
        )

    def list(self) -> list[dict[str, Any]]:
        return self._c.get("/v1/datasets")

    def get(self, dataset_id: str, version: int | None = None) -> dict[str, Any]:
        return self._c.get(f"/v1/datasets/{dataset_id}", params=_clean({"version": version}))

    def versions(self, dataset_id: str) -> list[dict[str, Any]]:
        return self._c.get(f"/v1/datasets/{dataset_id}/versions")

    def delete(self, dataset_id: str) -> None:
        self._c.delete(f"/v1/datasets/{dataset_id}")

    def confirm_schema(self, dataset_id: str, schema: dict[str, Any]) -> dict[str, Any]:
        return self._c.put(f"/v1/datasets/{dataset_id}/schema", schema)

    def profile(self, dataset_id: str, version: int | None = None) -> dict[str, Any]:
        return self._c.get(f"/v1/datasets/{dataset_id}/profile", params=_clean({"version": version}))

    def query(self, dataset_id: str, sql: str, row_limit: int = 1000, version: int | None = None) -> QueryResult:
        return self._c.post(f"/v1/datasets/{dataset_id}/query", {"sql": sql, "row_limit": row_limit}, params=_clean({"version": version}))

    def suggestions(self, dataset_id: str, question: str | None = None) -> list[dict[str, Any]]:
        return self._c.post(f"/v1/datasets/{dataset_id}/suggestions", _clean({"question": question}))


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
        job = self._c.post(f"/v1/pipelines/{pipeline_id}/apply")
        return self._c.jobs.wait(job["id"], timeout=timeout) if wait else job


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


class _Experiments(_Resource):
    def algorithms(self) -> list[dict[str, Any]]:
        return self._c.get("/v1/algorithms")

    def detect(self, dataset_id: str, target: str) -> dict[str, Any]:
        return self._c.post("/v1/experiments/detect", {"dataset_id": dataset_id, "target": target})

    def create(
        self, name: str, dataset_id: str, target: str, *, wait: bool = False, timeout: float = 3600, **config: Any
    ) -> dict[str, Any]:
        out = self._c.post("/v1/experiments", {"name": name, "dataset_id": dataset_id, "target": target, **config})
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


class _Models(_Resource):
    def register(self, name: str, run_id: str, description: str | None = None) -> dict[str, Any]:
        return self._c.post("/v1/models", _clean({"name": name, "run_id": run_id, "description": description}))

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

    def predict(self, name: str, instances: list[dict[str, Any]] | dict[str, Any], *, explain: bool = False) -> Prediction:
        if isinstance(instances, dict):
            instances = [instances]
        # Inference has no side effects, so it is retried like a GET.
        return self._c.request("POST", f"/v1/endpoints/{name}/predict", idempotent=True, json={"instances": instances, "explain": explain})

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


class _Analytics(_Resource):
    def create(self, dataset_id: str, name: str, sql: str, **kw: Any) -> dict[str, Any]:
        return self._c.post("/v1/analytics", {"dataset_id": dataset_id, "name": name, "sql": sql, **kw})

    def list(self) -> list[dict[str, Any]]:
        return self._c.get("/v1/analytics")

    def run(self, analytic_id: str, params: dict[str, Any] | None = None, filters: dict[str, Any] | None = None) -> QueryResult:
        return self._c.post(f"/v1/analytics/{analytic_id}/run", {"params": params or {}, "filters": filters or {}})


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
