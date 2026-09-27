"""Phase 3 ML units: anomaly detection (TRN-008), text features (FE-006), fairness (XAI-004), projections (FE-005a),
custom ONNX model validation (TRN-010 / SEC-010) and canary traffic splits (API-009)."""

from __future__ import annotations

import pickle

import numpy as np
import pandas as pd
import pytest

from app.serving.canary import CanaryStart, _split
from app.training.anomaly import AnomalyModel, encode_labels
from app.training.custom_models import UploadRejected, UploadSignature, build_pipeline, synthetic_frame, validate_onnx
from app.training.drift_profile import prediction_token_value
from app.training.fairness import fairness_report
from app.training.onnx_export import OnnxUnsupported, export_onnx
from app.training.preprocessing import split_features
from app.training.projection import ProjectionRequest, embed, project_dataset
from app.training.service import ModelBundle
from app.training.trainer import TrainingConfig, TrainingError, train

FAST = {"automl": {"enabled": False}, "cv": {"folds": 2}}


def transactions(n=300, seed=0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    X = rng.normal(0, 1, (n, 3))
    fraud = np.zeros(n, dtype=bool)
    fraud[:12] = True
    X[fraud] += 5
    df = pd.DataFrame(X.round(4), columns=["amount", "velocity", "distance"])
    df["channel"] = rng.choice(["web", "app"], n)
    df["label"] = np.where(fraud, "fraud", "ok")
    return df


def reviews(n=240, seed=0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    good = ["great product love it", "excellent service very happy", "works perfectly would buy again"]
    bad = ["terrible quality broke fast", "awful support never again", "bad experience waste of money"]
    y = rng.random(n) < 0.5
    return pd.DataFrame(
        {
            "review": [f"{(good if v else bad)[i % 3]} order {i}" for i, v in enumerate(y)],
            "stars_hint": rng.normal(size=n).round(3),
            "gender": rng.choice(["f", "m"], n),
            "sentiment": np.where(y, "positive", "negative"),
        }
    )


# -- anomaly detection (MDL-002b, TRN-008) -------------------------------------------------------------------------------


def test_anomaly_detectors_score_and_flag():
    rng = np.random.default_rng(1)
    X = np.vstack([rng.normal(0, 1, (200, 2)), [[8, 8], [-9, 7]]])
    for algo in ("isolation_forest", "one_class_svm", "lof", "autoencoder"):
        m = AnomalyModel(algo, {}, seed=0, contamination=0.02).fit(X)
        scores = m.score_samples(X)
        assert scores[-2:].min() > np.median(scores), algo  # higher = more anomalous
        assert m.predict(X).mean() <= 0.05 and set(np.unique(m.predict(X))) <= {0, 1}
    codes, positive = encode_labels(pd.Series(["ok", "fraud", "ok"]))
    assert positive == "fraud" and codes.tolist() == [0, 1, 0]
    with pytest.raises(ValueError):
        encode_labels(pd.Series(["a", "b", "c"]))


def test_anomaly_training_with_labels_metrics_and_serving():
    df = transactions()
    cfg = TrainingConfig(problem_type="anomaly", target="label", algorithms=["isolation_forest", "lof"], automl={"n_trials": 4})
    result = train(df, cfg)
    assert result.problem_type == "anomaly" and result.signature["label_column"] == "label"
    assert "label" not in [f["name"] for f in result.signature["features"]]
    best = result.results[result.best_index]
    m = best.metrics
    assert m["cv_metric"] == "pr_auc" and m["roc_auc"] > 0.9 and m["pr_auc"] > 0.8 and {"precision", "recall", "f1"} <= set(m)
    a = best.artifacts
    assert {"score_distribution", "roc_curve", "pr_curve", "confusion_matrix", "top_anomalies"} <= set(a)
    assert sum(a["score_distribution"]["counts"]) == m["n_test"] and "counts_anomaly" in a["score_distribution"]
    assert a["feature_importance"][0]["feature"] in {"amount", "velocity", "distance"}
    bundle = ModelBundle(best.pipeline, result.signature, result.background, best.algorithm)
    out = bundle.predict([{"amount": 6, "velocity": 5, "distance": 5, "channel": "web"}, {"amount": 0, "velocity": 0, "distance": 0}])
    assert out["predictions"][0]["is_anomaly"] is True and out["predictions"][1]["is_anomaly"] is False
    assert out["predictions"][0]["score"] > out["threshold"] > out["predictions"][1]["score"]
    with pytest.raises(ValueError):
        bundle.explain([{"amount": 0, "velocity": 0, "distance": 0, "channel": "web"}])
    with pytest.raises(OnnxUnsupported):
        export_onnx(best.pipeline, result.signature, best.algorithm)
    assert result.reference["predictions"][0]["type"] == "categorical"
    assert prediction_token_value(out["predictions"][0]) == "True"

    f1 = train(df, TrainingConfig.model_validate({**cfg.model_dump(), "anomaly": {"threshold": "f1"}, "algorithms": ["isolation_forest"]}))
    assert f1.results[0].metrics["f1"] >= 0.8


def test_anomaly_without_labels_uses_consensus():
    df = transactions().drop(columns=["label"])
    result = train(df, TrainingConfig(problem_type="anomaly", anomaly={"contamination": 0.04}, **FAST))
    assert {r.algorithm for r in result.results} == {"isolation_forest", "lof", "one_class_svm", "autoencoder"}
    assert all(r.metrics["cv_metric"] == "consensus" and "roc_auc" not in r.metrics for r in result.results)
    assert abs(np.median([r.metrics["anomaly_rate"] for r in result.results]) - 0.04) < 0.03
    with pytest.raises(TrainingError):
        train(df, TrainingConfig(problem_type="anomaly", anomaly={"threshold": "f1"}, **FAST))
    with pytest.raises(ValueError):
        TrainingConfig(problem_type="binary")  # still needs a target


# -- text features (FE-006) -----------------------------------------------------------------------------------------------


def test_text_columns_are_dropped_unless_enabled():
    df = reviews()
    assert split_features(df, ["review", "stars_hint"], {})["dropped"] == ["review"]
    groups = split_features(
        df, ["review", "stars_hint"], {}, text=TrainingConfig(target="x", preprocessing={"text": {}}).preprocessing.text
    )
    assert groups["text"] == ["review"] and not groups["dropped"]
    with pytest.raises(ValueError):
        split_features(
            df, ["stars_hint"], {}, text=TrainingConfig(target="x", preprocessing={"text": {"columns": ["nope"]}}).preprocessing.text
        )


@pytest.mark.parametrize("text", [{"max_features": 40}, {"max_features": 40, "svd_components": 4}])
def test_tfidf_features_train_serve_and_explain_on_source_column(text):
    df = reviews()
    cfg = TrainingConfig(target="sentiment", algorithms=["logistic_regression"], preprocessing={"text": text}, **FAST)
    result = train(df, cfg)
    res = result.results[0]
    assert res.metrics["f1"] > 0.9
    assert {f["name"]: f["group"] for f in result.signature["features"]}["review"] == "text"
    assert res.artifacts["shap_summary"][0]["feature"] == "review"
    bundle = ModelBundle(res.pipeline, result.signature, result.background, res.algorithm)
    out = bundle.explain([{"review": "awful quality waste of money", "stars_hint": 0.1, "gender": "f"}])
    assert out["predictions"] == ["negative"] and set(out["shap"][0]) == {"review", "stars_hint", "gender"}
    with pytest.raises(OnnxUnsupported):
        export_onnx(res.pipeline, result.signature, res.algorithm)


# -- fairness (XAI-004) -------------------------------------------------------------------------------------------------


def test_fairness_report_rates_parity_and_four_fifths():
    y_true = np.array([1, 1, 0, 0, 1, 1, 0, 0] * 5)
    y_pred = np.array([1, 1, 1, 0, 1, 0, 0, 0] * 5)
    attrs = pd.DataFrame({"group": ["a"] * 4 * 5 + ["b"] * 4 * 5})
    attrs["group"] = (["a"] * 4 + ["b"] * 4) * 5
    (rep,) = fairness_report(y_true, y_pred, attrs, ["group"], 1)
    by = {g["group"]: g for g in rep["groups"]}
    assert by["a"]["selection_rate"] == 0.75 and by["b"]["selection_rate"] == 0.25
    assert by["a"]["tpr"] == 1.0 and by["b"]["tpr"] == 0.5 and by["a"]["fpr"] == 0.5 and by["b"]["fpr"] == 0.0
    assert by["a"]["precision"] == pytest.approx(2 / 3, abs=1e-5)
    assert rep["demographic_parity_difference"] == 0.5 and rep["demographic_parity_ratio"] == pytest.approx(1 / 3, abs=1e-5)
    assert rep["equalized_odds_difference"] == 0.5
    assert rep["four_fifths_rule"] == {"threshold": 0.8, "passed": False, "flagged_groups": ["b"]}


def test_classification_training_keeps_holdout_for_fairness():
    df = reviews()
    df["email"] = [f"user{i}@example.com" for i in range(len(df))]
    result = train(df, TrainingConfig(target="sentiment", features=["stars_hint"], algorithms=["logistic_regression"], **FAST))
    hold = result.holdout
    assert len(hold["rows"]) == len(hold["y_true"]) == len(result.results[0].holdout_predictions) == len(hold["attributes"])
    assert {"gender", "stars_hint"} <= set(hold["attributes"].columns) and "review" not in hold["attributes"].columns
    assert (df["sentiment"].iloc[hold["rows"]].map({"negative": 0, "positive": 1}).to_numpy() == hold["y_true"]).all()
    with pytest.raises(TrainingError):
        train(df, TrainingConfig(target="sentiment", fairness={"protected": ["nope"]}, algorithms=["logistic_regression"], **FAST))


# -- projections (FE-005a) ----------------------------------------------------------------------------------------------


def test_projections_tsne_and_pca():
    df = transactions(120)
    out = project_dataset(df, ProjectionRequest(method="tsne", sample=80, color_by="label"), {})
    assert out["method"] == "tsne" and out["n"] == len(out["x"]) == len(out["y"]) == len(out["color"]) == 80
    assert "label" not in out["features"] and out["total_rows"] == 120
    assert embed(np.random.default_rng(0).normal(size=(30, 5)), "pca").shape == (30, 2)
    with pytest.raises(ValueError):
        project_dataset(df, ProjectionRequest(features=["nope"]), {})


# -- custom ONNX models (TRN-010, SEC-010) -------------------------------------------------------------------------------


def _onnx_logreg(n_features=2) -> bytes:
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType
    from sklearn.linear_model import LogisticRegression

    rng = np.random.default_rng(0)
    X = rng.normal(size=(100, n_features)).astype(np.float32)
    y = (X[:, 0] > 0).astype(int)
    model = LogisticRegression().fit(X, y)
    return convert_sklearn(
        model, initial_types=[("input", FloatTensorType([None, n_features]))], options={id(model): {"zipmap": False}}
    ).SerializeToString()


SIG = {
    "problem_type": "binary",
    "target": "flag",
    "classes": ["no", "yes"],
    "features": [{"name": "a", "type": "number", "min": -3, "max": 3}, {"name": "b", "type": "number"}],
}


def test_onnx_validation_rejects_unsafe_files():
    with pytest.raises(UploadRejected, match="pickle"):
        validate_onnx(pickle.dumps({"x": 1}))
    with pytest.raises(UploadRejected, match="zip"):
        validate_onnx(b"PK\x03\x04rest")
    with pytest.raises(UploadRejected):
        validate_onnx(b"definitely not onnx")
    from onnx import TensorProto, helper

    node = helper.make_node("Evil", ["X"], ["Y"], domain="com.evil")
    graph = helper.make_graph(
        [node],
        "g",
        [helper.make_tensor_value_info("X", TensorProto.FLOAT, [1])],
        [helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1])],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17), helper.make_opsetid("com.evil", 1)])
    with pytest.raises(UploadRejected, match="custom"):
        validate_onnx(model.SerializeToString())
    weight = helper.make_tensor("W", TensorProto.FLOAT, [1], [1.0])
    add = helper.make_node("Add", ["X", "W"], ["Y"])
    graph = helper.make_graph(
        [add],
        "g",
        [helper.make_tensor_value_info("X", TensorProto.FLOAT, [1])],
        [helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1])],
        initializer=[weight],
    )
    ext = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    assert validate_onnx(ext.SerializeToString()) is not None
    tensor = ext.graph.initializer[0]
    tensor.data_location = TensorProto.EXTERNAL
    entry = tensor.external_data.add()
    entry.key, entry.value = "location", "/etc/passwd"
    with pytest.raises(UploadRejected, match="external"):
        validate_onnx(ext.SerializeToString())
    assert validate_onnx(_onnx_logreg()) is not None


