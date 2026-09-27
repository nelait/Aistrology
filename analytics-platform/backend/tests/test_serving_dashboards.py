from __future__ import annotations

import io
import json

import httpx
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.analytics.saved import literal, where_clause
from app.analytics.sql_sandbox import UnsafeQueryError
from app.api.deps import build_state
from app.jobs.core import Worker
from app.main import create_app
from app.webhooks import WebhookDispatcher, WebhookError, check_url, verify_signature

from .test_training import churn_frame

H = {"X-Tenant-ID": "acme", "X-User-ID": "ds"}
FAST = {"automl": {"enabled": False}, "cv": {"folds": 2}}
PASSWORD = "Correct-Horse-9-Battery"


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    """One trained, registered and deployed model shared by the tests in this module."""
    tmp = tmp_path_factory.mktemp("serving")
    state = build_state(data_dir=tmp, dev_auth=True, cloud_provider="local", database_url=None, inline_worker=False)
    client = TestClient(create_app(state))
    frame = churn_frame(300)
    ds = client.post("/v1/datasets", files={"file": ("churn.csv", frame.to_csv(index=False).encode())}, headers=H).json()["dataset"]["id"]
    exp = client.post(
        "/v1/experiments",
        json={
            "name": "e",
            "dataset_id": ds,
            "target": "churn",
            "features": ["age", "income", "plan"],
            "algorithms": ["logistic_regression", "decision_tree"],
            **FAST,
        },
        headers=H,
    ).json()
    Worker(state, wait_seconds=0).drain()
    runs = client.get(f"/v1/experiments/{exp['experiment']['id']}", headers=H).json()["runs"]
    v1 = client.post("/v1/models", json={"name": "churn", "run_id": runs[0]["id"]}, headers=H).json()
    v2 = client.post("/v1/models", json={"name": "churn", "run_id": runs[1]["id"]}, headers=H).json()
    client.post(f"/v1/models/{v1['model_id']}/versions/1/stage", json={"stage": "production"}, headers=H)
    return {"state": state, "client": client, "dataset": ds, "v1": v1, "v2": v2, "frame": frame}


INSTANCE = {"age": 45, "income": 60.5, "plan": "pro"}


def test_deploy_predict_with_scoped_api_key(env):
    c = env["client"]
    r = c.post(
        "/v1/endpoints",
        json={"name": "churn-prod", "model_id": env["v1"]["model_id"], "cors_origins": ["https://app.acme.example"]},
        headers=H,
    )
    assert r.status_code == 201, r.text
    assert r.json()["routes"][0]["version"] == 1  # production version by default
    # viewers have no PREDICT permission, so use an analyst key narrowed to predict only
    key = c.post("/v1/tenant/api-keys", json={"name": "mobile", "role": "analyst", "scopes": ["endpoints.predict"]}, headers=H).json()[
        "key"
    ]
    pred = c.post("/v1/endpoints/churn-prod/predict", json={"instances": [INSTANCE, {**INSTANCE, "age": 70}]}, headers={"X-API-Key": key})
    assert pred.status_code == 200, pred.text
    body = pred.json()
    assert len(body["predictions"]) == 2 and body["classes"] == ["no", "yes"] and len(body["probabilities"][0]) == 2
    assert body["model_version"]["version"] == 1
    # the scoped key can't read datasets
    assert c.get("/v1/datasets", headers={"X-API-Key": key}).status_code == 403
    explained = c.post("/v1/endpoints/churn-prod/predict", json={"instances": [INSTANCE], "explain": True}, headers=H).json()
    assert set(explained["shap"][0]) >= {"age", "income", "plan"}
    bad = c.post("/v1/endpoints/churn-prod/predict", json={"instances": [{"plan": "pro"}]}, headers=H)
    assert bad.status_code == 422 and "missing features" in bad.json()["detail"]
    metrics = c.get("/v1/endpoints/churn-prod/metrics", headers=H).json()
    assert metrics["requests"] >= 3 and metrics["errors"] >= 1 and metrics["p95_ms"] > 0
    spec = c.get("/v1/endpoints/churn-prod/openapi.json", headers=H).json()
    assert spec["components"]["schemas"]["Instance"]["properties"]["plan"]["enum"] == ["basic", "enterprise", "pro"]
    # CORS: per-endpoint origin allowed for predict only
    pre = c.options(
        "/v1/endpoints/churn-prod/predict", headers={"Origin": "https://app.acme.example", "Access-Control-Request-Method": "POST"}
    )
    assert pre.status_code == 204 and pre.headers["access-control-allow-origin"] == "https://app.acme.example"
    assert (
        c.options(
            "/v1/endpoints/churn-prod/predict", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"}
        ).status_code
        == 403
    )


