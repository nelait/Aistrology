"""Anomaly detection (MDL-002b, TRN-008): Isolation Forest, One-Class SVM, Local Outlier Factor and an autoencoder.

Training is unsupervised. An optional ``target`` names a label column (1 / true / "anomaly" … = anomalous) that is
used **only for evaluation** and threshold selection; it is never a feature.

Every model is wrapped in :class:`AnomalyModel`, which exposes one convention for all algorithms:

* ``score_samples(X)`` returns an anomaly score, **higher = more anomalous**;
* ``threshold_`` is the score above which a row is flagged, chosen from the training scores by the configured
  ``contamination`` (the expected share of anomalies) or, when labels exist and ``threshold = "f1"``, the score
  that maximizes F1 on the training labels;
* ``predict(X)`` returns 1 (anomaly) / 0 (normal).

Served predictions are ``{is_anomaly, score}`` per instance (see ``ModelBundle.predict``).
"""

from __future__ import annotations

import logging
import math
import time
import warnings
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field
from sklearn.base import BaseEstimator, OutlierMixin
from sklearn.pipeline import Pipeline

from .algorithms import Algorithm, _hp

if TYPE_CHECKING:  # pragma: no cover
    from ..schema.model import Schema
    from .trainer import TrainingConfig, TrainingResult

log = logging.getLogger("app.training.anomaly")

MAX_FIT_ROWS = 5000  # One-Class SVM / LOF are quadratic-ish; the rest of the rows are only scored
POSITIVE_LABELS = {"1", "1.0", "true", "yes", "y", "anomaly", "anomalous", "outlier", "fraud", "abnormal", "attack", "bad"}


class AnomalyConfig(BaseModel):
    """TRN-008 options.

    ``contamination``: expected share of anomalies (sets the threshold); ``None`` = the label rate when labels exist,
    else 0.05. ``threshold``: ``contamination`` (score quantile) or ``f1`` (best F1 on the training labels).
    ``positive_label``: the label value meaning "anomaly" (default: 1/true/yes/anomaly/fraud/…, else the minority).
    """

    contamination: float | None = Field(default=None, gt=0.0, le=0.5)
    threshold: Literal["contamination", "f1"] = "contamination"
    positive_label: str | None = None
    max_fit_rows: int = Field(default=MAX_FIT_ROWS, ge=100, le=100_000)


class AnomalyModel(BaseEstimator, OutlierMixin):
    """An anomaly detector with a common score convention (higher = more anomalous) and a fitted threshold."""

    def __init__(
        self,
        algorithm: str = "isolation_forest",
        params: dict[str, Any] | None = None,
        seed: int = 0,
        contamination: float = 0.05,
        max_fit_rows: int = MAX_FIT_ROWS,
    ):
        self.algorithm = algorithm
        self.params = params
        self.seed = seed
        self.contamination = contamination
        self.max_fit_rows = max_fit_rows

    def fit(self, X, y=None):
        X = np.nan_to_num(np.asarray(X, dtype=float))
        p = dict(self.params or {})
        rng = np.random.default_rng(self.seed)
        self.n_features_in_ = X.shape[1]
        fit_idx = np.arange(len(X)) if len(X) <= self.max_fit_rows else np.sort(rng.choice(len(X), self.max_fit_rows, replace=False))
        Xf = X[fit_idx]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            if self.algorithm == "isolation_forest":
                from sklearn.ensemble import IsolationForest

                self.model_ = IsolationForest(
                    n_estimators=int(p.get("n_estimators", 200)),
                    max_samples=p.get("max_samples", "auto"),
                    max_features=float(p.get("max_features", 1.0)),
                    random_state=self.seed,
                    n_jobs=1,
                ).fit(Xf)
            elif self.algorithm == "one_class_svm":
                from sklearn.svm import OneClassSVM

                self.model_ = OneClassSVM(nu=float(p.get("nu", 0.05)), kernel=p.get("kernel", "rbf"), gamma=p.get("gamma", "scale")).fit(Xf)
            elif self.algorithm == "lof":
                from sklearn.neighbors import LocalOutlierFactor

                k = max(2, min(int(p.get("n_neighbors", 20)), len(Xf) - 1))
                self.model_ = LocalOutlierFactor(n_neighbors=k, novelty=True).fit(Xf)
            elif self.algorithm == "autoencoder":
                from sklearn.neural_network import MLPRegressor

                width = max(2, int(p.get("hidden_units", 16)))
                bottleneck = max(1, min(int(p.get("bottleneck", 4)), X.shape[1]))
                self.center_ = Xf.mean(axis=0)
                self.scale_ = np.where(Xf.std(axis=0) > 1e-12, Xf.std(axis=0), 1.0)
                Z = (Xf - self.center_) / self.scale_
                self.model_ = MLPRegressor(
                    hidden_layer_sizes=(width, bottleneck, width),
                    alpha=float(p.get("alpha", 1e-4)),
                    learning_rate_init=float(p.get("learning_rate_init", 1e-3)),
                    max_iter=int(p.get("max_iter", 300)),
                    early_stopping=len(Z) >= 50,
                    random_state=self.seed,
                ).fit(Z, Z)
            else:
                raise ValueError(f"unknown anomaly algorithm {self.algorithm!r}")
        train_scores = self.score_samples(X)
        self.threshold_ = float(np.quantile(train_scores, 1 - self.contamination))
        self.train_scores_ = train_scores
        return self

    def score_samples(self, X) -> np.ndarray:
        """Anomaly score; higher = more anomalous."""
        X = np.nan_to_num(np.asarray(X, dtype=float))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            if self.algorithm == "autoencoder":
                Z = (X - self.center_) / self.scale_
                return np.mean((self.model_.predict(Z) - Z) ** 2, axis=1)
            return -np.asarray(self.model_.score_samples(X), dtype=float)

    def decision_function(self, X) -> np.ndarray:
        """Score minus threshold: > 0 = anomaly."""
        return self.score_samples(X) - self.threshold_

    def predict(self, X) -> np.ndarray:
        return (self.score_samples(X) > self.threshold_).astype(int)

    def set_threshold(self, value: float) -> AnomalyModel:
        self.threshold_ = float(value)
        return self


