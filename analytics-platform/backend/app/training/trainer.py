"""Model training, AutoML, evaluation and explainability (MDL-*, TRN-009, CFG-*, EXP-*, XAI-*)."""

from __future__ import annotations

import logging
import math
import time
import warnings
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field, model_validator
from sklearn.base import clone
from sklearn.model_selection import KFold, StratifiedKFold, TimeSeriesSplit, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import LabelEncoder
from sklearn.utils.class_weight import compute_sample_weight

from ..schema.model import Schema
from . import metrics as M
from .algorithms import ALGORITHMS, CLASSIFICATION, DEFAULT_AUTOML, Algorithm, grid_space, suggest_params
from .preprocessing import (
    PreprocessingConfig,
    SafeSelectKBest,
    build_preprocessor,
    feature_selector,
    original_feature,
    resample,
    split_features,
)

log = logging.getLogger("app.training")


class SplitConfig(BaseModel):
    method: Literal["random", "stratified", "time"] = "random"
    test_size: float = Field(default=0.2, gt=0.0, lt=0.9)
    validation_size: float = Field(default=0.0, ge=0.0, lt=0.5)
    time_column: str | None = None


class CVConfig(BaseModel):
    method: Literal["kfold", "stratified_kfold", "timeseries"] = "kfold"
    folds: int = Field(default=5, ge=2, le=20)


class AutoMLConfig(BaseModel):
    enabled: bool = True
    strategy: Literal["random", "grid", "tpe"] = "tpe"
    n_trials: int = Field(default=20, ge=1, le=1000)
    timeout_seconds: int = Field(default=300, ge=5, le=24 * 3600)


class TrainingConfig(BaseModel):
    target: str
    features: list[str] | None = None
    problem_type: Literal["binary", "multiclass", "regression"] | None = None
    split: SplitConfig = Field(default_factory=SplitConfig)
    cv: CVConfig = Field(default_factory=CVConfig)
    algorithms: list[str] | None = None
    automl: AutoMLConfig = Field(default_factory=AutoMLConfig)
    hyperparameters: dict[str, dict[str, Any]] = Field(default_factory=dict)
    preprocessing: PreprocessingConfig = Field(default_factory=PreprocessingConfig)
    class_imbalance: Literal["none", "class_weight", "smote", "undersample", "oversample"] = "none"
    max_training_seconds: int = Field(default=600, ge=5, le=24 * 3600)
    seed: int = Field(default=42, ge=0, le=2**31 - 1)

    @model_validator(mode="after")
    def _check(self) -> TrainingConfig:
        for algo in self.algorithms or []:
            if algo not in ALGORITHMS:
                raise ValueError(f"unknown algorithm {algo!r}")
        if self.split.method == "time" and not self.split.time_column:
            raise ValueError("time-based split needs split.time_column")
        return self


class TrainingError(ValueError):
    pass


@dataclass
class AlgorithmResult:
    algorithm: str
    params: dict[str, Any]
    cv_score: float
    cv_std: float
    metrics: dict[str, Any]
    artifacts: dict[str, Any]
    pipeline: Pipeline
    duration_seconds: float
    trials: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class TrainingResult:
    problem_type: str
    scoring: str
    classes: list[Any] | None
    results: list[AlgorithmResult]
    best_index: int
    signature: dict[str, Any]
    warnings: list[str]
    background: pd.DataFrame


# -- problem detection (MDL-002) ----------------------------------------------------------------------


def detect_problem_type(y: pd.Series) -> tuple[str, str]:
    y = y.dropna()
    n_unique = y.nunique()
    if n_unique < 2:
        raise TrainingError("the target has fewer than two distinct values")
    if n_unique == 2:
        return "binary", "the target has exactly two distinct values"
    if pd.api.types.is_bool_dtype(y) or not pd.api.types.is_numeric_dtype(y):
        if n_unique > 100:
            raise TrainingError(f"the target is categorical with {n_unique} classes; at most 100 are supported")
        return "multiclass", f"the target is categorical with {n_unique} classes"
    integral = bool((y == y.round()).all())
    if integral and n_unique <= 20 and n_unique / len(y) < 0.05:
        return "multiclass", f"the target is integer-valued with only {n_unique} distinct values"
    return "regression", "the target is numeric with many distinct values"


