from __future__ import annotations

import hashlib
import hmac
import io
import json
import sys
import time
from pathlib import Path

import httpx
import pytest

from analytics_platform import Client, JobFailedError, NotFoundError, RateLimitError, ServerError, ValidationError, verify_webhook_signature
from analytics_platform import client as client_mod
from analytics_platform.cli import run as cli_run

BACKEND = Path(__file__).resolve().parents[3] / "backend"


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(client_mod.time, "sleep", lambda s: None)


def mock_client(handler, **kw) -> Client:
    return Client("https://api.test", http=httpx.Client(transport=httpx.MockTransport(handler)), **kw)


def test_api_key_header_and_error_mapping():
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        if req.url.path == "/v1/datasets/nope":
            return httpx.Response(404, json={"detail": "dataset not found"})
        if req.url.path == "/v1/endpoints/x/predict":
            return httpx.Response(422, json={"detail": {"code": "bad", "message": "missing features"}})
        return httpx.Response(200, json=[])

    c = mock_client(handler, api_key="ap_live_x")
    assert c.datasets.list() == []
    assert seen[0].headers["x-api-key"] == "ap_live_x"
    with pytest.raises(NotFoundError) as exc:
        c.datasets.get("nope")
    assert exc.value.status == 404
    with pytest.raises(ValidationError) as exc:
        c.endpoints.predict("x", {"a": 1})
    assert exc.value.code == "bad" and json.loads(seen[-1].content) == {"instances": [{"a": 1}], "explain": False}


