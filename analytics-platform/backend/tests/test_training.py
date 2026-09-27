from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.api.deps import build_state
from app.jobs.core import Worker
from app.main import create_app
from app.training.algorithms import ALGORITHMS, grid_space
from app.training.preprocessing import resample
from app.training.trainer import TrainingConfig, TrainingError, detect_problem_type, train

H = {"X-Tenant-ID": "acme", "X-User-ID": "ds"}
FAST = {"automl": {"enabled": True, "n_trials": 2, "timeout_seconds": 30}, "cv": {"folds": 3}}


def churn_frame(n=400, seed=0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    df = pd.DataFrame(
        {
            "customer_id": range(1, n + 1),
            "age": rng.integers(18, 80, n),
            "income": rng.normal(50, 15, n).round(2),
            "plan": rng.choice(["basic", "pro", "enterprise"], n),
            "signup": pd.date_range("2021-01-01", periods=n, freq="D").strftime("%Y-%m-%d"),
        }
    )
    logit = 0.06 * (df.age - 50) + 0.1 * (df.income - 50) + (df.plan == "basic") * 1.5
    df["churn"] = np.where(rng.random(n) < 1 / (1 + np.exp(-logit)), "yes", "no")
    df["spend"] = (3 * df.income + 20 * (df.plan == "enterprise") + rng.normal(0, 5, n)).round(2)
    return df


def test_problem_detection():
    assert detect_problem_type(pd.Series(["a", "b", "a"]))[0] == "binary"
    assert detect_problem_type(pd.Series(list("abcabcabcd")))[0] == "multiclass"
    assert detect_problem_type(pd.Series(np.random.default_rng(0).normal(size=100)))[0] == "regression"
    assert detect_problem_type(pd.Series([1, 2, 3] * 100))[0] == "multiclass"
    with pytest.raises(TrainingError):
        detect_problem_type(pd.Series([1, 1, 1]))


def test_every_algorithm_trains():
    df = churn_frame(300)
    for algo_id, algo in ALGORITHMS.items():
        target = "churn" if "binary" in algo.problem_types else "spend"
        cfg = TrainingConfig(target=target, algorithms=[algo_id], automl={"enabled": False}, cv={"folds": 2}, max_training_seconds=60)
        result = train(df.drop(columns=["spend"] if target == "churn" else ["churn"]), cfg)
        assert result.results[0].algorithm == algo_id
        assert result.results[0].metrics["n_test"] > 0


def test_binary_training_with_explanations_and_leakage_warning():
    df = churn_frame()
    df["leak"] = (df["churn"] == "yes").astype(int)
    cfg = TrainingConfig(target="churn", algorithms=["logistic_regression", "lightgbm"], class_imbalance="smote", **FAST)
    result = train(df.drop(columns=["spend"]), cfg)
    best = result.results[result.best_index]
    assert result.problem_type == "binary" and result.classes == ["no", "yes"]
    assert best.metrics["roc_auc"] > 0.9  # the leak makes it easy
    assert any("leak correlates" in w for w in result.warnings)
    assert any("customer_id" in w for w in result.warnings)  # identifier excluded
    a = best.artifacts
    assert {"roc_curve", "pr_curve", "confusion_matrix", "calibration", "permutation_importance", "shap_summary", "pdp"} <= set(a)
    assert a["shap_summary"][0]["feature"] == "leak"
    assert {f["group"] for f in result.signature["features"]} >= {"numeric", "categorical", "datetime", "dropped"}


def test_regression_and_multiclass_and_time_split():
    df = churn_frame()
    reg = train(df.drop(columns=["churn"]), TrainingConfig(target="spend", algorithms=["linear_regression", "random_forest"], **FAST))
    best = reg.results[reg.best_index]
    assert reg.problem_type == "regression" and best.metrics["r2"] > 0.9 and "residuals" in best.artifacts
    multi = train(df, TrainingConfig(target="plan", features=["spend", "income", "age"], algorithms=["random_forest"], **FAST))
    assert multi.problem_type == "multiclass" and len(multi.results[0].artifacts["confusion_matrix"]["labels"]) == 3
    timed = train(
        df.drop(columns=["churn"]),
        TrainingConfig(
            target="spend", algorithms=["linear_regression"], split={"method": "time", "time_column": "signup"}, automl={"enabled": False}
        ),
    )
    assert timed.results[0].metrics["r2"] > 0.8


def test_grid_and_random_search_and_feature_selection():
    df = churn_frame(300).drop(columns=["spend"])
    for strategy in ("grid", "random"):
        cfg = TrainingConfig(
            target="churn",
            algorithms=["decision_tree"],
            automl={"strategy": strategy, "n_trials": 3, "timeout_seconds": 30},
            cv={"folds": 2},
            preprocessing={"feature_selection": {"method": "mutual_info", "k": 3}, "encoding": "ordinal", "scaling": "robust"},
        )
        result = train(df, cfg)
        assert len(result.results[0].trials) >= 1
    assert set(grid_space(ALGORITHMS["random_forest"])) == {"n_estimators", "max_depth", "min_samples_leaf", "max_features"}


def test_resampling():
    X = np.vstack([np.zeros((90, 2)), np.ones((10, 2))])
    y = np.array([0] * 90 + [1] * 10)
    for method in ("oversample", "smote"):
        _, yr = resample(X, y, method, 0)
        assert (yr == 1).sum() == (yr == 0).sum() == 90
    _, yr = resample(X, y, "undersample", 0)
    assert (yr == 1).sum() == (yr == 0).sum() == 10


def test_validation_errors():
    df = churn_frame(100)
    with pytest.raises(TrainingError, match="not found"):
        train(df, TrainingConfig(target="nope"))
    with pytest.raises(ValueError):
        TrainingConfig(target="x", algorithms=["quantum_forest"])
    with pytest.raises(ValueError):
        TrainingConfig(target="x", split={"method": "time"})


# -- API end to end ---------------------------------------------------------------------------------


@pytest.fixture
def state(tmp_path):
    return build_state(data_dir=tmp_path, dev_auth=True, cloud_provider="local", database_url=None, inline_worker=False)


@pytest.fixture
def client(state):
    return TestClient(create_app(state))


def test_training_api_registry_and_what_if(client, state):
    csv = churn_frame(300).drop(columns=["spend"]).to_csv(index=False)
    ds = client.post("/v1/datasets", files={"file": ("churn.csv", csv.encode())}, headers=H).json()["dataset"]["id"]
    assert client.get("/v1/algorithms", headers=H).json()[0]["hyperparameters"][0]["help"]
    detected = client.post("/v1/experiments/detect", json={"dataset_id": ds, "target": "churn"}, headers=H).json()
    assert detected["problem_type"] == "binary" and len(detected["classes"]) == 2

    r = client.post(
        "/v1/experiments",
        json={"name": "churn v1", "dataset_id": ds, "target": "churn", "algorithms": ["logistic_regression", "decision_tree"], **FAST},
        headers=H,
    )
    assert r.status_code == 202, r.text
    exp_id = r.json()["experiment"]["id"]
    Worker(state, wait_seconds=0).drain()
    detail = client.get(f"/v1/experiments/{exp_id}", headers=H).json()
    assert detail["job"]["status"] == "succeeded", detail["job"]["error"]
    runs = detail["runs"]
    assert len(runs) == 2 and sum(r["artifacts"]["is_best"] for r in runs) == 1
    best = next(r for r in runs if r["artifacts"]["is_best"])
    full = client.get(f"/v1/runs/{best['id']}", headers=H).json()
    assert "roc_curve" in full["artifacts"] and full["metrics"]["problem_type"] == "binary"
    compare = client.get(f"/v1/experiments/compare?run_ids={runs[0]['id']},{runs[1]['id']}", headers=H).json()
    assert "roc_auc" in compare["metrics"] and len(compare["runs"]) == 2

    what_if = client.post(
        f"/v1/runs/{best['id']}/explain",
        json={
            "instances": [
                {"age": 30, "income": 80, "plan": "pro", "signup": "2022-01-01"},
                {"age": 70, "income": 20, "plan": "basic", "signup": "2022-01-01"},
            ]
        },
        headers=H,
    )
    assert what_if.status_code == 200, what_if.text
    body = what_if.json()
    assert body["predictions"] and len(body["shap"]) == 2 and "income" in body["shap"][0]
    assert client.post(f"/v1/runs/{best['id']}/explain", json={"instances": [{"plan": "pro"}]}, headers=H).status_code == 422

    reg = client.post("/v1/models", json={"name": "churn", "run_id": best["id"]}, headers=H).json()
    assert reg["version"] == 1
    reg2 = client.post("/v1/models", json={"name": "churn", "run_id": runs[0]["id"]}, headers=H).json()
    assert reg2["version"] == 2
    client.post(f"/v1/models/{reg['model_id']}/versions/1/stage", json={"stage": "production"}, headers=H)
    model = client.post(f"/v1/models/{reg['model_id']}/versions/2/stage", json={"stage": "production"}, headers=H).json()
    assert [v["stage"] for v in model["versions"]] == ["archived", "production"]
    assert client.get("/v1/models", headers=H).json()[0]["production_version"] == 2
    text = client.post(f"/v1/runs/{best['id']}/explanation-text", headers=H)
    assert text.status_code == 200  # mock provider in tests
