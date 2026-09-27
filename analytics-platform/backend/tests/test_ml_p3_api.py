"""Phase 3 ML & serving API end to end: anomaly detection endpoints (TRN-008, MDL-002b), fairness (XAI-004), text
features and projections (FE-006, FE-005a), custom ONNX uploads (TRN-010), canary rollouts (API-009), SSE / WebSocket
streaming (API-006), GraphQL (API-003) and gRPC (API-004)."""

from __future__ import annotations

import json
import pickle

import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api.deps import build_state
from app.jobs.core import Worker
from app.main import create_app

from .test_ml_p1 import monthly_sales
from .test_ml_p3 import SIG, _onnx_logreg, reviews, transactions
from .test_training import churn_frame

H = {"X-Tenant-ID": "acme", "X-User-ID": "ds"}
FAST = {"automl": {"enabled": False}, "cv": {"folds": 2}}


def _upload(c: TestClient, name: str, frame) -> str:
    r = c.post("/v1/datasets", files={"file": (name, frame.to_csv(index=False).encode())}, headers=H)
    assert r.status_code in (200, 201), r.text
    return r.json()["dataset"]["id"]


def _train(c: TestClient, state, body: dict) -> list[dict]:
    r = c.post("/v1/experiments", json=body, headers=H)
    assert r.status_code == 202, r.text
    Worker(state, wait_seconds=0).drain()
    detail = c.get(f"/v1/experiments/{r.json()['experiment']['id']}", headers=H).json()
    assert detail["job"]["status"] == "succeeded", detail["job"]["error"]
    return detail["runs"]


def _deploy(c: TestClient, name: str, run_id: str, model: str | None = None) -> dict:
    reg = c.post("/v1/models", json={"name": model or name, "run_id": run_id}, headers=H).json()
    r = c.post("/v1/endpoints", json={"name": name, "model_id": reg["model_id"], "version": reg["version"]}, headers=H)
    assert r.status_code == 201, r.text
    return reg