def test_retries_respect_idempotency():
    calls = {"predict": 0, "upload": 0, "list": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/predict"):
            calls["predict"] += 1
            return httpx.Response(500 if calls["predict"] < 3 else 200, json={"predictions": [1]})
        if req.url.path == "/v1/datasets/upload":
            calls["upload"] += 1
            return httpx.Response(500, json={"detail": "boom"})
        calls["list"] += 1
        return httpx.Response(429, headers={"Retry-After": "1"}, json={"detail": "slow down"})

    c = mock_client(handler, api_key="k", max_retries=3)
    assert c.endpoints.predict("m", [{}])["predictions"] == [1] and calls["predict"] == 3
    with pytest.raises(ServerError):
        c.datasets.upload(b"a,b\n1,2", "x.csv")
    assert calls["upload"] == 1  # never retried: each upload creates a dataset
    with pytest.raises(RateLimitError) as exc:
        c.jobs.list()
    assert calls["list"] == 4 and exc.value.retry_after == 1.0


def test_token_refresh_rotates_once():
    state = {"access": "a1", "refresh": "r1", "refresh_calls": 0}
    saved = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/v1/auth/refresh":
            state["refresh_calls"] += 1
            body = json.loads(req.content)
            if body["refresh_token"] != state["refresh"]:
                return httpx.Response(401, json={"detail": {"code": "token_reuse"}})
            state["access"], state["refresh"] = "a2", "r2"
            return httpx.Response(200, json={"access_token": "a2", "refresh_token": "r2", "expires_in": 900})
        if req.headers.get("authorization") != f"Bearer {state['access']}":
            return httpx.Response(401, json={"detail": {"code": "expired"}})
        return httpx.Response(200, json={"id": "u1"})

    c = mock_client(handler, api_key="", access_token="stale", refresh_token="r1", on_tokens=saved.append)
    assert c.auth.me() == {"id": "u1"}
    assert state["refresh_calls"] == 1 and c.refresh_token == "r2" and saved[0]["access_token"] == "a2"


def test_jobs_wait():
    statuses = iter(["queued", "running", "succeeded"])

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": "j", "status": next(statuses), "progress": 0.5})

    progress = []
    assert mock_client(handler, api_key="k").jobs.wait("j", on_progress=progress.append)["status"] == "succeeded"
    assert len(progress) == 3
    failing = mock_client(lambda r: httpx.Response(200, json={"id": "j", "status": "failed", "error": "bad data"}), api_key="k")
    with pytest.raises(JobFailedError, match="bad data"):
        failing.jobs.wait("j")


def test_webhook_signature():
    body = b'{"event":"x"}'
    ts = int(time.time())
    header = f"t={ts},v1=" + hmac.new(b"whsec_1", f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    assert verify_webhook_signature("whsec_1", body, header)
    assert not verify_webhook_signature("whsec_2", body, header)
    assert not verify_webhook_signature("whsec_1", body + b" ", header)
    old = f"t={ts - 3600},v1=" + hmac.new(b"whsec_1", f"{ts - 3600}.".encode() + body, hashlib.sha256).hexdigest()
    assert not verify_webhook_signature("whsec_1", body, old)


# -- end to end against the real backend ---------------------------------------------------------


@pytest.mark.skipif(not (BACKEND / "app").exists(), reason="backend source not available")
def test_end_to_end_journey(tmp_path, monkeypatch, capsys):
    sys.path.insert(0, str(BACKEND))
    for var in ("AP_CLOUD_PROVIDER", "AP_DATABASE_URL", "AP_DEV_AUTH"):
        monkeypatch.delenv(var, raising=False)
    # The in-process app would otherwise write JSON access logs to the stdout the CLI assertions capture.
    monkeypatch.setenv("AP_JSON_LOGS", "0")
    from fastapi.testclient import TestClient

    from app.api.deps import build_state
    from app.jobs.core import Worker
    from app.main import create_app

    state = build_state(data_dir=tmp_path / "data", cloud_provider="local", database_url=None, inline_worker=False, dev_auth=False)
    http = TestClient(create_app(state), base_url="http://testserver")
    worker = Worker(state, wait_seconds=0)

    class DrainingClient(Client):
        """Runs queued jobs before every request, standing in for the worker deployment."""

        def request(self, method, path, **kw):
            worker.drain()
            return super().request(method, path, **kw)

    ap = DrainingClient("http://testserver", api_key="", http=http)
    ap.auth.signup("acme", "Acme", "ada@acme.example", "Correct-Horse-9-Battery")
    ap.auth.login("ada@acme.example", "Correct-Horse-9-Battery")
    assert ap.auth.me()["role"] == "admin"

    import numpy as np
    import pandas as pd

    rng = np.random.default_rng(0)
    n = 300
    frame = pd.DataFrame(
        {"age": rng.integers(18, 80, n), "income": rng.normal(50, 15, n).round(2), "plan": rng.choice(["basic", "pro"], n)}
    )
    frame["churn"] = np.where(frame.income + rng.normal(0, 5, n) > 50, "yes", "no")
    frame.loc[::17, "income"] = None
    dataset = ap.datasets.upload(frame.to_csv(index=False).encode(), "churn.csv")["dataset"]
    pipeline = ap.pipelines.create(dataset["id"], "clean", [{"op": "fill_missing", "columns": ["income"], "strategy": "median"}])
    applied = ap.pipelines.apply(pipeline["id"], wait=True)
    assert applied["result"]["version"] == 2
    assert ap.datasets.query(dataset["id"], "SELECT count(*) FROM data WHERE income IS NULL")["rows"] == [[0]]

    exp = ap.experiments.create(
        "churn", dataset["id"], "churn", wait=True, algorithms=["logistic_regression"], automl={"enabled": False}, cv={"folds": 2}
    )
    best = ap.experiments.best_run(exp["experiment"]["id"])
    assert best["metrics"]["roc_auc"] > 0.8
    model = ap.models.register("churn", best["id"])
    ap.models.set_stage(model["model_id"], 1, "production")
    ap.endpoints.deploy("churn-prod", model["model_id"])
    key = ap.tenant.create_api_key("app", role="analyst", scopes=["endpoints.predict"])["key"]

    scoped = DrainingClient("http://testserver", api_key=key, http=http)
    out = scoped.endpoints.predict("churn-prod", {"age": 40, "income": 90, "plan": "pro"})
    assert out["predictions"] == ["yes"]
    batch = scoped.endpoints.batch("churn-prod", file=frame.drop(columns=["churn"]).head(10).to_csv(index=False).encode(), wait=True)
    assert len(pd.read_csv(io.BytesIO(batch))) == 10

    # CLI, reusing the same in-process transport
    code = cli_run(["endpoints", "predict", "churn-prod", '[{"age": 30, "income": 10, "plan": "basic"}]'], client=scoped)
    assert code == 0 and json.loads(capsys.readouterr().out)["predictions"] == ["no"]
    assert cli_run(["datasets", "list"], client=scoped) == 1  # scoped key can't read datasets
    assert "403" in capsys.readouterr().err