def test_ab_routing_and_batch(env):
    c, state = env["client"], env["state"]
    routes = [
        {"model_version_id": env["v1"]["model_version_id"], "weight": 50},
        {"model_version_id": env["v2"]["model_version_id"], "weight": 50},
    ]
    assert (
        c.post("/v1/endpoints", json={"name": "churn-ab", "routes": [{**routes[0], "weight": 60}, routes[1]]}, headers=H).status_code == 422
    )
    assert c.post("/v1/endpoints", json={"name": "churn-ab", "routes": routes}, headers=H).status_code == 201
    versions = {
        c.post("/v1/endpoints/churn-ab/predict", json={"instances": [INSTANCE]}, headers=H).json()["model_version"]["version"]
        for _ in range(30)
    }
    assert versions == {1, 2}
    by_version = c.get("/v1/endpoints/churn-ab/metrics", headers=H).json()["by_version"]
    assert set(by_version) == {"1", "2"}
    # shift all traffic to v2
    patched = c.patch("/v1/endpoints/churn-ab", json={"routes": [{**routes[1], "weight": 100}]}, headers=H).json()
    assert [r["version"] for r in patched["routes"]] == [2]
    # batch from an uploaded CSV and from a dataset
    csv = env["frame"][["age", "income", "plan"]].head(25).to_csv(index=False).encode()
    job = c.post("/v1/endpoints/churn-ab/batch", files={"file": ("in.csv", csv)}, headers=H).json()
    job2 = c.post("/v1/endpoints/churn-ab/batch", json={"dataset_id": env["dataset"]}, headers=H).json()
    Worker(state, wait_seconds=0).drain()
    out = pd.read_csv(io.BytesIO(c.get(f"/v1/endpoints/churn-ab/batch/{job['id']}", headers=H).content))
    assert len(out) == 25 and {"prediction", "probability_yes"} <= set(out.columns)
    assert c.get(f"/v1/jobs/{job2['id']}", headers=H).json()["result"]["rows"] == 300
    assert c.post("/v1/endpoints/churn-ab/predict", json={"instances": [INSTANCE] * 1001}, headers=H).status_code == 422
    assert c.delete("/v1/endpoints/churn-ab", headers=H).status_code == 204
    assert c.post("/v1/endpoints/churn-ab/predict", json={"instances": [INSTANCE]}, headers=H).status_code == 404


def test_saved_analytics_with_parameters(env):
    c = env["client"]
    body = {
        "dataset_id": env["dataset"],
        "name": "churn by plan",
        "sql": "SELECT plan, count(*) AS n FROM data WHERE age >= :min_age GROUP BY plan ORDER BY plan",
        "chart": {"type": "bar", "x": "plan", "y": "n"},
        "parameters": [{"name": "min_age", "type": "number", "default": 18}],
    }
    a = c.post("/v1/analytics", json=body, headers=H).json()
    all_rows = c.post(f"/v1/analytics/{a['id']}/run", json={}, headers=H).json()["rows"]
    older = c.post(f"/v1/analytics/{a['id']}/run", json={"params": {"min_age": 60}}, headers=H).json()["rows"]
    assert sum(r[1] for r in all_rows) == 300 and sum(r[1] for r in older) < 300
    filtered = c.post(f"/v1/analytics/{a['id']}/run", json={"filters": {"plan": ["pro"]}}, headers=H).json()["rows"]
    assert [r[0] for r in filtered] == ["pro"]
    assert c.post(f"/v1/analytics/{a['id']}/run", json={"params": {"min_age": "1; DROP TABLE x"}}, headers=H).status_code == 422
    assert c.post("/v1/analytics", json={**body, "sql": "SELECT * FROM data WHERE age > :undeclared"}, headers=H).status_code == 422


