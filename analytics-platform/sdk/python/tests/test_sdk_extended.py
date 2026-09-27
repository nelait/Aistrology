"""Unit tests (mock transport) for the Phase 2/3 resources, OAuth client credentials and SSE streaming."""

from __future__ import annotations

import hashlib
import io
import json
from urllib.parse import parse_qs

import httpx
import pytest

from analytics_platform import AuthenticationError, Client, ConflictError, RateLimitError, ServerError, parse_sse
from analytics_platform import client as client_mod
from analytics_platform.cli import run as cli_run


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(client_mod.time, "sleep", lambda s: None)


def mock_client(handler, **kw) -> Client:
    return Client("https://api.test", http=httpx.Client(transport=httpx.MockTransport(handler)), **kw)


class Recorder:
    """Routes ``(METHOD, path)`` to canned JSON and records every request."""

    def __init__(self, routes: dict[tuple[str, str], object] | None = None, default: object = None):
        self.routes = routes or {}
        self.default = {} if default is None else default
        self.requests: list[httpx.Request] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.requests.append(req)
        out = self.routes.get((req.method, req.url.path), self.default)
        if isinstance(out, httpx.Response):
            return out
        return httpx.Response(200, json=out)

    def body(self, i: int = -1):
        return json.loads(self.requests[i].content or b"null")

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]


# -- OAuth 2.0 client credentials -----------------------------------------------------------------


def test_client_credentials_fetches_caches_and_renews(monkeypatch):
    now = {"t": 1000.0}
    monkeypatch.setattr(client_mod.time, "monotonic", lambda: now["t"])
    issued = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth/token":
            form = parse_qs(req.content.decode())
            assert form["grant_type"] == ["client_credentials"] and form["client_id"] == ["apc_1"]
            assert form["client_secret"] == ["s3cret"] and form["scope"] == ["endpoints.predict data.read"]
            assert req.headers["content-type"].startswith("application/x-www-form-urlencoded")
            issued.append(f"tok{len(issued) + 1}")
            return httpx.Response(200, json={"access_token": issued[-1], "token_type": "bearer", "expires_in": 900})
        return httpx.Response(200, json={"auth": req.headers["authorization"]})

    monkeypatch.delenv("AP_API_KEY", raising=False)
    saved = []
    c = mock_client(handler, client_id="apc_1", client_secret="s3cret", scope=["endpoints.predict", "data.read"], on_tokens=saved.append)
    assert c.auth.me() == {"auth": "Bearer tok1"}
    assert c.auth.me() == {"auth": "Bearer tok1"}  # cached
    assert len(issued) == 1 and saved[0]["access_token"] == "tok1"
    now["t"] += 900 - 10  # within the renewal margin
    assert c.auth.me() == {"auth": "Bearer tok2"}
    assert len(issued) == 2


def test_client_credentials_ignores_env_api_key_and_refetches_on_401(monkeypatch):
    monkeypatch.setenv("AP_API_KEY", "ap_live_env")
    state = {"valid": "tok1", "issued": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth/token":
            state["issued"] += 1
            return httpx.Response(200, json={"access_token": f"tok{state['issued']}", "expires_in": 900})
        assert "x-api-key" not in req.headers
        if req.headers["authorization"] != f"Bearer {state['valid']}":
            return httpx.Response(401, json={"detail": "token revoked"})
        return httpx.Response(200, json=[])

    c = mock_client(handler, client_id="apc_1", client_secret="s")
    assert c.datasets.list() == []
    state["valid"] = "tok2"  # e.g. the signing key rotated
    assert c.datasets.list() == [] and state["issued"] == 2


def test_client_credentials_errors_are_typed():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "invalid_client", "error_description": "unknown client"})

    c = mock_client(handler, client_id="apc_x", client_secret="bad")
    with pytest.raises(AuthenticationError) as exc:
        c.auth.me()
    assert exc.value.code == "invalid_client" and "unknown client" in str(exc.value)


