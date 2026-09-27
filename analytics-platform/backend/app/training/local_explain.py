"""Local explanations beyond SHAP values (XAI-002a): a LIME-style weighted linear surrogate and SHAP force-plot data.

The surrogate is implemented here rather than with the ``lime`` package. For one instance it draws perturbations that
keep each feature's own value with probability ½ and otherwise borrow the value from a random background (training)
row, so it works the same way for numeric, categorical and date features. A ridge regression on the binary
"kept the instance's value" indicators, weighted by an exponential kernel on the share of features replaced, gives
each feature's local effect: how much the instance's actual value moves the prediction compared with typical values.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import numpy as np
import pandas as pd

from ..export_utils import jsonable

LIME_SAMPLES = 400
LIME_MAX_INSTANCES = 10


def lime_explain(
    instance: dict[str, Any],
    background: pd.DataFrame,
    features: list[str],
    predict: Callable[[list[dict[str, Any]]], np.ndarray],
    *,
    n_samples: int = LIME_SAMPLES,
    kernel_width: float = 0.75,
    seed: int = 0,
) -> dict[str, Any]:
    """Fit a weighted linear surrogate around ``instance``. ``predict`` maps rows (dicts) to the scalar model output."""
    from sklearn.linear_model import Ridge

    rng = np.random.default_rng(seed)
    p = len(features)
    if p == 0 or background.empty:
        raise ValueError("no features or background data to perturb")
    keep = rng.random((n_samples, p)) < 0.5
    keep[0] = True  # the instance itself
    donors = background.iloc[rng.integers(0, len(background), n_samples)].to_dict(orient="records")
    rows = []
    for i in range(n_samples):
        row = {}
        for j, f in enumerate(features):
            row[f] = instance.get(f) if keep[i, j] else jsonable(donors[i].get(f))
        rows.append(row)
    y = np.asarray(predict(rows), dtype=float)
    Z = keep.astype(float)
    distance = np.sqrt((p - Z.sum(axis=1)) / p)
    weights = np.exp(-(distance**2) / kernel_width**2)
    model = Ridge(alpha=1.0).fit(Z, y, sample_weight=weights)
    local = float(model.predict(np.ones((1, p)))[0])
    return {
        "prediction": float(y[0]),
        "local_prediction": round(local, 6),
        "intercept": round(float(model.intercept_), 6),
        "r2": round(float(model.score(Z, y, sample_weight=weights)), 6),
        "weights": sorted(
            ({"feature": f, "value": jsonable(instance.get(f)), "weight": round(float(w), 6)} for f, w in zip(features, model.coef_)),
            key=lambda d: -abs(d["weight"]),
        ),
    }


def force_plot(base_value: float | None, contributions: dict[str, float], instance: dict[str, Any]) -> dict[str, Any]:
    """XAI-002a SHAP force-plot data: base value, output value and contributions ordered by magnitude.

    Values are in the explainer's output space (probability, log-odds or the regression unit, depending on the model).
    """
    ordered = sorted(contributions.items(), key=lambda kv: -abs(kv[1]))
    total = float(sum(contributions.values()))
    return {
        "base_value": base_value,
        "output_value": round(base_value + total, 6) if base_value is not None else None,
        "features": [
            {"feature": f, "value": jsonable(instance.get(f)), "shap": round(float(v), 6), "direction": "up" if v >= 0 else "down"}
            for f, v in ordered
        ],
    }
