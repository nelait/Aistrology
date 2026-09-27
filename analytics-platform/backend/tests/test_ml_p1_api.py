"""API end to end for the Phase 2 ML features: templates (CFG-007), ONNX (MDL-NFR-004), explain output (XAI-002a),
clustering and forecasting endpoints (TRN-006/007), and drift monitoring with threshold notifications (API-011)."""

from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api.deps import build_state
from app.jobs.core import Worker
from app.main import create_app

from .test_ml_p1 import blobs, monthly_sales
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


def _best(runs: list[dict]) -> dict:
    return next(r for r in runs if r["artifacts"]["is_best"])


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("mlp1")
    state = build_state(data_dir=tmp, dev_auth=True, cloud_provider="local", database_url=None, inline_worker=False)
    client = TestClient(create_app(state))
    frame = churn_frame(300)
    return {"state": state, "client": client, "frame": frame, "churn": _upload(client, "churn.csv", frame)}


def test_templates_save_list_apply(env):
    c, state = env["client"], env["state"]
    body = {"name": "fast-churn", "description": "quick baseline", "config": {"algorithms": ["logistic_regression"], **FAST}}
    t = c.post("/v1/training-templates", json=body, headers=H)
    assert t.status_code == 201, t.text
    tid = t.json()["id"]
    assert c.post("/v1/training-templates", json=body, headers=H).status_code == 409
    assert c.post("/v1/training-templates", json={"name": "bad", "config": {"algorithms": ["nope"]}}, headers=H).status_code == 422
    assert [x["name"] for x in c.get("/v1/training-templates", headers=H).json()] == ["fast-churn"]
    patched = c.patch(f"/v1/training-templates/{tid}", json={"config": {**body["config"], "seed": 7}}, headers=H).json()
    assert patched["config"]["seed"] == 7
    applied = c.post(
        f"/v1/training-templates/{tid}/apply",
        json={"name": "from template", "dataset_id": env["churn"], "overrides": {"target": "churn", "features": ["age", "income", "plan"]}},
        headers=H,
    )
    assert applied.status_code == 202, applied.text
    assert applied.json()["experiment"]["config"]["seed"] == 7 and applied.json()["experiment"]["config"]["target"] == "churn"
    Worker(state, wait_seconds=0).drain()
    assert c.get(f"/v1/jobs/{applied.json()['job']['id']}", headers=H).json()["status"] == "succeeded"
    missing_target = c.post(f"/v1/training-templates/{tid}/apply", json={"name": "x", "dataset_id": env["churn"]}, headers=H)
    assert missing_target.status_code == 422
    assert c.delete(f"/v1/training-templates/{tid}", headers=H).status_code == 204
    assert c.get(f"/v1/training-templates/{tid}", headers=H).status_code == 404


def test_catalog_detect_onnx_and_explain_extras(env):
    c, state = env["client"], env["state"]
    ids = {a["id"] for a in c.get("/v1/algorithms", headers=H).json()}
    assert {"catboost", "stacking_ensemble", "kmeans", "dbscan", "gmm", "agglomerative", "sarima", "gbm_forecast"} <= ids
    assert c.post("/v1/experiments/detect", json={"dataset_id": env["churn"]}, headers=H).json()["problem_type"] == "clustering"

    numeric = _train(
        c,
        state,
        {
            "name": "numeric",
            "dataset_id": env["churn"],
            "target": "churn",
            "features": ["age", "income"],
            "algorithms": ["logistic_regression"],
            **FAST,
        },
    )
    onnx = c.get(f"/v1/runs/{numeric[0]['id']}/onnx", headers=H)
    assert onnx.status_code == 200 and onnx.headers["content-type"] == "application/octet-stream" and len(onnx.content) > 100
    runs = _train(
        c,
        state,
        {
            "name": "cat",
            "dataset_id": env["churn"],
            "target": "churn",
            "features": ["age", "income", "plan"],
            "algorithms": ["logistic_regression", "decision_tree"],
            "ensemble": {"enabled": True, "methods": ["voting"]},
            **FAST,
        },
    )
    assert [r["algorithm"] for r in runs] == ["logistic_regression", "decision_tree", "voting_ensemble"]
    refused = c.get(f"/v1/runs/{runs[0]['id']}/onnx", headers=H)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "onnx_unsupported"
    best = _best(runs)
    assert "ale" in c.get(f"/v1/runs/{best['id']}", headers=H).json()["artifacts"]
    out = c.post(f"/v1/runs/{runs[0]['id']}/explain", json={"instances": [{"age": 70, "income": 20, "plan": "basic"}]}, headers=H).json()
    assert out["force_plot"][0]["features"] and out["lime"][0]["weights"] and out["shap"][0]