def test_client_credentials_token_retries_on_503():
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth/token":
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx.Response(503, headers={"Retry-After": "1"}, json={"error": "temporarily_unavailable"})
            return httpx.Response(200, json={"access_token": "t", "expires_in": 60})
        return httpx.Response(200, json={"ok": True})

    assert mock_client(handler, client_id="a", client_secret="b").auth.me() == {"ok": True}
    assert calls["n"] == 2


# -- SSE streaming inference -----------------------------------------------------------------------


def _sse(*events: tuple[str, object]) -> bytes:
    return "".join(f"event: {e}\ndata: {json.dumps(d)}\n\n" for e, d in events).encode()


def test_parse_sse_handles_comments_multiline_and_non_json():
    lines = [": keep-alive", "event: start", 'data: {"total":', "data: 2}", "", "data: plain text", "", "event: done", "data: {}"]
    events = list(parse_sse(lines))
    assert [(e.event, e.data) for e in events] == [("start", {"total": 2}), ("message", "plain text"), ("done", {})]


def test_predict_stream_yields_events():
    body = _sse(
        ("start", {"endpoint": "churn", "total": 3, "chunk_size": 2}),
        ("prediction", {"offset": 0, "count": 2, "predictions": ["no", "yes"]}),
        ("prediction", {"offset": 2, "count": 1, "predictions": ["no"]}),
        ("done", {"total": 3}),
    )
    rec = Recorder(
        {("POST", "/v1/endpoints/churn/predict/stream"): httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})}
    )
    c = mock_client(rec, api_key="k")
    events = list(c.endpoints.predict_stream("churn", [{"a": 1}, {"a": 2}, {"a": 3}], chunk_size=2))
    assert [e.event for e in events] == ["start", "prediction", "prediction", "done"]
    assert sum((e.data["predictions"] for e in events if e.event == "prediction"), []) == ["no", "yes", "no"]
    assert rec.body() == {"instances": [{"a": 1}, {"a": 2}, {"a": 3}], "explain": False, "chunk_size": 2}
    assert rec.last.headers["accept"] == "text/event-stream"


def test_predict_stream_error_event_raises_typed_error():
    body = _sse(
        ("start", {"total": 4}),
        ("prediction", {"offset": 0, "predictions": [1]}),
        ("error", {"status": 429, "detail": "rate limit exceeded"}),
    )
    c = mock_client(lambda r: httpx.Response(200, content=body, headers={"content-type": "text/event-stream"}), api_key="k")
    seen = []
    with pytest.raises(RateLimitError):
        for event in c.endpoints.predict_stream("m", [{}] * 4, chunk_size=1):
            seen.append(event.event)
    assert seen == ["start", "prediction"]


def test_predict_stream_retries_before_start_and_forecast_body():
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"Retry-After": "1"}, json={"detail": "too many concurrent streams"})
        assert json.loads(req.content) == {"horizon": 2, "explain": False, "chunk_size": 100}
        return httpx.Response(
            200, content=_sse(("start", {"horizon": 2}), ("forecast", {"step": 1}), ("forecast", {"step": 2}), ("done", {}))
        )

    events = list(mock_client(handler, api_key="k").endpoints.predict_stream("sales", horizon=2))
    assert [e.event for e in events] == ["start", "forecast", "forecast", "done"] and calls["n"] == 2


def test_predict_stream_http_error_before_start():
    c = mock_client(lambda r: httpx.Response(500, json={"detail": "boom"}), api_key="k")
    with pytest.raises(ServerError):
        list(c.endpoints.predict_stream("m", [{}]))