def _build(algorithm: str) -> Callable[[str, dict[str, Any], int], AnomalyModel]:
    return lambda problem, params, seed: AnomalyModel(algorithm=algorithm, params=params, seed=seed)


ANOMALY_ALGORITHMS: dict[str, Algorithm] = {
    "isolation_forest": Algorithm(
        "isolation_forest",
        "Isolation Forest",
        "anomaly",
        ("anomaly",),
        _build("isolation_forest"),
        [
            _hp("n_estimators", "int", 200, "Number of isolation trees.", min=50, max=500, log=True),
            _hp("max_features", "float", 1.0, "Share of features drawn per tree.", min=0.3, max=1.0),
        ],
        tree_based=True,
    ),
    "one_class_svm": Algorithm(
        "one_class_svm",
        "One-Class SVM",
        "anomaly",
        ("anomaly",),
        _build("one_class_svm"),
        [
            _hp("nu", "float", 0.05, "Upper bound on the share of training outliers.", min=0.005, max=0.5, log=True),
            _hp("kernel", "categorical", "rbf", "Kernel.", choices=["rbf", "sigmoid", "linear"]),
        ],
    ),
    "lof": Algorithm(
        "lof",
        "Local Outlier Factor (novelty)",
        "anomaly",
        ("anomaly",),
        _build("lof"),
        [_hp("n_neighbors", "int", 20, "Neighbours used for the local density.", min=5, max=100, log=True)],
    ),
    "autoencoder": Algorithm(
        "autoencoder",
        "Autoencoder (MLP reconstruction error)",
        "anomaly",
        ("anomaly",),
        _build("autoencoder"),
        [
            _hp("hidden_units", "int", 16, "Units in the outer hidden layers.", min=4, max=128, log=True),
            _hp("bottleneck", "int", 4, "Units in the bottleneck layer.", min=1, max=32),
            _hp("alpha", "float", 1e-4, "L2 regularization.", min=1e-6, max=1e-1, log=True),
        ],
    ),
}
DEFAULT_ANOMALY = ["isolation_forest", "lof", "one_class_svm", "autoencoder"]


# -- labels and metrics -------------------------------------------------------------------------------------------


def encode_labels(y: pd.Series, positive_label: str | None = None) -> tuple[np.ndarray, str]:
    """Labels → 1 (anomaly) / 0 (normal). Returns the codes and the label value treated as anomalous."""
    values = y.astype(str).str.strip()
    distinct = sorted(values.unique())
    if len(distinct) != 2:
        raise ValueError(f"the anomaly label column must have exactly two distinct values, found {len(distinct)}")
    if positive_label is not None:
        if str(positive_label) not in distinct:
            raise ValueError(f"positive_label {positive_label!r} is not a value of the label column")
        positive = str(positive_label)
    else:
        known = [v for v in distinct if v.lower() in POSITIVE_LABELS]
        positive = known[0] if len(known) == 1 else values.value_counts().index[-1]  # else: the minority value
    return (values == positive).to_numpy(dtype=int), positive


