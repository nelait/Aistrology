"""ONNX export of trained pipelines (MDL-NFR-004, P1 part).

Eligible pipelines are those built only from operators skl2onnx (plus onnxmltools, for XGBoost and LightGBM) can
convert: numeric features with standard/min-max/robust scaling, optional PCA and feature selection, and a
scikit-learn / XGBoost / LightGBM model (including voting and stacking ensembles of those). Categorical and date
features go through custom transformers (string normalisation, date parts), so those pipelines are refused with a
reason, as are CatBoost, clustering and forecasting models.

The ONNX graph takes one ``float32 [N, 1]`` input per numeric feature (named after the column). Classifiers output
``label`` (the class *index*; the class names are in the model's ``ap.classes`` metadata) and ``probabilities``.
"""

from __future__ import annotations

import json
import warnings
from typing import Any

from sklearn.pipeline import Pipeline

from .preprocessing import CappedPCA, SafeSelectKBest


class OnnxUnsupported(ValueError):
    """The pipeline can't be expressed in ONNX; the message says why."""


_REGISTERED = False
# onnxmltools tree converters emit ai.onnx.ml v3 operators; pin both domains for broad runtime compatibility.
TARGET_OPSET = {"": 17, "ai.onnx.ml": 3}


def _register_boosters() -> list[str]:
    """Register XGBoost / LightGBM converters from onnxmltools when it is installed."""
    global _REGISTERED
    available: list[str] = []
    try:
        from onnxmltools.convert.lightgbm.operator_converters.LightGbm import convert_lightgbm
        from onnxmltools.convert.xgboost.operator_converters.XGBoost import convert_xgboost
        from skl2onnx import update_registered_converter
        from skl2onnx.common.shape_calculator import calculate_linear_classifier_output_shapes, calculate_linear_regressor_output_shapes
    except ImportError:
        return available
    if not _REGISTERED:
        import lightgbm as lgb
        import xgboost as xgb

        opts = {"nocl": [True, False], "zipmap": [True, False, "columns"]}
        update_registered_converter(
            xgb.XGBClassifier, "XGBoostXGBClassifier", calculate_linear_classifier_output_shapes, convert_xgboost, options=opts
        )
        update_registered_converter(xgb.XGBRegressor, "XGBoostXGBRegressor", calculate_linear_regressor_output_shapes, convert_xgboost)
        update_registered_converter(
            lgb.LGBMClassifier, "LightGbmLGBMClassifier", calculate_linear_classifier_output_shapes, convert_lightgbm, options=opts
        )
        update_registered_converter(lgb.LGBMRegressor, "LightGbmLGBMRegressor", calculate_linear_regressor_output_shapes, convert_lightgbm)
        _REGISTERED = True
    return ["xgboost", "lightgbm"]


def _contains_catboost(model: Any) -> bool:
    if type(model).__module__.startswith("catboost"):
        return True
    return any(_contains_catboost(est) for est in (getattr(model, "estimators_", None) or []))


def _plain(step: Any) -> Any:
    """Swap the platform's thin wrappers for the fitted scikit-learn objects inside them."""
    if isinstance(step, CappedPCA):
        return step.pca_
    if isinstance(step, SafeSelectKBest):
        return step.selector
    return step


def export_onnx(pipeline: Any, signature: dict[str, Any], algorithm: str) -> bytes:
    """Serialize an eligible pipeline to ONNX bytes, or raise :class:`OnnxUnsupported` with the reason."""
    problem = signature.get("problem_type")
    if problem in ("clustering", "forecasting", "anomaly"):
        raise OnnxUnsupported(f"{problem} models can't be exported to ONNX")
    if not isinstance(pipeline, Pipeline):
        raise OnnxUnsupported("only scikit-learn pipelines can be exported")
    if _contains_catboost(pipeline.steps[-1][1]):
        raise OnnxUnsupported("CatBoost models aren't supported by the ONNX exporter")
    groups: dict[str, list[str]] = {}
    for f in signature["features"]:
        groups.setdefault(f["group"], []).append(f["name"])
    if groups.get("text"):
        raise OnnxUnsupported("text (TF-IDF) features have no ONNX converter in this exporter")
    if groups.get("categorical") or groups.get("datetime"):
        raise OnnxUnsupported(
            "categorical and date features use custom transformers with no ONNX equivalent; "
            "only pipelines whose features are all numeric can be exported"
        )
    prep = pipeline.named_steps.get("prep")
    names = [name for name, _, _ in getattr(prep, "transformers_", [])]
    if "fe" in names:
        raise OnnxUnsupported("automatic interaction features (FE-001) have no ONNX converter")
    num = next((t for name, t, _ in prep.transformers_ if name == "num"), None) if prep is not None else None
    if num is not None and num.named_steps.get("scale").__class__.__name__ == "FunctionTransformer":
        raise OnnxUnsupported("log scaling has no ONNX converter; use standard, minmax, robust or none")
    boosters = _register_boosters()
    if algorithm in ("xgboost", "lightgbm") and algorithm not in boosters:
        raise OnnxUnsupported(f"{algorithm} needs onnxmltools for ONNX export, which isn't installed")

    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType

    plain = Pipeline([(name, _plain(step)) for name, step in pipeline.steps])
    inputs = [(c, FloatTensorType([None, 1])) for c in groups.get("numeric", [])]
    if not inputs:
        raise OnnxUnsupported("the model has no numeric inputs")
    model = plain.steps[-1][1]
    classifier = bool(signature.get("classes"))
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            try:
                onx = convert_sklearn(
                    plain, initial_types=inputs, options={id(model): {"zipmap": False}} if classifier else None, target_opset=TARGET_OPSET
                )
            except (NameError, RuntimeError, TypeError, ValueError):
                onx = convert_sklearn(plain, initial_types=inputs, target_opset=TARGET_OPSET)
    except Exception as exc:  # noqa: BLE001 - any converter gap means "unsupported"
        raise OnnxUnsupported(f"conversion failed: {type(exc).__name__}: {str(exc)[:300]}") from exc
    meta = {
        "ap.algorithm": algorithm,
        "ap.problem_type": str(problem),
        "ap.target": str(signature.get("target")),
        "ap.inputs": json.dumps([c for c, _ in inputs]),
        "ap.classes": json.dumps(signature.get("classes") or [], default=str),
    }
    for key, value in meta.items():
        prop = onx.metadata_props.add()
        prop.key, prop.value = key, value
    return onx.SerializeToString()