def test_predict_stream_refreshes_user_token():
    state = {"access": "a1"}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/v1/auth/refresh":
            state["access"] = "a2"
            return httpx.Response(200, json={"access_token": "a2", "refresh_token": "r2"})
        if req.headers.get("authorization") != f"Bearer {state['access']}" or state["access"] == "a1":
            return httpx.Response(401, json={"detail": "expired"})
        return httpx.Response(200, content=_sse(("done", {"total": 0})))

    c = mock_client(handler, api_key="", access_token="a1", refresh_token="r1")
    assert [e.event for e in c.endpoints.predict_stream("m", [{}])] == ["done"]
    assert c.refresh_token == "r2"


# -- resources: paths, bodies, idempotency ---------------------------------------------------------


def test_forecast_and_anomaly_predict_shapes():
    rec = Recorder(default={"predictions": [{"is_anomaly": True, "score": 0.9}], "threshold": 0.5})
    c = mock_client(rec, api_key="k")
    out = c.endpoints.predict("fraud", {"amount": 10})
    assert out["predictions"][0]["is_anomaly"] and out["threshold"] == 0.5
    c.endpoints.forecast("sales", horizon=7, history=[{"timestamp": "2026-01-01", "value": 3}])
    assert rec.body() == {"horizon": 7, "history": [{"timestamp": "2026-01-01", "value": 3}], "explain": False}