def test_onnx_adapter_tensor_and_per_feature_modes():
    sig = UploadSignature.model_validate(SIG).bundle_signature()
    pipe = build_pipeline(_onnx_logreg(), sig)
    assert pipe.input_mode == "tensor" and hasattr(pipe, "predict_proba")
    X = pd.DataFrame({"a": [2.0, -2.0], "b": [0.0, 0.0]})
    assert pipe.predict(X).tolist() == [1, 0]
    assert pipe.predict_proba(X).shape == (2, 2)
    frame = synthetic_frame(sig, 10)
    assert len(frame) == 10 and frame["a"].between(-3, 3).all() and frame["a"].iloc[0] == 0.0
    with pytest.raises(UploadRejected):
        build_pipeline(_onnx_logreg(3), sig)  # 3 input columns vs 2 declared features
    with pytest.raises(ValueError):
        UploadSignature.model_validate({**SIG, "classes": ["only"]})

    df = pd.DataFrame({"a": np.linspace(-2, 2, 60), "b": np.linspace(1, 0, 60)})
    df["flag"] = np.where(df.a > 0, "yes", "no")
    result = train(df, TrainingConfig(target="flag", algorithms=["logistic_regression"], **FAST))
    data = export_onnx(result.results[0].pipeline, result.signature, "logistic_regression")
    per = build_pipeline(data, sig)
    X = pd.DataFrame({"a": [2.0, -2.0], "b": [0.0, 1.0]})
    assert per.input_mode == "per_feature" and per.predict(X).tolist() == [1, 0]


# -- canary (API-009) ---------------------------------------------------------------------------------------------------


def test_canary_split_and_step_validation():
    base = [{"model_version_id": "a", "weight": 70}, {"model_version_id": "b", "weight": 30}]
    routes = _split(base, {"model_version_id": "c"}, 25)
    assert sum(r["weight"] for r in routes) == 100 and routes[-1] == {"model_version_id": "c", "weight": 25}
    assert [r["weight"] for r in routes[:2]] == [53, 22]
    assert CanaryStart(model_version_id="x", steps=[10, 50]).steps == [10, 50, 100]
    with pytest.raises(ValueError):
        CanaryStart(model_version_id="x", steps=[50, 10])