def test_filter_literals_are_safe():
    assert literal("O'Brien") == "'O''Brien'"
    assert where_clause({"a": [1, "x'"], "b": {"min": 1, "max": 5}}, {"a", "b"}) == '"a" IN (1, \'x\'\'\') AND "b" >= 1 AND "b" <= 5'
    with pytest.raises(UnsafeQueryError):
        where_clause({"a; DROP": 1}, {"a"})
    with pytest.raises(UnsafeQueryError):
        literal({"nested": 1})


def test_dashboards_widgets_sharing_export_embed(env):
    c, ds = env["client"], env["dataset"]
    spec = {
        "pages": [
            {
                "id": "p1",
                "title": "Churn",
                "widgets": [
                    {
                        "id": "bar",
                        "type": "chart",
                        "title": "Income by plan",
                        "config": {"dataset_id": ds, "chart": {"type": "bar", "x": "plan", "y": "income", "aggregation": "avg"}},
                    },
                    {
                        "id": "kpi",
                        "type": "kpi",
                        "title": "Customers",
                        "config": {
                            "dataset_id": ds,
                            "kpi": {"value": "customer_id", "aggregation": "count", "trend": "signup", "grain": "month"},
                            "thresholds": [{"op": "<", "value": 100, "color": "red"}],
                        },
                    },
                    {
                        "id": "tbl",
                        "type": "table",
                        "config": {
                            "dataset_id": ds,
                            "columns": ["customer_id", "plan"],
                            "sort": {"column": "customer_id", "desc": True},
                            "page_size": 5,
                        },
                    },
                    {"id": "flt", "type": "filter", "config": {"dataset_id": ds, "filter": {"column": "plan", "kind": "multiselect"}}},
                    {"id": "txt", "type": "text", "config": {"text": "# Notes"}},
                ],
            }
        ],
        "filters": [{"id": "f", "column": "plan", "kind": "multiselect"}],
    }
    d = c.post("/v1/dashboards", json={"name": "Churn", "spec": spec}, headers=H).json()
    did = d["id"]
    bar = c.post(f"/v1/dashboards/{did}/widgets/bar/data", json={}, headers=H).json()
    assert [r[0] for r in bar["rows"]] == ["basic", "enterprise", "pro"]
    kpi = c.post(f"/v1/dashboards/{did}/widgets/kpi/data", json={"filters": {"plan": ["pro"]}}, headers=H).json()
    assert 0 < kpi["value"] < 300 and kpi["sparkline"] and kpi["status"] in ("red", "green")
    assert c.post(f"/v1/dashboards/{did}/widgets/kpi/data", json={"filters": {"plan": ["pro"]}}, headers=H).json()["cached"]
    tbl = c.post(f"/v1/dashboards/{did}/widgets/tbl/data", json={}, headers=H).json()
    assert tbl["columns"] == ["customer_id", "plan"] and tbl["rows"][0][0] == 300 and len(tbl["rows"]) == 5
    # a filter control ignores its own column's filter, so all options stay visible
    flt = c.post(f"/v1/dashboards/{did}/widgets/flt/data", json={"filters": {"plan": ["pro"]}}, headers=H).json()
    assert [r[0] for r in flt["rows"]] == ["basic", "enterprise", "pro"]
    assert c.post(f"/v1/dashboards/{did}/widgets/txt/data", json={}, headers=H).json()["static"]
    assert (
        c.post(f"/v1/dashboards/{did}/widgets/bar/data", json={"filters": {"plan": ["x'); DROP TABLE data; --"]}}, headers=H).status_code
        == 200
    )
    assert c.post(f"/v1/dashboards/{did}/widgets/nope/data", json={}, headers=H).status_code == 404

    # sharing: a tenant viewer sees nothing until shared, and can't edit
    admin = {**H}
    c.post("/v1/tenant/users", json={"email": "val@acme.example", "role": "viewer", "password": PASSWORD}, headers=admin)
    users = c.get("/v1/tenant/users", headers=admin).json()
    val = next(u for u in users if u["email"] == "val@acme.example")
    # dev-auth principals are admins, so use a real token for the viewer
    token = c.post("/v1/auth/login", json={"email": "val@acme.example", "password": PASSWORD})
    assert token.status_code == 200, token.text
    viewer = {"Authorization": f"Bearer {token.json()['access_token']}"}
    assert c.get(f"/v1/dashboards/{did}", headers=viewer).status_code == 404
    c.post(f"/v1/dashboards/{did}/share", json={"user_id": val["id"], "role": "editor"}, headers=admin)
    got = c.get(f"/v1/dashboards/{did}", headers=viewer).json()
    assert got["your_role"] == "viewer"  # viewers are capped at viewer
    assert c.put(f"/v1/dashboards/{did}", json={"name": "hacked"}, headers=viewer).status_code == 403

    clone = c.post(f"/v1/dashboards/{did}/clone", headers=H).json()
    assert clone["name"] == "Churn (copy)" and clone["id"] != did
    html = c.post(f"/v1/dashboards/{did}/export", json={}, headers=H)
    assert html.status_code == 200 and "echarts" in html.text and "Income by plan" in html.text
    emb = c.post(f"/v1/dashboards/{did}/embed-token", json={"ttl_minutes": 5}, headers=H).json()
    assert c.get(f"/v1/embed/{emb['token']}").json()["name"] == "Churn"
    assert c.post(f"/v1/embed/{emb['token']}/widgets/bar/data", json={}).status_code == 200
    assert c.get("/v1/embed/not-a-token").status_code == 403
    c.post(f"/v1/dashboards/{did}/archive", headers=H)
    assert did not in [x["id"] for x in c.get("/v1/dashboards", headers=H).json()]
    assert c.get(f"/v1/embed/{emb['token']}").status_code == 404  # archived dashboards aren't embeddable
    tpl = c.post(
        "/v1/dashboards/from-template",
        json={"template": "kpi-overview", "name": "T", "values": {"dataset_id": ds, "measure": "income", "dimension": "plan"}},
        headers=H,
    ).json()
    assert c.post(f"/v1/dashboards/{tpl['id']}/widgets/trend/data", json={}, headers=H).status_code == 200