def test_phase3_resource_requests():
    rec = Recorder(
        {
            ("POST", "/v1/schedules/s1/run"): {"schedule_id": "s1", "status": "submitted", "job_id": "j1"},
            ("POST", "/v1/analytics/suggestions"): {"suggestions": [], "join_candidates": [{"left_table": "o"}]},
        }
    )
    c = mock_client(rec, api_key="k")
    cases = [
        (lambda: c.projects.create("Risk", members=["u1"]), "POST", "/v1/projects", {"name": "Risk", "open": False, "members": ["u1"]}),
        (lambda: c.projects.add_team("p1", "t1"), "POST", "/v1/projects/p1/teams", {"team_id": "t1"}),
        (lambda: c.teams.create("ds", members=["u1"]), "POST", "/v1/teams", {"name": "ds", "members": ["u1"]}),
        (lambda: c.teams.remove_member("t1", "u1"), "DELETE", "/v1/teams/t1/members/u1", None),
        (
            lambda: c.schedules.create("nightly", "0 2 * * *", "dataset.profile", {"dataset_id": "d1"}, timezone="Europe/Paris"),
            "POST",
            "/v1/schedules",
            {
                "name": "nightly",
                "cron": "0 2 * * *",
                "timezone": "Europe/Paris",
                "job_type": "dataset.profile",
                "params": {"dataset_id": "d1"},
                "enabled": True,
            },
        ),
        (lambda: c.schedules.pause("s1"), "PATCH", "/v1/schedules/s1", {"enabled": False}),
        (lambda: c.schedules.run("s1"), "POST", "/v1/schedules/s1/run", None),
        (
            lambda: c.connectors.create("lake", "s3", {"bucket": "b"}, {"access_key_id": "a", "secret_access_key": "s"}),
            "POST",
            "/v1/connectors",
            {"name": "lake", "kind": "s3", "config": {"bucket": "b"}, "credentials": {"access_key_id": "a", "secret_access_key": "s"}},
        ),
        (
            lambda: c.connectors.import_data("c1", prefix="raw/", name="raw"),
            "POST",
            "/v1/connectors/c1/import",
            {"prefix": "raw/", "name": "raw"},
        ),
        (lambda: c.streams.create("clicks", compact_rows=500), "POST", "/v1/streams", {"name": "clicks", "compact_rows": 500}),
        (lambda: c.streams.send("d1", [{"a": 1}]), "POST", "/v1/streams/d1/records", {"records": [{"a": 1}]}),
        (lambda: c.streams.compact("d1"), "POST", "/v1/streams/d1/compact", None),
        (
            lambda: c.comments.reply("db1", "c1", "@u2 thoughts?"),
            "POST",
            "/v1/dashboards/db1/comments",
            {"body": "@u2 thoughts?", "parent_id": "c1"},
        ),
        (lambda: c.comments.resolve("db1", "c1"), "PATCH", "/v1/dashboards/db1/comments/c1", {"resolved": True}),
        (
            lambda: c.analytics.query({"o": "d1", "c": "d2"}, "SELECT 1"),
            "POST",
            "/v1/analytics/query",
            {"datasets": {"o": "d1", "c": "d2"}, "sql": "SELECT 1", "row_limit": 1000},
        ),
        (
            lambda: c.analytics.suggestion_feedback("d1", True, {"chart_type": "bar", "category": "descriptive", "title": "t", "sql": "x"}),
            "POST",
            "/v1/datasets/d1/suggestions/feedback",
            {"accepted": True, "suggestion": {"chart_type": "bar", "category": "descriptive", "title": "t"}},
        ),
        (
            lambda: c.schemas.save("orders", {"entities": []}, message="v1"),
            "POST",
            "/v1/schemas",
            {"name": "orders", "schema": {"entities": []}, "message": "v1"},
        ),
        (lambda: c.schemas.diff("sc1", 1, 2), "GET", "/v1/schemas/sc1/diff", None),
        (
            lambda: c.datasets.set_annotations("d1", {"email": ["pii"]}),
            "PUT",
            "/v1/datasets/d1/annotations",
            {"columns": {"email": ["pii"]}, "replace": True},
        ),
        (
            lambda: c.datasets.advanced_profile("d1", near_duplicates={"enabled": False}),
            "POST",
            "/v1/datasets/d1/profile/advanced",
            {"near_duplicates": {"enabled": False}},
        ),
        (
            lambda: c.datasets.projection("d1", method="pca", sample=100),
            "POST",
            "/v1/datasets/d1/projection",
            {"method": "pca", "sample": 100},
        ),
        (
            lambda: c.training_templates.apply("tt1", "exp", "d1", {"target": "churn"}),
            "POST",
            "/v1/training-templates/tt1/apply",
            {"name": "exp", "dataset_id": "d1", "overrides": {"target": "churn"}},
        ),
        (lambda: c.experiments.fairness("r1", ["plan"]), "POST", "/v1/runs/r1/fairness", {"protected": ["plan"], "min_group_size": 10}),
        (lambda: c.experiments.projection("r1"), "POST", "/v1/runs/r1/projection", None),
        (
            lambda: c.endpoints.canary_start("churn", "mv2", steps=[10, 100], min_requests=5),
            "POST",
            "/v1/endpoints/churn/canary",
            {"model_version_id": "mv2", "steps": [10, 100], "min_requests": 5},
        ),
        (lambda: c.endpoints.canary_abort("churn"), "POST", "/v1/endpoints/churn/canary/abort", None),
        (lambda: c.endpoints.drift_check("churn", 48), "POST", "/v1/endpoints/churn/drift/check", {"hours": 48}),
        (lambda: c.endpoints.stream_token("churn"), "POST", "/v1/endpoints/churn/stream-token", None),
        (
            lambda: c.tenant.create_oauth_client("etl", "analyst", ["data.read"]),
            "POST",
            "/v1/tenant/oauth-clients",
            {"name": "etl", "role": "analyst", "scopes": ["data.read"]},
        ),
        (lambda: c.notifications.set_preferences(["job.failed"]), "PUT", "/v1/notifications/preferences", {"email": ["job.failed"]}),
    ]
    for call, method, path, body in cases:
        call()
        assert (rec.last.method, rec.last.url.path) == (method, path), path
        assert rec.body() == body, path
    assert c.analytics.join_suggestions({"o": "d1", "c": "d2"}) == [{"left_table": "o"}]
    c.endpoints.drift("churn", hours=6)
    assert rec.last.url.params["hours"] == "6"
    c.schedules.list(job_type="stream.compact")
    assert rec.last.url.params["job_type"] == "stream.compact"


