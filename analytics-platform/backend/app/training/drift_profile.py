"""Reference profiles and population stability index for drift monitoring (API-011).

A *reference profile* summarises the training data per feature (numeric: decile bins, categorical: top-category
frequencies) plus the distribution of the model's predictions. Served requests are reduced to *tokens* (the bin a
numeric value falls into, or the category / ``__other__``) against those bins, so the drift sample never stores raw
values, and PII-tagged features (INF-009) are not profiled or logged at all.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

MISSING = "__missing__"
OTHER = "__other__"
TOP_CATEGORIES = 20
PSI_WARN = 0.1
PSI_ALERT = 0.25
EPS = 1e-4


def _numeric_profile(values: pd.Series) -> dict[str, Any]:
    s = pd.to_numeric(values, errors="coerce")
    valid = s.dropna().to_numpy(dtype=float)
    edges = np.unique(np.quantile(valid, np.linspace(0.1, 0.9, 9))) if len(valid) else np.array([])
    profile: dict[str, Any] = {"type": "numeric", "edges": [float(e) for e in edges]}
    tokens = [numeric_token(profile, v) for v in s.tolist()]
    profile["bins"] = _bins_for(profile)
    profile["expected"] = distribution(profile, tokens)
    if len(valid):
        profile["summary"] = {
            "mean": float(valid.mean()),
            "std": float(valid.std()),
            "p05": float(np.quantile(valid, 0.05)),
            "p50": float(np.quantile(valid, 0.5)),
            "p95": float(np.quantile(valid, 0.95)),
        }
    return profile


def _categorical_profile(values: pd.Series) -> dict[str, Any]:
    s = values.dropna().astype(str)
    top = [str(k) for k in s.value_counts().head(TOP_CATEGORIES).index]
    profile: dict[str, Any] = {"type": "categorical", "categories": top}
    profile["bins"] = _bins_for(profile)
    profile["expected"] = distribution(profile, [categorical_token(profile, v) for v in values.tolist()])
    return profile


def _bins_for(profile: dict[str, Any]) -> list[str]:
    if profile["type"] == "numeric":
        return [str(i) for i in range(len(profile["edges"]) + 1)] + [MISSING]
    return [*profile["categories"], OTHER, MISSING]


def _missing(v: Any) -> bool:
    return v is None or (isinstance(v, float) and math.isnan(v)) or v is pd.NA or v is pd.NaT


def numeric_token(profile: dict[str, Any], value: Any) -> str:
    if _missing(value):
        return MISSING
    try:
        f = float(value)
    except (TypeError, ValueError):
        return MISSING
    if math.isnan(f):
        return MISSING
    return str(int(np.searchsorted(np.asarray(profile["edges"], dtype=float), f, side="left")))


def categorical_token(profile: dict[str, Any], value: Any) -> str:
    if _missing(value):
        return MISSING
    text = str(value.item() if hasattr(value, "item") else value)
    if isinstance(value, float) and value.is_integer():
        text = str(int(value)) if str(int(value)) in profile["categories"] else text
    return text if text in profile["categories"] else OTHER


def token(profile: dict[str, Any], value: Any) -> str:
    return numeric_token(profile, value) if profile["type"] == "numeric" else categorical_token(profile, value)


def distribution(profile: dict[str, Any], tokens: list[str]) -> list[float]:
    bins = profile["bins"]
    counts = dict.fromkeys(bins, 0)
    for t in tokens:
        if t in counts:
            counts[t] += 1
    total = max(1, sum(counts.values()))
    return [counts[b] / total for b in bins]


def psi(expected: list[float], actual: list[float]) -> float:
    """Population stability index: Σ (a − e) · ln(a / e), with ε-smoothing of empty bins."""
    e = np.clip(np.asarray(expected, dtype=float), EPS, None)
    a = np.clip(np.asarray(actual, dtype=float), EPS, None)
    e, a = e / e.sum(), a / a.sum()
    return float(np.sum((a - e) * np.log(a / e)))


def psi_status(value: float) -> str:
    return "alert" if value >= PSI_ALERT else "warn" if value >= PSI_WARN else "ok"


def served_prediction_values(pipeline: Any, X: pd.DataFrame, signature: dict[str, Any]) -> list[Any]:
    """Predictions as the serving layer returns them (class labels, cluster ids or numbers)."""
    pred = pipeline.predict(X)
    classes = signature.get("classes")
    if classes:
        return [str(classes[int(i)]) for i in pred]
    if signature.get("problem_type") == "clustering":
        return [str(int(v)) for v in pred]
    return [float(v) for v in pred]


def prediction_profile(values: list[Any], signature: dict[str, Any]) -> dict[str, Any]:
    if signature.get("classes") or signature.get("problem_type") == "clustering":
        return _categorical_profile(pd.Series(values, dtype=object))
    return _numeric_profile(pd.Series(values, dtype=float))


def feature_profiles(X: pd.DataFrame, signature: dict[str, Any]) -> dict[str, Any]:
    """Per-feature reference distributions. PII-tagged, dropped and date features are not profiled."""
    out: dict[str, Any] = {}
    for f in signature.get("features", []):
        name = f["name"]
        if f.get("pii") or f["group"] not in ("numeric", "categorical") or name not in X:
            continue
        out[name] = _numeric_profile(X[name]) if f["group"] == "numeric" else _categorical_profile(X[name])
    return out


def build_reference(X: pd.DataFrame, signature: dict[str, Any], pipelines: list[Any], seed: int, max_rows: int = 5000) -> dict[str, Any]:
    """The reference profile of a training run: feature distributions and, per pipeline, its prediction distribution."""
    sample = X.sample(min(len(X), max_rows), random_state=seed) if len(X) > max_rows else X
    predictions = []
    for pipe in pipelines:
        try:
            predictions.append(prediction_profile(served_prediction_values(pipe, sample, signature), signature))
        except Exception:  # noqa: BLE001 - a model that can't predict on its own training rows just has no prediction profile
            predictions.append(None)
    return {"rows": int(len(sample)), "features": feature_profiles(sample, signature), "predictions": predictions}


def drift_report(reference: dict[str, Any], samples: list[dict[str, Any]]) -> dict[str, Any]:
    """Per-feature and prediction PSI of logged (tokenised) samples against a reference profile."""
    features = []
    for name, profile in (reference.get("features") or {}).items():
        tokens = [s["features"].get(name) for s in samples if s.get("features") and name in s["features"]]
        if not tokens:
            continue
        actual = distribution(profile, tokens)
        value = psi(profile["expected"], actual)
        features.append(
            {
                "feature": name,
                "type": profile["type"],
                "psi": round(value, 6),
                "status": psi_status(value),
                "bins": profile["bins"],
                "expected": [round(v, 6) for v in profile["expected"]],
                "actual": [round(v, 6) for v in actual],
                "samples": len(tokens),
            }
        )
    features.sort(key=lambda d: -d["psi"])
    prediction = None
    pred_profile = reference.get("prediction")
    tokens = [s["prediction"] for s in samples if s.get("prediction") is not None]
    if pred_profile and tokens:
        actual = distribution(pred_profile, tokens)
        value = psi(pred_profile["expected"], actual)
        prediction = {
            "psi": round(value, 6),
            "status": psi_status(value),
            "bins": pred_profile["bins"],
            "expected": [round(v, 6) for v in pred_profile["expected"]],
            "actual": [round(v, 6) for v in actual],
        }
    statuses = [f["status"] for f in features] + ([prediction["status"]] if prediction else [])
    overall = "alert" if "alert" in statuses else "warn" if "warn" in statuses else "ok"
    return {"status": overall, "features": features, "prediction": prediction}
