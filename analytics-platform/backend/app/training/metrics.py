"""Evaluation metrics and plot data (EXP-002, EXP-003, EXP-006)."""

from __future__ import annotations

import math
import warnings
from typing import Any

import numpy as np
from sklearn import metrics as skm
from sklearn.calibration import calibration_curve
from sklearn.model_selection import learning_curve


def _f(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else round(f, 6)


def _downsample(xs: np.ndarray, ys: np.ndarray, n: int = 200) -> tuple[list[float], list[float]]:
    if len(xs) > n:
        idx = np.linspace(0, len(xs) - 1, n).astype(int)
        xs, ys = xs[idx], ys[idx]
    return [float(x) for x in xs], [float(y) for y in ys]


def score(pipe, X, y, problem_type: str, n_classes: int) -> float:
    """Selection score, higher is better: ROC-AUC (binary), macro-F1 (multiclass), −RMSE (regression)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if problem_type == "binary":
            if hasattr(pipe, "predict_proba") and len(np.unique(y)) == 2:
                return float(skm.roc_auc_score(y, pipe.predict_proba(X)[:, 1]))
            return float(skm.f1_score(y, pipe.predict(X)))
        if problem_type == "multiclass":
            return float(skm.f1_score(y, pipe.predict(X), average="macro"))
        return -float(math.sqrt(skm.mean_squared_error(y, pipe.predict(X))))


def evaluate(pipe, X, y, problem_type: str, classes: list[Any] | None, *, curves: bool = True) -> tuple[dict[str, Any], dict[str, Any]]:
    metrics: dict[str, Any] = {"n_test": int(len(y))}
    artifacts: dict[str, Any] = {}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        pred = pipe.predict(X)
        if problem_type in ("binary", "multiclass"):
            proba = pipe.predict_proba(X) if hasattr(pipe, "predict_proba") else None
            avg = "binary" if problem_type == "binary" else "macro"
            metrics.update(
                accuracy=_f(skm.accuracy_score(y, pred)),
                precision=_f(skm.precision_score(y, pred, average=avg, zero_division=0)),
                recall=_f(skm.recall_score(y, pred, average=avg, zero_division=0)),
                f1=_f(skm.f1_score(y, pred, average=avg, zero_division=0)),
                balanced_accuracy=_f(skm.balanced_accuracy_score(y, pred)),
            )
            labels = list(range(len(classes or [])))
            if proba is not None and len(np.unique(y)) > 1:
                try:
                    if problem_type == "binary":
                        metrics["roc_auc"] = _f(skm.roc_auc_score(y, proba[:, 1]))
                        metrics["pr_auc"] = _f(skm.average_precision_score(y, proba[:, 1]))
                    else:
                        metrics["roc_auc"] = _f(skm.roc_auc_score(y, proba, multi_class="ovr", labels=labels))
                    metrics["log_loss"] = _f(skm.log_loss(y, proba, labels=labels))
                except ValueError:
                    pass
            if curves:
                cm = skm.confusion_matrix(y, pred, labels=labels)
                artifacts["confusion_matrix"] = {"labels": [str(c) for c in classes or []], "matrix": cm.tolist()}
                artifacts["classification_report"] = skm.classification_report(
                    y, pred, labels=labels, target_names=[str(c) for c in classes or []], output_dict=True, zero_division=0
                )
                if proba is not None and problem_type == "binary" and len(np.unique(y)) == 2:
                    fpr, tpr, _ = skm.roc_curve(y, proba[:, 1])
                    artifacts["roc_curve"] = dict(zip(("fpr", "tpr"), _downsample(fpr, tpr)))
                    precision, recall, _ = skm.precision_recall_curve(y, proba[:, 1])
                    artifacts["pr_curve"] = dict(zip(("recall", "precision"), _downsample(recall, precision)))
                    prob_true, prob_pred = calibration_curve(y, proba[:, 1], n_bins=10, strategy="quantile")
                    artifacts["calibration"] = {"prob_pred": prob_pred.tolist(), "prob_true": prob_true.tolist()}
        else:
            y = np.asarray(y, dtype=float)
            mse = skm.mean_squared_error(y, pred)
            n, p = len(y), _n_features(pipe)
            r2 = skm.r2_score(y, pred)
            nonzero = np.abs(y) > 1e-12
            metrics.update(
                mae=_f(skm.mean_absolute_error(y, pred)),
                mse=_f(mse),
                rmse=_f(math.sqrt(mse)),
                r2=_f(r2),
                adjusted_r2=_f(1 - (1 - r2) * (n - 1) / (n - p - 1)) if n - p - 1 > 0 else None,
                mape=_f(np.mean(np.abs((y[nonzero] - pred[nonzero]) / y[nonzero])) * 100) if nonzero.any() else None,
            )
            if curves:
                idx = np.linspace(0, n - 1, min(n, 500)).astype(int)
                artifacts["residuals"] = {"predicted": [float(v) for v in pred[idx]], "residual": [float(v) for v in (y - pred)[idx]]}
    return metrics, artifacts


def _n_features(pipe) -> int:
    try:
        return len(pipe[:-1].get_feature_names_out())
    except Exception:  # noqa: BLE001 - adjusted R² is best-effort
        return 1


def learning_curve_data(pipe, X, y, problem_type: str, seed: int) -> dict[str, Any] | None:
    scoring = {"binary": "roc_auc", "multiclass": "f1_macro", "regression": "neg_root_mean_squared_error"}[problem_type]
    n = min(len(X), 5000)
    Xs = X.sample(n, random_state=seed)
    ys = y[X.index.get_indexer(Xs.index)]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            sizes, train_scores, val_scores = learning_curve(
                pipe, Xs, ys, cv=3, train_sizes=np.linspace(0.2, 1.0, 4), scoring=scoring, random_state=seed, shuffle=True
            )
    except ValueError:
        return None
    return {
        "metric": scoring,
        "train_sizes": sizes.tolist(),
        "train_scores": [float(v) for v in train_scores.mean(axis=1)],
        "val_scores": [float(v) for v in val_scores.mean(axis=1)],
    }