def test_uploads_are_not_retried_but_predict_and_downloads_are():
    calls: dict[str, int] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        calls[req.url.path] = calls.get(req.url.path, 0) + 1
        if req.url.path == "/v1/runs/r1/onnx":
            if calls[req.url.path] == 1:
                return httpx.Response(502)
            return httpx.Response(200, content=b"\x08\x01onnx", headers={"content-type": "application/octet-stream"})
        return httpx.Response(500, json={"detail": "boom"})

    c = mock_client(handler, api_key="k")
    with pytest.raises(ServerError):
        c.datasets.append("d1", b"a\n1\n", "more.csv")
    with pytest.raises(ServerError):
        c.models.upload(io.BytesIO(b"onnx"), {"problem_type": "regression", "features": []}, "custom")
    with pytest.raises(ServerError):
        c.streams.send("d1", [{"a": 1}])
    assert calls["/v1/datasets/d1/versions"] == 1 and calls["/v1/models/upload"] == 1 and calls["/v1/streams/d1/records"] == 1
    assert c.experiments.onnx("r1") == b"\x08\x01onnx" and calls["/v1/runs/r1/onnx"] == 2


def test_dataset_version_and_model_upload_multipart():
    rec = Recorder(default={"ok": True})
    c = mock_client(rec, api_key="k")
    c.datasets.replace("d1", b"a,b\n1,2\n", "v2.csv")
    req = rec.last
    assert req.url.params["mode"] == "replace" and b'filename="v2.csv"' in req.content and "x-content-sha256" in req.headers
    c.models.upload(
        b"onnxbytes", {"problem_type": "binary", "classes": [0, 1], "features": [{"name": "x", "type": "number"}]}, "m", dataset_id="d1"
    )
    content = rec.last.content
    assert b'name="signature"' in content and b'"problem_type": "binary"' in content and b'name="dataset_id"' in content


def test_canary_conflict_is_typed():
    c = mock_client(lambda r: httpx.Response(409, json={"detail": "no rollout is running"}), api_key="k")
    with pytest.raises(ConflictError):
        c.endpoints.canary_promote("churn")


# -- CLI --------------------------------------------------------------------------------------------


def test_cli_new_commands(capsys, tmp_path):
    rec = Recorder(default={"ok": True})
    c = mock_client(rec, api_key="k")
    assert cli_run(["schedules", "create", "nightly", "0 2 * * *", "stream.compact", "--params", '{"dataset_id": "d1"}'], client=c) == 0
    assert rec.body()["job_type"] == "stream.compact" and rec.body()["params"] == {"dataset_id": "d1"}
    assert cli_run(["schedules", "run", "s1"], client=c) == 0 and rec.last.url.path == "/v1/schedules/s1/run"
    jsonl = tmp_path / "events.jsonl"
    jsonl.write_text('{"a": 1}\n{"a": 2}\n')
    assert cli_run(["streams", "send", "d1", f"@{jsonl}"], client=c) == 0
    assert rec.body() == {"records": [{"a": 1}, {"a": 2}]}
    assert cli_run(["streams", "send", "d1", '[{"a": 3}]'], client=c) == 0 and rec.body() == {"records": [{"a": 3}]}
    assert cli_run(["endpoints", "canary", "churn", "start", "--model-version-id", "mv2", "--steps", "10,50,100"], client=c) == 0
    assert rec.body() == {"model_version_id": "mv2", "steps": [10, 50, 100]}
    assert cli_run(["endpoints", "canary", "churn", "abort"], client=c) == 0 and rec.last.url.path == "/v1/endpoints/churn/canary/abort"
    assert cli_run(["endpoints", "drift", "churn", "--hours", "12"], client=c) == 0
    assert rec.last.method == "GET" and rec.last.url.params["hours"] == "12"
    assert cli_run(["endpoints", "drift", "churn", "--check"], client=c) == 0 and rec.last.url.path == "/v1/endpoints/churn/drift/check"
    capsys.readouterr()


# -- resumable uploads and retention ----------------------------------------------------------------