def _events(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        out.append((lines["event"], json.loads(lines["data"])))
    return out


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("mlp3")
    state = build_state(data_dir=tmp, dev_auth=True, cloud_provider="local", database_url=None, inline_worker=False)
    scheduled: list[tuple[str, dict, float]] = []
    state.extras["canary_scheduler"] = lambda tenant, params, delay: scheduled.append((tenant, params, delay))
    client = TestClient(create_app(state))
    frame = churn_frame(300)
    churn = _upload(client, "churn.csv", frame)
    runs = _train(
        client,
        state,
        {
            "name": "churn",
            "dataset_id": churn,
            "target": "churn",
            "features": ["age", "income"],
            "algorithms": ["logistic_regression"],
            **FAST,
        },
    )
    reg = _deploy(client, "churn", runs[0]["id"])
    return {
        "state": state,
        "client": client,
        "frame": frame,
        "churn": churn,
        "churn_run": runs[0]["id"],
        "churn_model": reg,
        "scheduled": scheduled,
    }


def _api_key(c: TestClient, role: str = "data_scientist", **extra) -> str:
    r = c.post("/v1/tenant/api-keys", json={"name": f"k-{role}", "role": role, **extra}, headers=H)
    assert r.status_code == 201, r.text
    return r.json()["key"]


# -- anomaly detection ----------------------------------------------------------------------------------------------------


def test_anomaly_experiment_endpoint_batch_and_refusals(env):
    c, state = env["client"], env["state"]
    df = transactions()
    ds = _upload(c, "tx.csv", df)
    detected = c.post("/v1/experiments/detect", json={"dataset_id": ds, "target": "label"}, headers=H).json()
    assert detected["problem_type"] == "binary"
    alt = next(a for a in detected["alternatives"] if a["problem_type"] == "anomaly")
    assert alt["positive_label"] == "fraud" and alt["label_column"] == "label"
    no_target = c.post("/v1/experiments/detect", json={"dataset_id": ds}, headers=H).json()
    assert no_target["problem_type"] == "clustering" and no_target["alternatives"][0]["problem_type"] == "anomaly"
    assert "isolation_forest" in {a["id"] for a in c.get("/v1/algorithms", headers=H).json()}

    runs = _train(
        c,
        state,
        {
            "name": "fraud",
            "dataset_id": ds,
            "problem_type": "anomaly",
            "target": "label",
            "algorithms": ["isolation_forest", "lof"],
            **FAST,
        },
    )
    best = c.get(f"/v1/runs/{next(r for r in runs if r['artifacts']['is_best'])['id']}", headers=H).json()
    assert best["metrics"]["problem_type"] == "anomaly" and best["metrics"]["roc_auc"] > 0.9
    assert "score_distribution" in best["artifacts"]
    _deploy(c, "fraud", best["id"])
    pred = c.post(
        "/v1/endpoints/fraud/predict",
        json={
            "instances": [
                {"amount": 6, "velocity": 5, "distance": 6, "channel": "web"},
                {"amount": 0, "velocity": 0, "distance": 0, "channel": "app"},
            ]
        },
        headers=H,
    )
    assert pred.status_code == 200, pred.text
    p = pred.json()["predictions"]
    assert p[0]["is_anomaly"] is True and p[1]["is_anomaly"] is False and "threshold" in pred.json()
    assert c.post("/v1/endpoints/fraud/predict", json={"instances": [{"amount": 0}], "explain": True}, headers=H).status_code == 422
    refused = c.get(f"/v1/runs/{best['id']}/onnx", headers=H)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "onnx_unsupported"
    spec = c.get("/v1/endpoints/fraud/openapi.json", headers=H).json()
    assert spec["components"]["schemas"]["PredictResponse"]["properties"]["predictions"]["items"]["type"] == "object"
    drift = c.get("/v1/endpoints/fraud/drift", headers=H).json()
    assert drift["status"] == "insufficient_data" and drift["by_version"]["1"]["prediction"]["bins"][:2] == ["False", "True"]
    job = c.post("/v1/endpoints/fraud/batch", json={"dataset_id": ds}, headers=H).json()
    Worker(state, wait_seconds=0).drain()
    csv = c.get(f"/v1/endpoints/fraud/batch/{job['id']}", headers=H).text
    assert csv.splitlines()[0].endswith("is_anomaly,anomaly_score")


# -- fairness (XAI-004) -------------------------------------------------------------------------------------------------


def test_fairness_on_features_and_non_feature_columns(env):
    c = env["client"]
    run_id = env["churn_run"]
    r = c.post(f"/v1/runs/{run_id}/fairness", json={"protected": ["plan", "age"], "positive_class": "yes"}, headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["positive_class"] == "yes" and body["n_test"] == 60
    plan, age = body["attributes"]
    assert plan["attribute"] == "plan" and {g["group"] for g in plan["groups"]} == {"basic", "pro", "enterprise"}  # not a feature
    assert age["grouping"] == "quartiles" and len(age["groups"]) == 4
    for rep in body["attributes"]:
        assert {"demographic_parity_difference", "demographic_parity_ratio", "equalized_odds_difference", "four_fifths_rule"} <= set(rep)
        assert sum(g["n"] for g in rep["groups"]) == 60
        assert all({"selection_rate", "tpr", "fpr", "precision"} <= set(g) for g in rep["groups"])
    # customer_id (> 50 distinct non-numeric? no: numeric) and signup (high-cardinality string) → read back from the dataset
    signup = c.post(f"/v1/runs/{run_id}/fairness", json={"protected": ["signup"]}, headers=H)
    assert signup.status_code == 200 and signup.json()["positive_class"] == "yes"
    assert c.post(f"/v1/runs/{run_id}/fairness", json={"protected": ["nope"]}, headers=H).status_code == 422
    assert c.post(f"/v1/runs/{run_id}/fairness", json={"protected": ["plan"], "positive_class": "maybe"}, headers=H).status_code == 422
    assert c.post(f"/v1/runs/{run_id}/fairness", json={"protected": ["churn"]}, headers=H).status_code == 422
    assert c.post("/v1/runs/run_missing/fairness", json={"protected": ["plan"]}, headers=H).status_code == 404
    other = {"X-Tenant-ID": "other", "X-User-ID": "x"}
    assert c.post(f"/v1/runs/{run_id}/fairness", json={"protected": ["plan"]}, headers=other).status_code == 404


# -- text features and projections (FE-006, FE-005a) ---------------------------------------------------------------------


def test_text_features_and_projections(env):
    c, state = env["client"], env["state"]
    ds = _upload(c, "reviews.csv", reviews())
    runs = _train(
        c,
        state,
        {
            "name": "sentiment",
            "dataset_id": ds,
            "target": "sentiment",
            "algorithms": ["logistic_regression"],
            "preprocessing": {"text": {"method": "tfidf", "max_features": 50, "svd_components": 5}},
            **FAST,
        },
    )
    run = c.get(f"/v1/runs/{runs[0]['id']}", headers=H).json()
    assert run["metrics"]["f1"] > 0.9 and run["artifacts"]["shap_summary"][0]["feature"] == "review"
    out = c.post(
        f"/v1/runs/{run['id']}/explain",
        json={"instances": [{"review": "great product love it", "stars_hint": 0, "gender": "m"}]},
        headers=H,
    ).json()
    assert out["predictions"] == ["positive"] and "review" in out["shap"][0]

    proj = c.post(f"/v1/datasets/{ds}/projection", json={"method": "tsne", "sample": 60, "color_by": "sentiment"}, headers=H)
    assert proj.status_code == 200, proj.text
    assert proj.json()["n"] == 60 and len(proj.json()["color"]) == 60 and proj.json()["method"] == "tsne"
    rp = c.post(f"/v1/runs/{run['id']}/projection", json={"method": "pca", "sample": 50}, headers=H)
    assert rp.status_code == 200, rp.text
    assert len(rp.json()["x"]) == 50 and set(rp.json()["color"]) <= {"positive", "negative"} and len(rp.json()["actual"]) == 50
    assert c.post(f"/v1/datasets/{ds}/projection", json={"sample": 5000, "features": ["nope"]}, headers=H).status_code == 422
    assert c.post(f"/v1/datasets/{ds}/projection", json={"sample": 50000}, headers=H).status_code == 422


# -- custom model upload (TRN-010, SEC-010) -------------------------------------------------------------------------------


def test_upload_onnx_model_register_serve_explain(env, monkeypatch):
    c = env["client"]
    blob = _onnx_logreg()
    files = {"file": ("model.onnx", blob, "application/octet-stream")}
    r = c.post("/v1/models/upload", files=files, data={"name": "uploaded-lr", "signature": json.dumps(SIG)}, headers=H)
    assert r.status_code == 201, r.text
    up = r.json()
    assert up["version"] == 1 and up["input_mode"] == "tensor" and len(up["sha256"]) == 64
    model = c.get(f"/v1/models/{up['model_id']}", headers=H).json()
    assert model["versions"][0]["algorithm"] == "onnx_upload" and model["versions"][0]["signature"]["source"] == "upload"
    assert c.post("/v1/endpoints", json={"name": "uploaded", "model_id": up["model_id"]}, headers=H).status_code == 201
    pred = c.post("/v1/endpoints/uploaded/predict", json={"instances": [{"a": 2.5, "b": 0}, {"a": -2.5, "b": 0}]}, headers=H).json()
    assert pred["predictions"] == ["yes", "no"] and len(pred["probabilities"][0]) == 2
    exp = c.post("/v1/endpoints/uploaded/predict", json={"instances": [{"a": 2.5, "b": 0}], "explain": True}, headers=H)
    assert exp.status_code == 200, exp.text
    shap_row = exp.json()["shap"][0]
    assert abs(shap_row["a"]) > abs(shap_row["b"])
    onnx_back = c.get(f"/v1/runs/{up['run_id']}/onnx", headers=H)
    assert onnx_back.status_code == 200 and onnx_back.content == blob
    # a second upload with a reference dataset becomes version 2
    import pandas as pd

    ref = pd.DataFrame({"a": np.linspace(-2, 2, 40), "b": np.linspace(0, 1, 40)})
    ref_id = _upload(c, "ref.csv", ref)
    files = {"file": ("model.onnx", _onnx_logreg(), "application/octet-stream")}
    v2 = c.post(
        "/v1/models/upload", files=files, data={"name": "uploaded-lr", "signature": json.dumps(SIG), "dataset_id": ref_id}, headers=H
    )
    assert v2.status_code == 201 and v2.json()["version"] == 2 and v2.json()["reference_dataset_id"] == ref_id

    bad = [
        (pickle.dumps({"weights": [1, 2]}), SIG, 422, "pickle"),
        (b"garbage", SIG, 422, "not a valid ONNX"),
        (_onnx_logreg(3), SIG, 422, "3 columns"),
        (_onnx_logreg(), {**SIG, "classes": ["a", "b", "c"]}, 422, None),
    ]
    for data, sig, status, needle in bad:
        files = {"file": ("m.onnx", data, "application/octet-stream")}
        resp = c.post("/v1/models/upload", files=files, data={"name": "bad", "signature": json.dumps(sig)}, headers=H)
        assert resp.status_code == status, resp.text
        if needle:
            assert needle in json.dumps(resp.json())
    files = {"file": ("m.onnx", _onnx_logreg(), "application/octet-stream")}
    assert c.post("/v1/models/upload", files=files, data={"name": "bad", "signature": "{"}, headers=H).status_code == 422
    import app.api.training as training_api

    monkeypatch.setattr(training_api, "MAX_UPLOAD_BYTES", 100)
    files = {"file": ("m.onnx", _onnx_logreg(), "application/octet-stream")}
    assert c.post("/v1/models/upload", files=files, data={"name": "big", "signature": json.dumps(SIG)}, headers=H).status_code == 413
    viewer = _api_key(c, "viewer")
    files = {"file": ("m.onnx", _onnx_logreg(), "application/octet-stream")}
    denied = c.post("/v1/models/upload", files=files, data={"name": "v", "signature": json.dumps(SIG)}, headers={"X-API-Key": viewer})
    assert denied.status_code == 403


# -- canary rollouts (API-009) -------------------------------------------------------------------------------------------


def test_canary_ramp_complete_rollback_and_manual_controls(env):
    c, state, frame, scheduled = env["client"], env["state"], env["frame"], env["scheduled"]
    runs = _train(
        c,
        state,
        {
            "name": "churn-v2",
            "dataset_id": env["churn"],
            "target": "churn",
            "features": ["age", "income"],
            "algorithms": ["decision_tree"],
            **FAST,
        },
    )
    v2 = c.post("/v1/models", json={"name": "churn", "run_id": runs[0]["id"]}, headers=H).json()
    v1 = env["churn_model"]
    assert c.post("/v1/endpoints", json={"name": "canary", "model_id": v1["model_id"], "version": 1}, headers=H).status_code == 201
    body = {"model_version_id": v2["model_version_id"], "steps": [50, 100], "step_minutes": 0, "min_requests": 3, "max_error_rate": 0.1}
    started = c.post("/v1/endpoints/canary/canary", json=body, headers=H)
    assert started.status_code == 201, started.text
    assert started.json()["weight"] == 50 and scheduled[-1][1]["canary_id"] == started.json()["id"] and scheduled[-1][2] == 0
    ep = c.get("/v1/endpoints/canary", headers=H).json()
    assert sorted(r["weight"] for r in ep["routes"]) == [50, 50]
    assert c.post("/v1/endpoints/canary/canary", json=body, headers=H).status_code == 409
    assert (
        c.patch(
            "/v1/endpoints/canary", json={"routes": [{"model_version_id": v2["model_version_id"], "weight": 100}]}, headers=H
        ).status_code
        == 409
    )
    rows = frame[["age", "income"]].head(40).to_dict(orient="records")
    for row in rows:
        assert c.post("/v1/endpoints/canary/predict", json={"instances": [row]}, headers=H).status_code == 200
    status = c.get("/v1/endpoints/canary/canary", headers=H).json()
    assert status["live"]["canary"]["requests"] + status["live"]["baseline"]["requests"] == 40
    tick = c.post("/v1/endpoints/canary-steps", headers=H)
    assert tick.status_code == 202
    Worker(state, wait_seconds=0).drain()
    result = c.get(f"/v1/jobs/{tick.json()['id']}", headers=H).json()["result"]
    assert result["evaluated"][0]["action"] == "completed"
    done = c.get("/v1/endpoints/canary/canary", headers=H).json()
    assert done["status"] == "completed" and done["weight"] == 100
    assert c.get("/v1/endpoints/canary", headers=H).json()["routes"][0]["model_version_id"] == v2["model_version_id"]

    # A candidate that needs a feature callers don't send fails every request → automatic rollback + alert.
    runs = _train(
        c,
        state,
        {
            "name": "churn-v3",
            "dataset_id": env["churn"],
            "target": "churn",
            "features": ["age", "income", "plan"],
            "algorithms": ["logistic_regression"],
            **FAST,
        },
    )
    v3 = c.post("/v1/models", json={"name": "churn", "run_id": runs[0]["id"]}, headers=H).json()
    body = {"model_version_id": v3["model_version_id"], "steps": [50], "step_minutes": 0, "min_requests": 3, "max_error_rate": 0.1}
    canary = c.post("/v1/endpoints/canary/canary", json=body, headers=H).json()
    codes = [c.post("/v1/endpoints/canary/predict", json={"instances": [row]}, headers=H).status_code for row in rows]
    assert 422 in codes and 200 in codes
    params = scheduled[-1][1]  # the job re-enqueued itself through the scheduler hook; run it now
    assert params["canary_id"] == canary["id"]
    from app.jobs.core import JobService

    job = JobService(state).submit("acme", "serving.canary_step", params, "system")
    Worker(state, wait_seconds=0).drain()
    res = c.get(f"/v1/jobs/{job.id}", headers=H).json()["result"]
    assert res["action"] == "rolled_back" and res["status"] == "rolled_back"
    assert [r["model_version_id"] for r in c.get("/v1/endpoints/canary", headers=H).json()["routes"]] == [v2["model_version_id"]]
    notes = [n for n in c.get("/v1/notifications", headers=H).json() if n["kind"] == "endpoint.threshold"]
    assert notes and notes[0]["body"]["kind"] == "canary" and "error rate" in notes[0]["body"]["reason"]

    # manual abort / promote
    held = c.post("/v1/endpoints/canary/canary", json={**body, "steps": [10, 50]}, headers=H).json()
    from app.serving.canary import CanaryService

    assert CanaryService(state).evaluate("acme", held["id"])["action"] == "hold"  # no canary traffic yet
    assert scheduled[-1][2] > 55 and CanaryService(state).evaluate("acme", held["id"])["action"] == "deferred"
    aborted = c.post("/v1/endpoints/canary/canary/abort", headers=H).json()
    assert aborted["status"] == "aborted"
    assert c.post("/v1/endpoints/canary/canary/abort", headers=H).status_code == 409
    c.post("/v1/endpoints/canary/canary", json={**body, "steps": [10, 50]}, headers=H)
    promoted = c.post("/v1/endpoints/canary/canary/promote", headers=H).json()
    assert promoted["status"] == "completed" and promoted["weight"] == 100
    assert c.get("/v1/endpoints/canary", headers=H).json()["routes"] == [{**promoted["candidate"], "run_id": runs[0]["id"], "weight": 100}]
    actions = {a["action"] for a in c.get("/v1/tenant/audit", headers=H).json()}
    assert {"endpoint.canary.start", "endpoint.canary.complete", "endpoint.canary.rollback", "endpoint.canary.abort"} <= actions


# -- streaming (API-006) ------------------------------------------------------------------------------------------------------


def test_sse_streaming_chunks_and_forecast_steps(env):
    c, state, frame = env["client"], env["state"], env["frame"]
    rows = frame[["age", "income"]].head(25).to_dict(orient="records")
    r = c.post("/v1/endpoints/churn/predict/stream", json={"instances": rows, "chunk_size": 10}, headers=H)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    events = _events(r.text)
    assert [e for e, _ in events] == ["start", "prediction", "prediction", "prediction", "done"]
    assert [d["offset"] for e, d in events if e == "prediction"] == [0, 10, 20]
    assert sum(len(d["predictions"]) for e, d in events if e == "prediction") == 25
    one = _events(c.post("/v1/endpoints/churn/predict/stream", json={"instances": rows[:3], "chunk_size": 1}, headers=H).text)
    assert len([e for e, _ in one if e == "prediction"]) == 3
    bad = _events(c.post("/v1/endpoints/churn/predict/stream", json={"instances": [{"age": 1}]}, headers=H).text)
    assert bad[-1][0] == "error" and bad[-1][1]["status"] == 422
    assert c.post("/v1/endpoints/nope/predict/stream", json={"instances": rows}, headers=H).status_code == 404

    sales = _upload(c, "sales.csv", monthly_sales())
    runs = _train(
        c,
        state,
        {
            "name": "sales",
            "dataset_id": sales,
            "problem_type": "forecasting",
            "target": "sales",
            "algorithms": ["seasonal_naive"],
            "forecast": {"time_column": "month", "horizon": 3, "backtest_folds": 2},
            **FAST,
        },
    )
    _deploy(c, "sales-stream", runs[0]["id"])
    fc = _events(c.post("/v1/endpoints/sales-stream/predict/stream", json={"horizon": 5}, headers=H).text)
    steps = [d for e, d in fc if e == "forecast"]
    assert [s["step"] for s in steps] == [1, 2, 3, 4, 5] and fc[-1][0] == "done" and steps[0]["timestamp"].startswith("2023-01")


def test_websocket_token_and_first_message_auth(env):
    c, frame = env["client"], env["frame"]
    row = frame[["age", "income"]].iloc[0].to_dict()
    tok = c.post("/v1/endpoints/churn/stream-token", headers=H).json()
    assert tok["expires_in"] == 60
    with c.websocket_connect(f"/v1/endpoints/churn/ws?token={tok['token']}") as ws:
        assert ws.receive_json()["type"] == "ready"
        ws.send_text(json.dumps({"id": "r1", "instances": [row]}))
        msg = ws.receive_json()
        assert msg["id"] == "r1" and msg["predictions"][0] in ("yes", "no")
        ws.send_text(json.dumps({"id": "r2", "instances": [{"age": 3}]}))
        assert ws.receive_json()["error"]["status"] == 422
        ws.send_text("not json")
        assert ws.receive_json()["error"]["status"] == 422
    # single use
    with c.websocket_connect(f"/v1/endpoints/churn/ws?token={tok['token']}") as ws:
        assert ws.receive_json()["error"]["status"] == 401
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
        assert closed.value.code == 4401
    other = c.post("/v1/endpoints/fraud/stream-token", headers=H)
    if other.status_code == 200:
        with c.websocket_connect(f"/v1/endpoints/churn/ws?token={other.json()['token']}") as ws:
            assert ws.receive_json()["error"]["status"] == 401

    key = _api_key(c, "analyst")
    with c.websocket_connect("/v1/endpoints/churn/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "api_key": key}))
        assert ws.receive_json()["type"] == "ready"
        ws.send_text(json.dumps({"instances": [row, row]}))
        assert len(ws.receive_json()["predictions"]) == 2
    viewer = _api_key(c, "viewer")
    with c.websocket_connect("/v1/endpoints/churn/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "api_key": viewer}))
        assert ws.receive_json()["error"]["status"] == 403
    with c.websocket_connect("/v1/endpoints/churn/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "api_key": "ap_live_000000000000_" + "x" * 40}))
        assert ws.receive_json()["error"]["status"] == 401
    limited = _api_key(c, "analyst", rate_limit_per_minute=6)
    with c.websocket_connect("/v1/endpoints/churn/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "api_key": limited}))
        ws.receive_json()
        statuses = []
        for i in range(5):
            ws.send_text(json.dumps({"id": i, "instances": [row]}))
            statuses.append(ws.receive_json().get("error", {}).get("status", 200))
        assert 429 in statuses and statuses[0] == 200


# -- GraphQL (API-003) and gRPC (API-004) ----------------------------------------------------------------------------------


def test_graphql_queries_rbac_and_predict(env):
    c, frame = env["client"], env["frame"]
    query = (
        "{ datasets { id name columns } models { name versions { version algorithm } } endpoints { name status routes } dashboards { id } }"
    )
    r = c.post("/graphql", json={"query": query}, headers=H)
    assert r.status_code == 200 and "errors" not in r.json(), r.text
    data = r.json()["data"]
    assert env["churn"] in {d["id"] for d in data["datasets"]}
    assert "churn" in {m["name"] for m in data["models"]} and "churn" in {e["name"] for e in data["endpoints"]}
    exp = c.post(
        "/graphql", json={"query": "{ experiments(limit: 2) { id datasetId runs { id algorithm metrics isBest } } }"}, headers=H
    ).json()
    assert exp["data"]["experiments"][0]["runs"][0]["metrics"]
    run = c.post("/graphql", json={"query": f'{{ run(id: "{env["churn_run"]}") {{ id status }} }}'}, headers=H).json()
    assert run["data"]["run"]["status"] == "succeeded"
    row = frame[["age", "income"]].iloc[0].to_dict()
    mutation = {"query": 'mutation($i: [JSON!]) { predict(endpoint: "churn", instances: $i) }', "variables": {"i": [row]}}
    pred = c.post("/graphql", json=mutation, headers=H).json()
    assert pred["data"]["predict"]["predictions"][0] in ("yes", "no")
    assert c.post("/graphql", json={"query": query}).status_code == 401
    other = c.post(
        "/graphql", json={"query": "{ datasets { id } models { id } }"}, headers={"X-Tenant-ID": "other", "X-User-ID": "o"}
    ).json()
    assert other["data"] == {"datasets": [], "models": []}
    viewer = _api_key(c, "viewer")
    denied = c.post("/graphql", json=mutation, headers={"X-API-Key": viewer}).json()
    assert denied["data"] is None and "endpoints.predict" in denied["errors"][0]["message"]
    readable = c.post("/graphql", json={"query": "{ endpoints { name } }"}, headers={"X-API-Key": viewer}).json()
    assert "errors" not in readable


def test_grpc_predict_with_api_key(env):
    grpc = pytest.importorskip("grpc")
    from google.protobuf import struct_pb2

    from app.serving.grpc_server import build_server

    c, state, frame = env["client"], env["state"], env["frame"]
    server, port = build_server(state, 0, workers=2, host="127.0.0.1")
    server.start()
    try:
        channel = grpc.insecure_channel(f"127.0.0.1:{port}")
        call = channel.unary_unary(
            "/ap.v1.Predictor/Predict",
            request_serializer=struct_pb2.Struct.SerializeToString,
            response_deserializer=struct_pb2.Struct.FromString,
        )
        req = struct_pb2.Struct()
        req.update({"endpoint": "churn", "instances": [frame[["age", "income"]].iloc[0].to_dict()]})
        key = _api_key(c, "analyst")
        resp = call(req, metadata=[("x-api-key", key)], timeout=30)
        assert resp["predictions"][0] in ("yes", "no")
        with pytest.raises(grpc.RpcError) as err:
            call(req, timeout=30)
        assert err.value.code() == grpc.StatusCode.UNAUTHENTICATED
        with pytest.raises(grpc.RpcError) as err:
            call(req, metadata=[("x-api-key", _api_key(c, "viewer"))], timeout=30)
        assert err.value.code() == grpc.StatusCode.PERMISSION_DENIED
        missing = struct_pb2.Struct()
        missing.update({"endpoint": "nope", "instances": [{"age": 1}]})
        with pytest.raises(grpc.RpcError) as err:
            call(missing, metadata=[("x-api-key", key)], timeout=30)
        assert err.value.code() == grpc.StatusCode.NOT_FOUND
        channel.close()
    finally:
        server.stop(0)