def _f(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else round(f, 6)


def f1_threshold(scores: np.ndarray, labels: np.ndarray) -> float:
    """The score threshold that maximizes F1 of ``score > threshold`` on labelled data."""
    from sklearn.metrics import precision_recall_curve

    precision, recall, thresholds = precision_recall_curve(labels, scores)
    f1 = 2 * precision * recall / np.maximum(precision + recall, 1e-12)
    best = int(np.argmax(f1[:-1])) if len(thresholds) else 0
    # precision_recall_curve flags score >= t; our rule is score > threshold, so step just below it.
    return float(np.nextafter(thresholds[best], -np.inf)) if len(thresholds) else float(np.median(scores))


def anomaly_metrics(scores: np.ndarray, threshold: float, labels: np.ndarray | None) -> tuple[dict[str, Any], dict[str, Any]]:
    """Metrics and plot data for scores on held-out rows. Label-based metrics only when labels exist."""
    from sklearn import metrics as skm

    flagged = (scores > threshold).astype(int)
    metrics: dict[str, Any] = {
        "n_test": int(len(scores)),
        "threshold": _f(threshold),
        "anomaly_rate": _f(flagged.mean()) if len(flagged) else 0.0,
        "score_mean": _f(scores.mean()) if len(scores) else None,
        "score_p95": _f(np.quantile(scores, 0.95)) if len(scores) else None,
    }
    edges = np.histogram_bin_edges(scores, bins=30) if len(scores) else np.array([0.0, 1.0])
    distribution: dict[str, Any] = {"edges": [float(e) for e in edges], "counts": np.histogram(scores, bins=edges)[0].tolist()}
    artifacts: dict[str, Any] = {"score_distribution": distribution, "threshold": _f(threshold)}
    if labels is not None and len(labels) and 0 < labels.sum() < len(labels):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            metrics.update(
                precision=_f(skm.precision_score(labels, flagged, zero_division=0)),
                recall=_f(skm.recall_score(labels, flagged, zero_division=0)),
                f1=_f(skm.f1_score(labels, flagged, zero_division=0)),
                roc_auc=_f(skm.roc_auc_score(labels, scores)),
                pr_auc=_f(skm.average_precision_score(labels, scores)),
                label_rate=_f(labels.mean()),
            )
            fpr, tpr, _ = skm.roc_curve(labels, scores)
            prec, rec, _ = skm.precision_recall_curve(labels, scores)
        idx = np.linspace(0, len(fpr) - 1, min(len(fpr), 200)).astype(int)
        artifacts["roc_curve"] = {"fpr": [float(v) for v in fpr[idx]], "tpr": [float(v) for v in tpr[idx]]}
        idx = np.linspace(0, len(prec) - 1, min(len(prec), 200)).astype(int)
        artifacts["pr_curve"] = {"precision": [float(v) for v in prec[idx]], "recall": [float(v) for v in rec[idx]]}
        artifacts["confusion_matrix"] = {
            "labels": ["normal", "anomaly"],
            "matrix": skm.confusion_matrix(labels, flagged, labels=[0, 1]).tolist(),
        }
        distribution["counts_normal"] = np.histogram(scores[labels == 0], bins=edges)[0].tolist()
        distribution["counts_anomaly"] = np.histogram(scores[labels == 1], bins=edges)[0].tolist()
    return metrics, artifacts


def feature_deviation(X: pd.DataFrame, numeric: list[str], flagged: np.ndarray) -> list[dict[str, Any]]:
    """Which numeric features set the flagged rows apart: standardized mean difference, flagged vs normal."""
    out = []
    if flagged.sum() == 0 or flagged.sum() == len(flagged):
        return out
    for col in numeric:
        s = pd.to_numeric(X[col], errors="coerce").to_numpy(dtype=float)
        std = np.nanstd(s)
        if not std or math.isnan(std):
            continue
        diff = (np.nanmean(s[flagged == 1]) - np.nanmean(s[flagged == 0])) / std
        if not math.isnan(diff):
            out.append({"feature": col, "importance": round(abs(float(diff)), 6), "direction": "higher" if diff > 0 else "lower"})
    return sorted(out, key=lambda d: -d["importance"])


def _consensus(scores: dict[str, np.ndarray]) -> dict[str, float]:
    """Unlabelled model selection: Spearman correlation of each model's scores with the mean rank of all models."""
    if len(scores) < 2:
        return dict.fromkeys(scores, 0.0)
    ranks = {k: pd.Series(v).rank(pct=True).to_numpy() for k, v in scores.items()}
    mean_rank = np.mean(list(ranks.values()), axis=0)
    out = {}
    for k, r in ranks.items():
        c = np.corrcoef(r, mean_rank)[0, 1]
        out[k] = 0.0 if math.isnan(c) else float(c)
    return out


# -- training -------------------------------------------------------------------------------------------------------


def train_anomaly(
    frame: pd.DataFrame, config: TrainingConfig, schema: Schema | None = None, *, progress: Callable[[float, str], None] | None = None
) -> TrainingResult:
    from sklearn.model_selection import train_test_split

    from .preprocessing import build_preprocessor, split_features
    from .trainer import AlgorithmResult, TrainingError, TrainingResult, _pca, feature_signature, reference_profile

    started = time.monotonic()
    deadline = started + config.max_training_seconds
    report = progress or (lambda f, m: None)
    cfg = config.anomaly or AnomalyConfig()
    label_col = config.target
    if label_col and label_col not in frame.columns:
        raise TrainingError(f"label column {label_col!r} not found")
    features = config.features or [c for c in frame.columns if c != label_col]
    missing = [c for c in features if c not in frame.columns]
    if missing:
        raise TrainingError(f"unknown feature columns: {missing}")
    if label_col and label_col in features:
        raise TrainingError("the label column is used for evaluation only and can't also be a feature")
    frame = frame.reset_index(drop=True)
    labels: np.ndarray | None = None
    positive = None
    warns: list[str] = []
    if label_col:
        frame = frame[frame[label_col].notna()].reset_index(drop=True)
        try:
            labels, positive = encode_labels(frame[label_col], cfg.positive_label)
        except ValueError as exc:
            raise TrainingError(str(exc)) from exc
    if len(frame) < 20:
        raise TrainingError("anomaly detection needs at least 20 rows")
    if cfg.threshold == "f1" and labels is None:
        raise TrainingError('threshold = "f1" needs a label column (target)')
    X = frame[features]
    idx = np.arange(len(X))
    stratify = labels if labels is not None and labels.sum() >= 2 else None
    tr, te = train_test_split(idx, test_size=config.split.test_size, random_state=config.seed, stratify=stratify)
    tr, te = np.sort(tr), np.sort(te)
    X_train, X_test = X.iloc[tr], X.iloc[te]
    y_train = labels[tr] if labels is not None else None
    y_test = labels[te] if labels is not None else None
    contamination = cfg.contamination or (float(np.clip(y_train.mean(), 0.001, 0.5)) if y_train is not None else 0.05)

    schema_fields = {f.name: f for f in schema.entities[0].fields} if schema and schema.entities else {}
    groups = split_features(X_train, features, schema_fields, text=config.preprocessing.text)
    if groups["dropped"]:
        warns.append(f"excluded identifier/free-text columns: {', '.join(groups['dropped'])}")
    pre = build_preprocessor(groups, config.preprocessing, "clustering")
    steps: list[tuple[str, Any]] = [("prep", pre)]
    if config.preprocessing.pca:
        steps.append(("pca", _pca(config)))
    prep = Pipeline(steps)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        Xt_train = np.nan_to_num(np.asarray(prep.fit_transform(X_train), dtype=float))
        Xt_test = np.nan_to_num(np.asarray(prep.transform(X_test), dtype=float))

    candidates = [a for a in (config.algorithms or DEFAULT_ANOMALY) if a in ANOMALY_ALGORITHMS]
    if not candidates:
        raise TrainingError("none of the selected algorithms supports anomaly detection")
    if config.automl.enabled and labels is None:
        warns.append("no label column: hyperparameters were not tuned (there is nothing to score them against)")
    fitted: list[tuple[str, dict[str, Any], AnomalyModel, list[dict[str, Any]], float]] = []
    for i, algo_id in enumerate(candidates):
        if time.monotonic() > deadline and fitted:
            warns.append(f"time budget reached; skipped {', '.join(candidates[i:])}")
            break
        algo = ANOMALY_ALGORITHMS[algo_id]
        report(0.05 + 0.8 * i / len(candidates), f"training {algo.name}")
        t0 = time.monotonic()
        base = {**algo.defaults(), **config.hyperparameters.get(algo_id, {})}
        trials: list[dict[str, Any]] = []
        best: tuple[float, dict[str, Any]] | None = None
        param_sets = [base]
        if config.automl.enabled and labels is not None:
            param_sets += _random_params(algo, base, max(0, math.ceil(config.automl.n_trials / len(candidates)) - 1), config.seed + i)
        for params in param_sets:
            if trials and time.monotonic() > deadline:
                break
            try:
                score = _validation_score(algo_id, params, Xt_train, y_train, contamination, cfg, config.seed)
            except (ValueError, np.linalg.LinAlgError) as exc:
                trials.append({"params": params, "error": str(exc)[:200]})
                continue
            trials.append({"params": params, "cv_score": score})
            if best is None or (score if score is not None else -math.inf) > (best[0] if best[0] is not None else -math.inf):
                best = (score, params)
        if best is None:
            warns.append(f"{algo.name} failed on every candidate")
            continue
        try:
            model = AnomalyModel(algo_id, best[1], config.seed, contamination, cfg.max_fit_rows).fit(Xt_train)
        except (ValueError, np.linalg.LinAlgError) as exc:
            warns.append(f"{algo.name} failed: {str(exc)[:200]}")
            continue
        if cfg.threshold == "f1" and y_train is not None and 0 < y_train.sum() < len(y_train):
            model.set_threshold(f1_threshold(model.train_scores_, y_train))
        fitted.append((algo_id, best[1], model, trials, time.monotonic() - t0))
    if not fitted:
        raise TrainingError("no anomaly detector could be trained")

    test_scores = {algo_id: model.score_samples(Xt_test) for algo_id, _, model, _, _ in fitted}
    consensus = _consensus(test_scores)
    results: list[AlgorithmResult] = []
    for algo_id, params, model, trials, seconds in fitted:
        scores = test_scores[algo_id]
        metrics, artifacts = anomaly_metrics(scores, model.threshold_, y_test)
        flagged = (scores > model.threshold_).astype(int)
        if labels is not None and metrics.get("pr_auc") is not None:
            selection, metric_name = float(metrics["pr_auc"]), "pr_auc"
        else:
            selection, metric_name = consensus[algo_id], "consensus"
        metrics.update(contamination=_f(contamination), cv_score=_f(selection), cv_std=0.0, cv_metric=metric_name)
        artifacts["feature_importance"] = feature_deviation(X_test, groups["numeric"], flagged)
        order = np.argsort(-scores)[:20]
        artifacts["top_anomalies"] = [{"row": int(te[j]), "score": _f(scores[j])} for j in order]
        artifacts["positive_label"] = positive
        results.append(
            AlgorithmResult(
                algorithm=algo_id,
                params=params,
                cv_score=selection,
                cv_std=0.0,
                metrics=metrics,
                artifacts=artifacts,
                pipeline=Pipeline([*prep.steps, ("model", model)]),
                duration_seconds=seconds,
                trials=trials,
            )
        )
    best_index = int(np.argmax([r.cv_score for r in results]))
    signature = {
        "target": None,
        "label_column": label_col,
        "positive_label": positive,
        "problem_type": "anomaly",
        "classes": None,
        "features": feature_signature(X_train, features, groups, schema_fields),
    }
    report(0.95, "done")
    return TrainingResult(
        problem_type="anomaly",
        scoring=results[best_index].metrics["cv_metric"],
        classes=None,
        results=results,
        best_index=best_index,
        signature=signature,
        warnings=warns,
        background=X_train.sample(min(100, len(X_train)), random_state=config.seed),
        reference=reference_profile(X_train, signature, [r.pipeline for r in results], config.seed),
    )


def _random_params(algo: Algorithm, base: dict[str, Any], n: int, seed: int) -> list[dict[str, Any]]:
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n):
        params = dict(base)
        for hp in algo.hyperparameters:
            if hp.type == "categorical":
                params[hp.name] = hp.choices[int(rng.integers(len(hp.choices)))]
            elif hp.log and hp.min and hp.min > 0:
                v = float(np.exp(rng.uniform(np.log(hp.min), np.log(hp.max))))
                params[hp.name] = int(round(v)) if hp.type == "int" else v
            else:
                v = float(rng.uniform(hp.min, hp.max))
                params[hp.name] = int(round(v)) if hp.type == "int" else v
        out.append(params)
    return out


def _validation_score(
    algo_id: str, params: dict[str, Any], Xt: np.ndarray, y: np.ndarray | None, contamination: float, cfg: AnomalyConfig, seed: int
) -> float | None:
    """PR-AUC on a validation part of the training rows (labels only); ``None`` without labels."""
    if y is None or y.sum() < 2:
        return None
    from sklearn.metrics import average_precision_score
    from sklearn.model_selection import train_test_split

    tr, va = train_test_split(np.arange(len(Xt)), test_size=0.25, random_state=seed, stratify=y)
    if y[va].sum() == 0:
        return None
    model = AnomalyModel(algo_id, params, seed, contamination, cfg.max_fit_rows).fit(Xt[tr])
    return float(average_precision_score(y[va], model.score_samples(Xt[va])))