class FakeUploadServer:
    """Just enough of /v1/datasets/uploads to exercise the resume logic, with injected failures."""

    def __init__(self, part_max: int = 4, fail: tuple[str, ...] = ()):
        self.part_max = part_max
        self.fail = list(fail)
        self.received = b""
        self.size = 0
        self.created: dict | None = None
        self.patches: list[int] = []

    def status(self) -> dict:
        return {
            "id": "up1",
            "filename": "f.csv",
            "size": self.size,
            "offset": len(self.received),
            "status": "open",
            "part_max_bytes": self.part_max,
        }

    def __call__(self, req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if req.method == "POST" and path == "/v1/datasets/uploads":
            self.created = json.loads(req.content)
            self.size = self.created["size"]
            return httpx.Response(201, json=self.status())
        if req.method == "GET" and path == "/v1/datasets/uploads/up1":
            return httpx.Response(200, json=self.status(), headers={"Upload-Offset": str(len(self.received))})
        if req.method == "PATCH":
            offset = int(req.headers["upload-offset"])
            self.patches.append(offset)
            action = self.fail.pop(0) if self.fail else "ok"
            if action == "500-after-store":  # the part was stored but the response was lost
                self.received += req.content
                return httpx.Response(500, json={"detail": "boom"})
            if action == "connect":
                raise httpx.ConnectError("connection reset")
            if offset != len(self.received):
                return httpx.Response(409, json={"detail": {"message": "offset mismatch", "offset": len(self.received)}})
            assert len(req.content) <= self.part_max
            self.received += req.content
            return httpx.Response(200, json=self.status(), headers={"Upload-Offset": str(len(self.received))})
        if req.method == "POST" and path == "/v1/datasets/uploads/up1/complete":
            return httpx.Response(201, json={"dataset": {"id": "ds1", "size": len(self.received)}, "inference": {}})
        return httpx.Response(404, json={"detail": "not found"})


def test_upload_resumable_recovers_from_lost_responses_and_resets(tmp_path):
    data = b"a,b\n1,2\n3,4\n5,6\n"
    path = tmp_path / "f.csv"
    path.write_bytes(data)
    server = FakeUploadServer(part_max=5, fail=("ok", "500-after-store", "connect"))
    progress = []
    out = mock_client(server, api_key="k").datasets.upload_resumable(path, on_progress=lambda s, t: progress.append(s))
    assert out["dataset"]["id"] == "ds1" and server.received == data
    assert server.created == {"filename": "f.csv", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    assert progress[-1] == len(data)


def test_upload_resumable_resumes_a_session_with_custom_part_size():
    data = bytes(range(20))
    server = FakeUploadServer(part_max=8)
    server.size = len(data)
    server.received = data[:6]  # an earlier process got this far
    out = mock_client(server, api_key="k").datasets.upload_resumable(io.BytesIO(data), "blob.bin", upload_id="up1", part_size=3)
    assert out["dataset"]["size"] == 20 and server.received == data
    assert server.patches == [6, 9, 12, 15, 18]


def test_upload_switches_to_resumable_above_threshold(monkeypatch):
    monkeypatch.setattr(client_mod, "RESUMABLE_THRESHOLD", 10)
    server = FakeUploadServer(part_max=16)
    out = mock_client(server, api_key="k").datasets.upload(b"x" * 40, "big.csv")
    assert out["dataset"]["id"] == "ds1" and len(server.patches) == 3


def test_retention_merges_partial_updates():
    policy = {"llm_bodies_days": 30, "llm_metadata_days": 395, "audit_days": 395, "inference_logs_days": 30}
    rec = Recorder({("GET", "/v1/tenant/retention"): policy})
    c = mock_client(rec, api_key="k")
    c.tenant.set_retention(inference_logs_days=14)
    assert rec.last.method == "PUT" and rec.body() == {**policy, "inference_logs_days": 14}
    c.tenant.apply_retention()
    assert rec.last.url.path == "/v1/tenant/retention/apply"