def test_webhooks_signed_and_retried(env):
    state, c = env["state"], env["client"]
    received: list[httpx.Request] = []
    responses = iter([500, 200])

    def handler(request: httpx.Request) -> httpx.Response:
        received.append(request)
        return httpx.Response(next(responses, 200))

    state.extras["webhooks"] = WebhookDispatcher(state, allow_private=True, transport=httpx.MockTransport(handler))
    created = c.post("/v1/webhooks", json={"url": "https://hooks.acme.example/ap", "events": ["model.registered"]}, headers=H).json()
    secret = created["secret"]
    assert c.post("/v1/webhooks", json={"url": "http://insecure.example", "events": ["*"]}, headers=H).status_code == 422
    assert c.post("/v1/webhooks", json={"url": "https://x.example", "events": ["bogus"]}, headers=H).status_code == 422
    runs = c.get(f"/v1/experiments/{c.get('/v1/experiments', headers=H).json()[0]['id']}", headers=H).json()["runs"]
    c.post("/v1/models", json={"name": "other", "run_id": runs[0]["id"]}, headers=H)
    Worker(state, wait_seconds=0).drain()
    assert len(received) == 2  # first attempt got a 500 and was retried
    req = received[-1]
    assert verify_signature(secret, req.content, req.headers["X-AP-Signature"])
    assert not verify_signature("wrong", req.content, req.headers["X-AP-Signature"])
    assert json.loads(req.content)["event"] == "model.registered"
    deliveries = c.get(f"/v1/webhooks/{created['id']}/deliveries", headers=H).json()
    assert deliveries[0]["status"] == "delivered" and deliveries[0]["attempts"] == 2


def test_ssrf_guard():
    for url in ["https://127.0.0.1/x", "https://localhost/x", "https://169.254.169.254/latest", "https://10.0.0.1/"]:
        with pytest.raises(WebhookError):
            check_url(url)