def leakage_warnings(frame: pd.DataFrame, target: str, features: list[str]) -> list[str]:
    """MDL-006: features that predict the target almost perfectly are usually leaks."""
    out = []
    y = frame[target]
    y_num = y if pd.api.types.is_numeric_dtype(y) else pd.Series(pd.factorize(y)[0], index=y.index)
    for col in features:
        s = frame[col]
        if not pd.api.types.is_numeric_dtype(s) or pd.api.types.is_bool_dtype(s):
            continue
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            corr = s.corr(y_num)
        if corr is not None and not math.isnan(corr) and abs(corr) >= 0.98:
            out.append(f"{col} correlates {corr:.3f} with the target: possible target leakage")
    return out


# -- helpers ------------------------------------------------------------------------------------------


def _scoring(problem_type: str) -> str:
    return {"binary": "roc_auc", "multiclass": "f1_macro", "regression": "rmse"}[problem_type]


def _make_pipeline(pre, config: TrainingConfig, algorithm: Algorithm, params: dict[str, Any], problem_type: str) -> Pipeline:
    params = dict(params)
    if config.class_imbalance == "class_weight" and algorithm.supports_class_weight and problem_type in CLASSIFICATION:
        params["class_weight"] = "balanced"
    steps: list[tuple[str, Any]] = [("prep", clone(pre))]
    if config.preprocessing.feature_selection:
        steps.append(("select", SafeSelectKBest(feature_selector(config.preprocessing.feature_selection, problem_type, config.seed))))
    steps.append(("model", algorithm.build(problem_type, params, config.seed)))
    return Pipeline(steps)


def fit_pipeline(
    pipe: Pipeline, X: pd.DataFrame, y: np.ndarray, config: TrainingConfig, algorithm: Algorithm, problem_type: str
) -> Pipeline:
    method = config.class_imbalance if problem_type in CLASSIFICATION else "none"
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if method in ("smote", "undersample", "oversample"):
            Xt = pipe[:-1].fit_transform(X, y)
            Xr, yr = resample(np.asarray(Xt, dtype=float), y, method, config.seed)
            pipe[-1].fit(Xr, yr)
        elif method == "class_weight" and not algorithm.supports_class_weight:
            weights = compute_sample_weight("balanced", y)
            try:
                pipe.fit(X, y, model__sample_weight=weights)
            except TypeError:
                pipe.fit(X, y)
        else:
            pipe.fit(X, y)
    return pipe