def test_drift_monitoring_and_threshold_alerts(env):
    c, state, frame = env["client"], env["state"], env["frame"]
    runs = _train(
        c,
        state,
        {
            "name": "drift",
            "dataset_id": env["churn"],
            "target": "churn",
            "features": ["age", "income", "plan"],
            "algorithms": ["logistic_regression"],
            **FAST,
        },
    )
    reg = c.post("/v1/models", json={"name": "churn-drift", "run_id": runs[0]["id"]}, headers=H).json()
    model = c.get(f"/v1/models/{reg['model_id']}", headers=H).json()
    assert model["versions"][0]["signature"]["problem_type"] == "binary"
    for name in ("stable", "drifting"):
        assert c.post("/v1/endpoints", json={"name": name, "model_id": reg["model_id"]}, headers=H).status_code == 201
    assert c.get("/v1/endpoints/stable/drift", headers=H).json()["status"] == "no_data"

    rows = frame[["age", "income", "plan"]].to_dict(orient="records")
    for start in range(0, 300, 100):
        assert c.post("/v1/endpoints/stable/predict", json={"instances": rows[start : start + 100]}, headers=H).status_code == 200
    stable = c.get("/v1/endpoints/stable/drift?hours=1", headers=H).json()
    assert stable["samples"] == 300 and stable["thresholds"] == {"warn": 0.1, "alert": 0.25}
    assert stable["status"] in ("ok", "warn") and {f["feature"] for f in stable["features"]} == {"age", "income", "plan"}
    assert all(f["psi"] < 0.25 for f in stable["features"]) and stable["prediction"]["psi"] < 0.25

    shifted = [{**r, "income": r["income"] + 100, "plan": "platinum"} for r in rows[:100]]
    assert c.post("/v1/endpoints/drifting/predict", json={"instances": shifted}, headers=H).status_code == 200
    drifting = c.get("/v1/endpoints/drifting/drift", headers=H).json()
    assert drifting["status"] == "alert"
    alerts = {f["feature"] for f in drifting["features"] if f["status"] == "alert"}
    assert {"income", "plan"} <= alerts
    job = c.post("/v1/endpoints/drifting/drift/check", json={"hours": 24}, headers=H)
    assert job.status_code == 202, job.text
    all_job = c.post("/v1/endpoints/drift-checks", headers=H)
    assert all_job.status_code == 202, all_job.text
    Worker(state, wait_seconds=0).drain()
    result = c.get(f"/v1/jobs/{job.json()['id']}", headers=H).json()["result"]
    assert result["alerts"][0]["endpoint"] == "drifting" and "income" in {f["feature"] for f in result["alerts"][0]["features"]}
    checked = {x["endpoint"]: x["status"] for x in c.get(f"/v1/jobs/{all_job.json()['id']}", headers=H).json()["result"]["checked"]}
    assert checked["drifting"] == "alert" and checked["stable"] != "alert"
    kinds = [n["kind"] for n in c.get("/v1/notifications", headers=H).json()]
    assert kinds.count("endpoint.threshold") == 2
    assert c.get("/v1/endpoints/nope/drift", headers=H).status_code == 404


