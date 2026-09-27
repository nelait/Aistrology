"""Phase 2 (P1) machine-learning features: clustering (TRN-006), forecasting (TRN-007), CatBoost and ensembles
(TRN-002a, TRN-005), automatic features and PCA (FE-001, FE-005), ALE / LIME / force plots (XAI-001a, XAI-002a),
drift profiles (API-011) and ONNX export (MDL-NFR-004)."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.training.clustering import ClusterModel, cluster_metrics
from app.training.drift_profile import build_reference, drift_report, feature_profiles, psi, token
from app.training.forecasting import ForecastConfig, detect_frequency, detect_time_series, prepare_series, season_for
from app.training.onnx_export import OnnxUnsupported, export_onnx
from app.training.service import ModelBundle, deep_merge, validate_template_config
from app.training.trainer import TrainingConfig, TrainingError, train, transformed_feature_names

from .test_training import churn_frame

NO_AUTOML = {"automl": {"enabled": False}, "cv": {"folds": 2}}


def blobs(n_per=50, seed=0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    centers = np.array([[0, 0], [6, 6], [0, 8]])
    pts = np.vstack([c + rng.normal(0, 0.6, (n_per, 2)) for c in centers])
    return pd.DataFrame({"x": pts[:, 0].round(4), "y": pts[:, 1].round(4), "row_id": range(len(pts))})


def monthly_sales(n=60, seed=0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    t = np.arange(n)
    y = 100 + t + 10 * np.sin(2 * np.pi * t / 12) + rng.normal(0, 1.5, n)
    return pd.DataFrame({"month": pd.date_range("2018-01-01", periods=n, freq="MS").strftime("%Y-%m-%d"), "sales": y.round(3)})


# -- clustering (TRN-006, EXP-005) ------------------------------------------------------------------------------


def test_clustering_searches_k_and_reports_metrics_and_profiles():
    df = blobs()
    cfg = TrainingConfig(problem_type="clustering", clustering={"k_min": 2, "k_max": 5}, automl={"n_trials": 8})
    assert cfg.target is None
    result = train(df, cfg)
    assert result.problem_type == "clustering" and result.signature["target"] is None
    by_algo = {r.algorithm: r for r in result.results}
    assert set(by_algo) == {"kmeans", "gmm", "agglomerative", "dbscan"}
    km = by_algo["kmeans"]
    assert km.params["n_clusters"] == 3 and km.metrics["n_clusters"] == 3  # silhouette picks the true k
    assert km.metrics["silhouette"] > 0.7 and km.metrics["calinski_harabasz"] > 100 and km.metrics["davies_bouldin"] < 0.6
    assert [t["params"]["n_clusters"] for t in km.artifacts["k_search"]] == [2, 3, 4, 5]
    a = km.artifacts
    assert sum(s["size"] for s in a["cluster_sizes"]) == len(df)
    assert len(a["projection"]["x"]) == len(a["projection"]["cluster"]) == len(df)
    assert {"means", "top_categories"} <= set(a["cluster_profiles"][0]) and set(a["cluster_profiles"][0]["means"]) == {"x", "y"}
    assert any("row_id" in w for w in result.warnings)  # identifier-like column excluded
    # served models label unseen rows
    labels = km.pipeline.predict(pd.DataFrame({"x": [0.1, 6.1], "y": [0.0, 5.9], "row_id": [0, 0]}))
    assert labels[0] != labels[1]
    assert result.reference and set(result.reference["features"]) == {"x", "y"}


def test_dbscan_nearest_core_assignment_and_agglomerative_predict():
    X = blobs()[["x", "y"]].to_numpy()
    db = ClusterModel("dbscan", {"eps": 1.0, "min_samples": 4}).fit(X)
    assert len(set(db.labels_) - {-1}) == 3
    far = db.predict(np.array([[50.0, 50.0], X[0]]))
    assert far[0] == -1 and far[1] == db.labels_[0]
    agg = ClusterModel("agglomerative", {"n_clusters": 3}).fit(X)
    assert (agg.predict(X) == agg.labels_).mean() > 0.95
    m = cluster_metrics(X, np.zeros(len(X), dtype=int))
    assert m["silhouette"] is None and m["n_clusters"] == 1


# -- forecasting (TRN-007, EXP-004) -----------------------------------------------------------------------------


def test_frequency_detection_and_series_preparation():
    assert detect_frequency(pd.DatetimeIndex(pd.date_range("2024-01-01", periods=20, freq="D"))) == "D"
    assert detect_frequency(pd.DatetimeIndex(pd.date_range("2024-01-07", periods=20, freq="W-SUN"))) == "W-SUN"
    irregular = pd.DatetimeIndex(pd.to_datetime(["2024-01-01", "2024-02-01", "2024-03-01", "2024-05-01", "2024-06-01"]))
    assert detect_frequency(irregular) == "MS"
    assert season_for("MS") == 12 and season_for("D") == 7 and season_for("W-SUN") == 52 and season_for("h") == 24
    df = monthly_sales(24).drop(index=[5])  # a gap
    df = pd.concat([df, df.iloc[[0]]])  # a duplicate timestamp
    series, freq, warns = prepare_series(df, "sales", ForecastConfig(time_column="month"))
    assert freq == "MS" and len(series) == 24 and not series.isna().any()
    assert any("interpolated" in w for w in warns) and any("aggregated" in w for w in warns)


def test_forecasting_backtest_metrics_and_future_forecast():
    df = monthly_sales()
    cfg = TrainingConfig(
        problem_type="forecasting",
        target="sales",
        algorithms=["seasonal_naive", "exponential_smoothing", "sarima", "gbm_forecast"],
        forecast={"time_column": "month", "horizon": 6, "backtest_folds": 2},
        **NO_AUTOML,
    )
    result = train(df, cfg)
    assert result.problem_type == "forecasting" and result.signature["frequency"] == "MS"
    by_algo = {r.algorithm: r for r in result.results}
    assert set(by_algo) == {"seasonal_naive", "exponential_smoothing", "sarima", "gbm_forecast"}
    for r in by_algo.values():
        assert {"mae", "rmse", "mase", "smape", "coverage"} <= set(r.metrics) and 0 <= r.metrics["coverage"] <= 1
        assert r.metrics["n_backtest_points"] == 12
        assert len(r.artifacts["backtest"]) == 2 and len(r.artifacts["backtest"][0]["forecast"]) == 6
        fc = r.artifacts["forecast"]
        assert len(fc["timestamps"]) == len(fc["forecast"]) == 6 and fc["timestamps"][0].startswith("2023-01-01")
        assert all(lo <= mid <= hi for lo, mid, hi in zip(fc["lower"], fc["forecast"], fc["upper"]))
    best = result.results[result.best_index]
    # a trend + seasonality model beats repeating last year's values
    assert best.algorithm != "seasonal_naive" and best.metrics["mase"] < by_algo["seasonal_naive"].metrics["mase"]
    assert len(best.artifacts["history"]["values"]) == 60
    # serving with fresh history refits and moves the origin forward
    model = best.pipeline
    out = model.forecast(3)
    assert out["timestamps"][0].startswith("2023-01-01") and len(out["predictions"]) == 3
    history = pd.Series([170.0, 172.0], index=pd.DatetimeIndex(["2023-01-01", "2023-02-01"]))
    assert model.forecast(2, history)["timestamps"][0].startswith("2023-03-01")


def test_forecasting_validation_and_detection():
    with pytest.raises(ValueError, match="time_column"):
        TrainingConfig(problem_type="forecasting", target="sales")
    with pytest.raises(ValueError, match="target is required"):
        TrainingConfig(problem_type="regression")
    with pytest.raises(TrainingError, match="at least 12"):
        train(monthly_sales(8), TrainingConfig(problem_type="forecasting", target="sales", forecast={"time_column": "month"}))
    hint = detect_time_series(monthly_sales(), "sales")
    assert hint["problem_type"] == "forecasting" and hint["time_column"] == "month" and hint["frequency"] == "MS"
    assert detect_time_series(blobs(), "x") is None


# -- CatBoost, ensembles, automatic features, PCA, ALE, LIME, force plots -------------------------------------------


def test_ensembles_are_added_over_the_best_candidates():
    df = churn_frame(300).drop(columns=["spend"])
    cfg = TrainingConfig(
        target="churn", algorithms=["logistic_regression", "decision_tree", "catboost"], ensemble={"enabled": True, "top_k": 2}, **NO_AUTOML
    )
    result = train(df, cfg)
    algos = [r.algorithm for r in result.results]
    assert algos == ["logistic_regression", "decision_tree", "catboost", "stacking_ensemble", "voting_ensemble"]
    stack = result.results[3]
    assert len(stack.params["base"]) == 2 and stack.artifacts["ensemble_members"][0] == "logistic_regression"
    assert stack.metrics["roc_auc"] > 0.6 and "confusion_matrix" in stack.artifacts
    # ensembles are off by default when the algorithms were pinned
    pinned = train(df, TrainingConfig(target="churn", algorithms=["logistic_regression", "decision_tree"], **NO_AUTOML))
    assert len(pinned.results) == 2


def test_auto_features_pca_ale_lime_and_force_plot():
    df = churn_frame(300).drop(columns=["churn"])
    df["spend"] = df["spend"] + 0.05 * df["age"] * df["income"]
    cfg = TrainingConfig(
        target="spend",
        algorithms=["linear_regression"],
        preprocessing={"auto_features": {"top_k": 2, "polynomial": True}},
        **NO_AUTOML,
    )
    result = train(df, cfg)
    best = result.results[0]
    names = transformed_feature_names(best.pipeline)
    assert {"fe__age x income", "fe__income^2", "fe__age^2"} <= set(names)
    assert {d["feature"] for d in best.artifacts["shap_summary"]} <= set(df.columns)  # interactions map back to sources
    ale = best.artifacts["ale"]["income"]
    assert len(ale["grid"]) == len(ale["ale"]) == len(ale["counts"]) + 1
    assert ale["ale"][-1] > ale["ale"][0]  # spend rises with income

    bundle = ModelBundle(best.pipeline, result.signature, result.background, best.algorithm)
    instance = {"age": 60, "income": 90, "plan": "pro", "signup": "2022-01-01", "customer_id": 1}
    out = bundle.explain([instance])
    fp = out["force_plot"][0]
    assert fp["features"][0]["feature"] == "income" and fp["features"][0]["value"] == 90
    assert fp["output_value"] == pytest.approx(fp["base_value"] + sum(f["shap"] for f in fp["features"]), abs=1e-3)
    lime = out["lime"][0]
    assert lime["weights"][0]["feature"] == "income" and lime["weights"][0]["weight"] > 0 and lime["r2"] > 0.5

    pca = train(
        df, TrainingConfig(target="spend", algorithms=["linear_regression"], preprocessing={"pca": {"n_components": 3}}, **NO_AUTOML)
    )
    assert transformed_feature_names(pca.results[0].pipeline) == ["pca0", "pca1", "pca2"]


def test_classifier_lime_explains_predicted_class():
    df = churn_frame(300).drop(columns=["spend"])
    result = train(df, TrainingConfig(target="churn", features=["age", "income", "plan"], algorithms=["catboost"], **NO_AUTOML))
    best = result.results[0]
    assert "ale" in best.artifacts and best.artifacts["shap_summary"]
    bundle = ModelBundle(best.pipeline, result.signature, result.background, best.algorithm)
    out = bundle.explain([{"age": 75, "income": 90, "plan": "basic"}])
    assert out["lime"][0]["explained_class"] in ("yes", "no") and len(out["lime"][0]["weights"]) == 3
    assert [f["feature"] for f in out["force_plot"][0]["features"]][0] in ("age", "income", "plan")


# -- drift profiles (API-011) --------------------------------------------------------------------------------------


def test_reference_profile_psi_and_pii_exclusion():
    df = churn_frame(500)
    signature = {
        "problem_type": "regression",
        "features": [
            {"name": "income", "group": "numeric"},
            {"name": "plan", "group": "categorical"},
            {"name": "age", "group": "numeric", "pii": True},
            {"name": "customer_id", "group": "dropped"},
        ],
    }
    profiles = feature_profiles(df, signature)
    assert set(profiles) == {"income", "plan"}  # PII and dropped features are never profiled
    ref = {"features": profiles, "prediction": None}
    same = [{"features": {"income": token(profiles["income"], r.income), "plan": token(profiles["plan"], r.plan)}} for r in df.itertuples()]
    report = drift_report(ref, same)
    assert report["status"] == "ok" and all(f["psi"] < 0.01 for f in report["features"])
    shifted = [
        {"features": {"income": token(profiles["income"], r.income + 100), "plan": token(profiles["plan"], "unknown")}}
        for r in df.itertuples()
    ]
    report = drift_report(ref, shifted)
    assert report["status"] == "alert" and {f["feature"] for f in report["features"] if f["status"] == "alert"} == {"income", "plan"}
    assert token(profiles["plan"], "unknown") == "__other__" and token(profiles["income"], None) == "__missing__"
    assert psi([0.5, 0.5], [0.5, 0.5]) == pytest.approx(0.0)
    empty = build_reference(df, {"features": [{"name": "nope", "group": "numeric"}]}, [], 0)
    assert empty["features"] == {} and empty["predictions"] == []


# -- ONNX (MDL-NFR-004) and templates (CFG-007) ---------------------------------------------------------------------


def test_onnx_export_numeric_pipelines_only():
    ort = pytest.importorskip("onnxruntime")
    df = churn_frame(300).drop(columns=["spend"])
    result = train(
        df, TrainingConfig(target="churn", features=["age", "income"], algorithms=["logistic_regression", "lightgbm"], **NO_AUTOML)
    )
    X = df[["age", "income"]].head(20)
    for res in result.results:
        data = export_onnx(res.pipeline, result.signature, res.algorithm)
        session = ort.InferenceSession(data, providers=["CPUExecutionProvider"])
        outputs = session.run(None, {c: X[[c]].to_numpy(np.float32) for c in ("age", "income")})
        proba = next(o for o in outputs if getattr(o, "ndim", 0) == 2)
        assert np.abs(proba - res.pipeline.predict_proba(X)).max() < 1e-3, res.algorithm
    categorical = train(df, TrainingConfig(target="churn", features=["age", "plan"], algorithms=["logistic_regression"], **NO_AUTOML))
    with pytest.raises(OnnxUnsupported, match="categorical"):
        export_onnx(categorical.results[0].pipeline, categorical.signature, "logistic_regression")


def test_template_validation_and_merge():
    assert validate_template_config({"algorithms": ["random_forest"], "cv": {"folds": 3}})
    with pytest.raises(ValueError):
        validate_template_config({"algorithms": ["quantum_forest"]})
    merged = deep_merge({"cv": {"folds": 3, "method": "kfold"}, "seed": 1}, {"cv": {"folds": 4}, "target": "y"})
    assert merged == {"cv": {"folds": 4, "method": "kfold"}, "seed": 1, "target": "y"}