def _cv_splitter(config: TrainingConfig, problem_type: str, n: int):
    folds = min(config.cv.folds, max(2, n // 10))
    if config.cv.method == "timeseries" or config.split.method == "time":
        return TimeSeriesSplit(n_splits=folds)
    if config.cv.method == "stratified_kfold" or (problem_type in CLASSIFICATION and config.cv.method == "kfold"):
        return StratifiedKFold(n_splits=folds, shuffle=True, random_state=config.seed)
    return KFold(n_splits=folds, shuffle=True, random_state=config.seed)


def _cv_score(pre, config, algorithm, params, problem_type, X, y, n_classes) -> tuple[float, float]:
    splitter = _cv_splitter(config, problem_type, len(X))
    scores = []
    for tr, va in splitter.split(X, y if problem_type in CLASSIFICATION else None):
        if problem_type in CLASSIFICATION and len(np.unique(y[tr])) < n_classes:
            continue  # a fold without every class can't be scored reliably
        pipe = fit_pipeline(
            _make_pipeline(pre, config, algorithm, params, problem_type), X.iloc[tr], y[tr], config, algorithm, problem_type
        )
        scores.append(M.score(pipe, X.iloc[va], y[va], problem_type, n_classes))
    if not scores:
        raise TrainingError("cross-validation produced no valid folds (too few rows per class?)")
    return float(np.mean(scores)), float(np.std(scores))


# -- main entry point ---------------------------------------------------------------------------------


def train(
    frame: pd.DataFrame,
    config: TrainingConfig,
    schema: Schema | None = None,
    *,
    progress: Callable[[float, str], None] | None = None,
) -> TrainingResult:
    started = time.monotonic()
    deadline = started + config.max_training_seconds
    report = progress or (lambda f, m: None)
    if config.target not in frame.columns:
        raise TrainingError(f"target column {config.target!r} not found")
    features = config.features or [c for c in frame.columns if c != config.target]
    missing = [c for c in features if c not in frame.columns]
    if missing:
        raise TrainingError(f"unknown feature columns: {missing}")
    if config.target in features:
        raise TrainingError("the target can't also be a feature")
    frame = frame[frame[config.target].notna()].reset_index(drop=True)
    if len(frame) < 20:
        raise TrainingError("need at least 20 rows with a non-missing target")

    problem_type = config.problem_type or detect_problem_type(frame[config.target])[0]
    warns = leakage_warnings(frame, config.target, features)

    classes = None
    y_raw = frame[config.target]
    if problem_type in CLASSIFICATION:
        encoder = LabelEncoder()
        y = encoder.fit_transform(y_raw.astype(str) if not pd.api.types.is_numeric_dtype(y_raw) else y_raw)
        classes = [c.item() if hasattr(c, "item") else c for c in encoder.classes_]
        if problem_type == "binary" and len(classes) != 2:
            raise TrainingError(f"binary classification needs exactly 2 classes, found {len(classes)}")
        if min(np.bincount(y)) < 2:
            raise TrainingError("every class needs at least two rows")
    else:
        if not pd.api.types.is_numeric_dtype(y_raw):
            raise TrainingError("regression needs a numeric target")
        y = y_raw.astype(float).to_numpy()
    X = frame[features]

    # -- split (MDL-004) --------------------------------------------------------------------------
    if config.split.method == "time":
        order = pd.to_datetime(frame[config.split.time_column], errors="coerce").argsort(kind="stable").to_numpy()
        X, y = X.iloc[order].reset_index(drop=True), y[order]
        cut = int(len(X) * (1 - config.split.test_size))
        X_train, X_test, y_train, y_test = X.iloc[:cut], X.iloc[cut:], y[:cut], y[cut:]
    else:
        stratify = y if (config.split.method == "stratified" or problem_type in CLASSIFICATION) else None
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=config.split.test_size, random_state=config.seed, stratify=stratify
        )
    X_val = y_val = None
    if config.split.validation_size > 0:
        X_train, X_val, y_train, y_val = train_test_split(
            X_train,
            y_train,
            test_size=config.split.validation_size / (1 - config.split.test_size),
            random_state=config.seed,
            stratify=y_train if problem_type in CLASSIFICATION else None,
        )

    schema_fields = {f.name: f for f in schema.entities[0].fields} if schema and schema.entities else {}
    groups = split_features(X_train, features, schema_fields)
    if groups["dropped"]:
        warns.append(f"excluded identifier/free-text columns: {', '.join(groups['dropped'])}")
    pre = build_preprocessor(groups, config.preprocessing, problem_type)
    n_classes = len(classes) if classes else 0

    candidates = config.algorithms or DEFAULT_AUTOML[problem_type]
    candidates = [a for a in candidates if problem_type in ALGORITHMS[a].problem_types]
    if not candidates:
        raise TrainingError(f"none of the selected algorithms supports {problem_type}")

    results: list[AlgorithmResult] = []
    for i, algo_id in enumerate(candidates):
        if time.monotonic() > deadline and results:
            warns.append(f"time budget reached; skipped {', '.join(candidates[i:])}")
            break
        algo = ALGORITHMS[algo_id]
        report(0.05 + 0.75 * i / len(candidates), f"training {algo.name}")
        t0 = time.monotonic()
        base_params = {**algo.defaults(), **config.hyperparameters.get(algo_id, {})}
        trials: list[dict[str, Any]] = []
        best_params, best_score, best_std = base_params, -math.inf, 0.0
        if config.automl.enabled:
            budget = min(config.automl.timeout_seconds / len(candidates), max(1.0, deadline - time.monotonic()))
            n_trials = max(1, math.ceil(config.automl.n_trials / len(candidates)))
            best_params, best_score, best_std, trials = _search(
                pre, config, algo, problem_type, X_train, y_train, n_classes, n_trials, budget
            )
        else:
            best_score, best_std = _cv_score(pre, config, algo, base_params, problem_type, X_train, y_train, n_classes)
            trials = [{"params": base_params, "cv_score": best_score, "cv_std": best_std}]
        final = fit_pipeline(_make_pipeline(pre, config, algo, best_params, problem_type), X_train, y_train, config, algo, problem_type)
        metrics, artifacts = M.evaluate(final, X_test, y_test, problem_type, classes)
        if X_val is not None:
            val_metrics, _ = M.evaluate(final, X_val, y_val, problem_type, classes, curves=False)
            metrics["validation"] = val_metrics
        metrics["cv_score"], metrics["cv_std"], metrics["cv_metric"] = best_score, best_std, _scoring(problem_type)
        results.append(
            AlgorithmResult(
                algorithm=algo_id,
                params=best_params,
                cv_score=best_score,
                cv_std=best_std,
                metrics=metrics,
                artifacts=artifacts,
                pipeline=final,
                duration_seconds=time.monotonic() - t0,
                trials=trials,
            )
        )

    best_index = int(np.argmax([r.cv_score for r in results]))
    best = results[best_index]
    report(0.85, f"explaining {ALGORITHMS[best.algorithm].name}")
    best.artifacts.update(explain(best.pipeline, ALGORITHMS[best.algorithm], X_train, X_test, y_test, groups, problem_type, config.seed))
    if time.monotonic() < deadline:
        best.artifacts["learning_curve"] = M.learning_curve_data(best.pipeline, X_train, y_train, problem_type, config.seed)

    signature = {
        "target": config.target,
        "problem_type": problem_type,
        "classes": classes,
        "features": [
            {
                "name": c,
                "dtype": str(X_train[c].dtype),
                "group": next((g for g, cols in groups.items() if c in cols), "dropped"),
                **(
                    {"categories": sorted(map(str, X_train[c].dropna().astype(str).unique()))[:100]}
                    if c in groups["categorical"]
                    else {"min": _num(X_train[c].min()), "max": _num(X_train[c].max())}
                    if c in groups["numeric"]
                    else {}
                ),
            }
            for c in features
        ],
    }
    report(0.95, "done")
    return TrainingResult(
        problem_type=problem_type,
        scoring=_scoring(problem_type),
        classes=classes,
        results=results,
        best_index=best_index,
        signature=signature,
        warnings=warns,
        background=X_train.sample(min(100, len(X_train)), random_state=config.seed),
    )


def _num(v):
    try:
        f = float(v)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def _search(pre, config, algo, problem_type, X, y, n_classes, n_trials, timeout):
    """AutoML hyperparameter search for one algorithm (TRN-009, CFG-003)."""
    import optuna

    optuna.logging.set_verbosity(optuna.logging.WARNING)
    if config.automl.strategy == "grid":
        sampler = optuna.samplers.GridSampler(grid_space(algo), seed=config.seed)
    elif config.automl.strategy == "random":
        sampler = optuna.samplers.RandomSampler(seed=config.seed)
    else:
        sampler = optuna.samplers.TPESampler(seed=config.seed)
    study = optuna.create_study(direction="maximize", sampler=sampler)
    defaults = {**algo.defaults(), **config.hyperparameters.get(algo.id, {})}
    # Always evaluate the defaults first so AutoML is never worse than the baseline.
    if config.automl.strategy != "grid":
        study.enqueue_trial({k: v for k, v in defaults.items() if v is not None})
    trials: list[dict[str, Any]] = []

    def objective(trial):
        params = {**defaults, **suggest_params(trial, algo)}
        mean, std = _cv_score(pre, config, algo, params, problem_type, X, y, n_classes)
        trial.set_user_attr("std", std)
        trials.append({"params": params, "cv_score": mean, "cv_std": std})
        return mean

    study.optimize(objective, n_trials=n_trials, timeout=timeout, catch=(ValueError, np.linalg.LinAlgError))
    completed = [t for t in study.trials if t.state == optuna.trial.TrialState.COMPLETE]
    if not completed:
        mean, std = _cv_score(pre, config, algo, defaults, problem_type, X, y, n_classes)
        return defaults, mean, std, [{"params": defaults, "cv_score": mean, "cv_std": std}]
    best = study.best_trial
    return {**defaults, **best.params}, best.value, best.user_attrs.get("std", 0.0), trials


# -- explainability (XAI-001, XAI-002) ----------------------------------------------------------------


def transformed_feature_names(pipe: Pipeline) -> list[str]:
    names = list(pipe.named_steps["prep"].get_feature_names_out())
    if "select" in pipe.named_steps:
        names = [n for n, keep in zip(names, pipe.named_steps["select"].get_support()) if keep]
    return names


def _transform(pipe: Pipeline, X: pd.DataFrame) -> np.ndarray:
    return np.asarray(pipe[:-1].transform(X), dtype=float)


def shap_values(
    pipe: Pipeline, algorithm: Algorithm, X: pd.DataFrame, background: pd.DataFrame, problem_type: str
) -> tuple[np.ndarray, float | None]:
    """SHAP values in transformed-feature space, shape (n, features). Multiclass: mean |value| over classes."""
    import shap

    model = pipe[-1]
    Xt = _transform(pipe, X)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if algorithm.tree_based:
            explainer = shap.TreeExplainer(model)
            values = explainer.shap_values(Xt, check_additivity=False)
            base = explainer.expected_value
        elif algorithm.linear:
            explainer = shap.LinearExplainer(model, _transform(pipe, background))
            values = explainer.shap_values(Xt)
            base = explainer.expected_value
        else:
            predict = model.predict_proba if problem_type in CLASSIFICATION else model.predict
            explainer = shap.PermutationExplainer(predict, _transform(pipe, background.head(50)))
            out = explainer(Xt[:50], max_evals=2 * Xt.shape[1] + 1, silent=True)
            values, base = out.values, out.base_values
    values = np.asarray(values)
    base_arr = np.asarray(base, dtype=float).reshape(-1)
    if values.ndim == 3:  # (n, features, classes) or (classes, n, features)
        if values.shape[0] != Xt.shape[0]:
            values = np.moveaxis(values, 0, -1)
        if problem_type == "binary" and values.shape[-1] == 2:
            values, base_value = values[..., 1], float(base_arr[-1]) if base_arr.size else None
        else:
            values, base_value = np.abs(values).mean(axis=-1), None
    elif isinstance(values, list):
        values, base_value = np.abs(np.stack(values, -1)).mean(-1), None
    else:
        base_value = float(base_arr[-1]) if base_arr.size else None
    return values, base_value


def aggregate_to_original(values: np.ndarray, names: list[str], groups: dict[str, list[str]]) -> pd.DataFrame:
    """Sum transformed-feature contributions (one-hot columns, date parts) back onto source columns."""
    frame = pd.DataFrame(values, columns=names)
    mapping = {n: original_feature(n, groups) for n in names}
    return frame.T.groupby(mapping).sum().T


def explain(pipe, algorithm, X_train, X_test, y_test, groups, problem_type, seed) -> dict[str, Any]:
    from sklearn.inspection import partial_dependence, permutation_importance

    out: dict[str, Any] = {}
    names = transformed_feature_names(pipe)
    model = pipe[-1]
    # Global importance from the model itself.
    raw = getattr(model, "feature_importances_", None)
    if raw is None and hasattr(model, "coef_"):
        coef = np.asarray(model.coef_)
        raw = np.abs(coef).mean(axis=0) if coef.ndim > 1 else np.abs(coef)
    if raw is not None and len(raw) == len(names):
        agg = aggregate_to_original(np.asarray(raw, dtype=float)[None, :], names, groups).iloc[0]
        out["feature_importance"] = [{"feature": f, "importance": float(v)} for f, v in agg.sort_values(ascending=False).items()]
    # Permutation importance on held-out data (model-agnostic).
    sample = X_test.sample(min(len(X_test), 2000), random_state=seed)
    y_sample = y_test[X_test.index.get_indexer(sample.index)] if hasattr(y_test, "__len__") else y_test
    scoring = {"binary": "roc_auc", "multiclass": "f1_macro", "regression": "neg_root_mean_squared_error"}[problem_type]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            perm = permutation_importance(pipe, sample, y_sample, scoring=scoring, n_repeats=5, random_state=seed, n_jobs=1)
            out["permutation_importance"] = sorted(
                [
                    {"feature": c, "importance": float(m), "std": float(s)}
                    for c, m, s in zip(sample.columns, perm.importances_mean, perm.importances_std)
                ],
                key=lambda d: -d["importance"],
            )
        except ValueError as exc:
            log.warning("permutation importance failed: %s", exc)
    # SHAP summary (mean |SHAP| per source feature) plus a small beeswarm sample.
    try:
        shap_sample = X_test.sample(min(len(X_test), 300), random_state=seed)
        values, base = shap_values(pipe, algorithm, shap_sample, X_train.sample(min(len(X_train), 100), random_state=seed), problem_type)
        per_feature = aggregate_to_original(values, names, groups)
        summary = per_feature.abs().mean().sort_values(ascending=False)
        out["shap_summary"] = [{"feature": f, "mean_abs_shap": float(v)} for f, v in summary.items()]
        out["shap_base_value"] = base
        top = list(summary.index[:10])
        out["shap_beeswarm"] = {
            f: {"shap": per_feature[f].head(200).round(6).tolist(), "value": [_jsonish(v) for v in shap_sample[f].head(200)]}
            for f in top
            if f in shap_sample
        }
    except Exception as exc:  # noqa: BLE001 - explanations are best-effort
        log.warning("SHAP failed: %s", exc)
        out["shap_error"] = str(exc)[:300]
    # Partial dependence for the top numeric features.
    ranked = [d["feature"] for d in out.get("permutation_importance", [])] or list(groups["numeric"])
    pdp: dict[str, Any] = {}
    pdp_sample = X_train.sample(min(len(X_train), 1000), random_state=seed).copy()
    for col in groups["numeric"]:
        pdp_sample[col] = pdp_sample[col].astype(float)  # PDP rejects integer columns
    for feature in [f for f in ranked if f in groups["numeric"]][:3]:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                res = partial_dependence(pipe, pdp_sample, [feature], grid_resolution=20, kind="average")
            avg = np.asarray(res["average"])
            pdp[feature] = {
                "grid": [float(v) for v in res["grid_values"][0]],
                "average": [float(v) for v in (avg[-1] if avg.ndim > 1 else avg)],
            }
        except Exception as exc:  # noqa: BLE001
            log.warning("PDP failed for %s: %s", feature, exc)
    out["pdp"] = pdp
    return out


def _jsonish(v):
    if isinstance(v, (np.generic,)):
        v = v.item()
    if isinstance(v, float) and math.isnan(v):
        return None
    return v if isinstance(v, (int, float, str, bool)) or v is None else str(v)