def test_clustering_and_forecasting_endpoints(env):
    c, state = env["client"], env["state"]
    ds = _upload(c, "blobs.csv", blobs())
    runs = _train(
        c,
        state,
        {
            "name": "segments",
            "dataset_id": ds,
            "problem_type": "clustering",
            "features": ["x", "y"],
            "algorithms": ["kmeans"],
            "clustering": {"k_min": 2, "k_max": 4},
        },
    )
    run = c.get(f"/v1/runs/{runs[0]['id']}", headers=H).json()
    assert run["metrics"]["n_clusters"] == 3 and run["metrics"]["problem_type"] == "clustering"
    assert {"cluster_sizes", "projection", "cluster_profiles"} <= set(run["artifacts"])
    reg = c.post("/v1/models", json={"name": "segments", "run_id": runs[0]["id"]}, headers=H).json()
    assert c.post("/v1/endpoints", json={"name": "segments", "model_id": reg["model_id"]}, headers=H).status_code == 201
    pred = c.post("/v1/endpoints/segments/predict", json={"instances": [{"x": 0, "y": 0}, {"x": 6, "y": 6}]}, headers=H).json()
    assert all(isinstance(p, int) for p in pred["predictions"]) and pred["predictions"][0] != pred["predictions"][1]
    assert c.post("/v1/endpoints/segments/predict", json={"instances": [{"x": 0, "y": 0}], "explain": True}, headers=H).status_code == 422

    sales = _upload(c, "sales.csv", monthly_sales())
    detected = c.post("/v1/experiments/detect", json={"dataset_id": sales, "target": "sales"}, headers=H).json()
    assert detected["alternatives"][0]["problem_type"] == "forecasting"
    runs = _train(
        c,
        state,
        {
            "name": "sales",
            "dataset_id": sales,
            "problem_type": "forecasting",
            "target": "sales",
            "algorithms": ["seasonal_naive", "exponential_smoothing"],
            "forecast": {"time_column": "month", "horizon": 6, "backtest_folds": 2},
            **FAST,
        },
    )
    best = c.get(f"/v1/runs/{_best(runs)['id']}", headers=H).json()
    assert best["algorithm"] == "exponential_smoothing" and best["metrics"]["mase"] < 1
    assert {"history", "backtest", "forecast"} <= set(best["artifacts"])
    reg = c.post("/v1/models", json={"name": "sales", "run_id": best["id"]}, headers=H).json()
    assert c.post("/v1/endpoints", json={"name": "sales", "model_id": reg["model_id"]}, headers=H).status_code == 201
    fc = c.post("/v1/endpoints/sales/predict", json={"horizon": 4}, headers=H)
    assert fc.status_code == 200, fc.text
    body = fc.json()
    assert len(body["timestamps"]) == len(body["predictions"]) == len(body["lower"]) == 4 and body["interval_level"] == 0.9
    assert body["timestamps"][0].startswith("2023-01-01") and body["model_version"]["version"] == 1
    assert np.all(np.array(body["lower"]) <= np.array(body["upper"]))
    history = [{"month": "2023-01-01", "sales": 170.0}, {"month": "2023-02-01", "sales": 171.0}]
    moved = c.post("/v1/endpoints/sales/predict", json={"horizon": 2, "history": history}, headers=H).json()
    assert moved["timestamps"][0].startswith("2023-03-01")
    assert c.post("/v1/endpoints/sales/predict", json={"horizon": 2, "history": [{"when": 1}]}, headers=H).status_code == 422
    spec = c.get("/v1/endpoints/sales/openapi.json", headers=H).json()
    assert "ForecastRequest" in spec["components"]["schemas"]
    assert c.get("/v1/endpoints/sales/drift", headers=H).json()["status"] == "not_applicable"
    assert c.post("/v1/endpoints/sales/predict", json={}, headers=H).status_code == 422
