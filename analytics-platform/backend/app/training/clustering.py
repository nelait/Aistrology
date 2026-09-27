"""Clustering (MDL-002a, TRN-006, EXP-005): K-Means, DBSCAN, agglomerative (hierarchical) and Gaussian mixtures.

There is no target. Features go through the same preprocessing as supervised models (FE-001/002/003/005), then
AutoML searches the number of clusters (or DBSCAN's ``eps``) per algorithm, scoring candidates by silhouette.
Every model is wrapped in :class:`ClusterModel`, which can assign *new* points to clusters so it can be served:
agglomerative clustering uses the nearest cluster centroid, DBSCAN the label of the nearest core point (``-1`` =
noise when that point is farther than ``eps``).
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
from sklearn.base import BaseEstimator, ClusterMixin
from sklearn.pipeline import Pipeline

from .algorithms import Algorithm, _hp

if TYPE_CHECKING:  # pragma: no cover
    from ..schema.model import Schema
    from .trainer import TrainingConfig, TrainingResult

log = logging.getLogger("app.training.clustering")

ClusterAlgorithm = Literal["kmeans", "dbscan", "agglomerative", "gmm"]
MAX_FIT_ROWS = 5000  # agglomerative / DBSCAN memory bound; the rest is assigned with ``predict``
METRIC_SAMPLE = 2000


class ClusteringConfig(BaseModel):
    """TRN-006 options. ``k_min``/``k_max`` bound the AutoML search over the number of clusters."""

    k_min: int = Field(default=2, ge=2, le=50)
    k_max: int = Field(default=8, ge=2, le=50)
    max_fit_rows: int = Field(default=MAX_FIT_ROWS, ge=100, le=100_000)


class ClusterModel(BaseEstimator, ClusterMixin):
    """A clustering algorithm that can also label unseen rows (for serving)."""

    def __init__(self, algorithm: str = "kmeans", params: dict[str, Any] | None = None, seed: int = 0, max_fit_rows: int = MAX_FIT_ROWS):
        self.algorithm = algorithm
        self.params = params
        self.seed = seed
        self.max_fit_rows = max_fit_rows

    def fit(self, X, y=None):
        from sklearn.cluster import DBSCAN, AgglomerativeClustering, KMeans
        from sklearn.mixture import GaussianMixture

        X = np.asarray(X, dtype=float)
        p = dict(self.params or {})
        rng = np.random.default_rng(self.seed)
        self.n_features_in_ = X.shape[1]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            if self.algorithm == "kmeans":
                self.model_ = KMeans(n_clusters=int(p.get("n_clusters", 3)), n_init=int(p.get("n_init", 10)), random_state=self.seed).fit(X)
                self.labels_ = self.model_.labels_
            elif self.algorithm == "gmm":
                self.model_ = GaussianMixture(
                    n_components=int(p.get("n_components", 3)),
                    covariance_type=p.get("covariance_type", "full"),
                    reg_covar=1e-5,
                    random_state=self.seed,
                ).fit(X)
                self.labels_ = self.model_.predict(X)
            elif self.algorithm in ("agglomerative", "dbscan"):
                fit_idx = (
                    np.arange(len(X)) if len(X) <= self.max_fit_rows else np.sort(rng.choice(len(X), self.max_fit_rows, replace=False))
                )
                Xf = X[fit_idx]
                if self.algorithm == "agglomerative":
                    model = AgglomerativeClustering(n_clusters=int(p.get("n_clusters", 3)), linkage=p.get("linkage", "ward")).fit(Xf)
                    labels = model.labels_
                    self.centroids_ = np.vstack([Xf[labels == c].mean(axis=0) for c in range(labels.max() + 1)])
                else:
                    self.eps_ = float(p.get("eps") or _default_eps(Xf, int(p.get("min_samples", 5))))
                    model = DBSCAN(eps=self.eps_, min_samples=int(p.get("min_samples", 5))).fit(Xf)
                    labels = model.labels_
                    core = model.core_sample_indices_
                    self.core_points_ = Xf[core]
                    self.core_labels_ = labels[core]
                self.labels_ = labels if len(fit_idx) == len(X) else self.predict(X)
            else:
                raise ValueError(f"unknown clustering algorithm {self.algorithm!r}")
        return self

    def predict(self, X):
        from sklearn.metrics import pairwise_distances_argmin_min

        X = np.asarray(X, dtype=float)
        if self.algorithm in ("kmeans", "gmm"):
            return self.model_.predict(X)
        if self.algorithm == "agglomerative":
            return pairwise_distances_argmin_min(X, self.centroids_)[0]
        if len(self.core_points_) == 0:
            return np.full(len(X), -1)
        nearest, dist = pairwise_distances_argmin_min(X, self.core_points_)
        return np.where(dist <= self.eps_, self.core_labels_[nearest], -1)

    def fit_predict(self, X, y=None):
        return self.fit(X).labels_


def _default_eps(X: np.ndarray, min_samples: int) -> float:
    return float(np.quantile(_kth_distances(X, min_samples), 0.9))


def _kth_distances(X: np.ndarray, k: int) -> np.ndarray:
    from sklearn.neighbors import NearestNeighbors

    k = max(2, min(k, len(X) - 1))
    dist, _ = NearestNeighbors(n_neighbors=k).fit(X).kneighbors(X)
    return dist[:, -1]


def _build(problem: str, params: dict[str, Any], seed: int, algorithm: str = "kmeans") -> ClusterModel:
    return ClusterModel(algorithm=algorithm, params=params, seed=seed)


CLUSTERING_ALGORITHMS: dict[str, Algorithm] = {
    "kmeans": Algorithm(
        "kmeans",
        "K-Means",
        "clustering",
        ("clustering",),
        lambda pr, p, s: _build(pr, p, s, "kmeans"),
        [_hp("n_clusters", "int", 3, "Number of clusters (AutoML searches k_min…k_max).", min=2, max=50)],
    ),
    "dbscan": Algorithm(
        "dbscan",
        "DBSCAN (density-based)",
        "clustering",
        ("clustering",),
        lambda pr, p, s: _build(pr, p, s, "dbscan"),
        [
            _hp(
                "eps",
                "float",
                None,
                "Neighbourhood radius. Empty = derived from the k-distance curve; AutoML searches it.",
                min=1e-3,
                max=100,
                log=True,
            ),
            _hp("min_samples", "int", 5, "Points needed within eps to form a dense core.", min=2, max=100, log=True),
        ],
    ),
    "agglomerative": Algorithm(
        "agglomerative",
        "Hierarchical (agglomerative) clustering",
        "clustering",
        ("clustering",),
        lambda pr, p, s: _build(pr, p, s, "agglomerative"),
        [
            _hp("n_clusters", "int", 3, "Number of clusters to cut the dendrogram into.", min=2, max=50),
            _hp(
                "linkage",
                "categorical",
                "ward",
                "How cluster distance is measured: ward (variance), complete (max), average (mean).",
                choices=["ward", "complete", "average"],
            ),
        ],
    ),
    "gmm": Algorithm(
        "gmm",
        "Gaussian Mixture Model",
        "clustering",
        ("clustering",),
        lambda pr, p, s: _build(pr, p, s, "gmm"),
        [
            _hp("n_components", "int", 3, "Number of Gaussian components (clusters).", min=2, max=50),
            _hp(
                "covariance_type",
                "categorical",
                "full",
                "Shape of each component: full, diag, tied or spherical.",
                choices=["full", "diag", "tied", "spherical"],
            ),
        ],
    ),
}
DEFAULT_CLUSTERING = ["kmeans", "gmm", "agglomerative", "dbscan"]
_K_PARAM = {"kmeans": "n_clusters", "agglomerative": "n_clusters", "gmm": "n_components"}


# -- metrics (EXP-005) ------------------------------------------------------------------------------------


def cluster_metrics(X: np.ndarray, labels: np.ndarray, seed: int = 0) -> dict[str, Any]:
    """Silhouette (sampled), Calinski-Harabasz and Davies-Bouldin on non-noise points."""
    from sklearn import metrics as skm

    labels = np.asarray(labels)
    mask = labels != -1
    clusters = np.unique(labels[mask])
    out: dict[str, Any] = {
        "n_clusters": int(len(clusters)),
        "noise_fraction": round(float(1 - mask.mean()), 6) if len(labels) else 0.0,
        "n_rows": int(len(labels)),
    }
    if len(clusters) < 2 or mask.sum() <= len(clusters):
        out.update(silhouette=None, calinski_harabasz=None, davies_bouldin=None)
        return out
    Xm, lm = X[mask], labels[mask]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        out["silhouette"] = round(float(skm.silhouette_score(Xm, lm, sample_size=min(len(Xm), METRIC_SAMPLE), random_state=seed)), 6)
        out["calinski_harabasz"] = round(float(skm.calinski_harabasz_score(Xm, lm)), 6)
        out["davies_bouldin"] = round(float(skm.davies_bouldin_score(Xm, lm)), 6)
    return out


def _selection_score(m: dict[str, Any]) -> float:
    """Silhouette, discounted by the share of points DBSCAN leaves as noise."""
    if m.get("silhouette") is None:
        return -math.inf
    return float(m["silhouette"]) * (1 - float(m.get("noise_fraction") or 0))


def _candidates(algo_id: str, cfg: ClusteringConfig, base: dict[str, Any], Xt: np.ndarray, automl: bool, n_rows: int) -> list[dict]:
    """The AutoML search space: every k in k_min…k_max, or DBSCAN eps from the k-distance curve."""
    if not automl:
        return [base]
    k_hi = min(cfg.k_max, max(cfg.k_min, n_rows - 1))
    if algo_id in _K_PARAM:
        return [{**base, _K_PARAM[algo_id]: k} for k in range(cfg.k_min, k_hi + 1)]
    # DBSCAN: eps at quantiles of the distance to the min_samples-th neighbour.
    sample = Xt if len(Xt) <= 2000 else Xt[np.random.default_rng(0).choice(len(Xt), 2000, replace=False)]
    kd = _kth_distances(sample, int(base.get("min_samples") or 5))
    eps_values = sorted({round(float(v), 6) for v in np.quantile(kd, [0.5, 0.65, 0.8, 0.9, 0.95]) if v > 0})
    return [{**base, "eps": e} for e in eps_values] or [base]


# -- artifacts ---------------------------------------------------------------------------------------------


def _artifacts(frame: pd.DataFrame, Xt: np.ndarray, labels: np.ndarray, groups: dict[str, list[str]], seed: int) -> dict[str, Any]:
    from sklearn.decomposition import PCA

    labels = np.asarray(labels)
    ids, counts = np.unique(labels, return_counts=True)
    sizes = [{"cluster": int(c), "size": int(n), "share": round(float(n) / len(labels), 6)} for c, n in zip(ids, counts)]
    # 2-D PCA projection of a sample, for a scatter plot coloured by cluster.
    rng = np.random.default_rng(seed)
    idx = np.sort(rng.choice(len(Xt), min(len(Xt), 500), replace=False))
    n_comp = min(2, Xt.shape[1], len(Xt))
    pca = PCA(n_components=n_comp, random_state=seed).fit(Xt)
    proj = pca.transform(Xt[idx])
    projection = {
        "x": [round(float(v), 6) for v in proj[:, 0]],
        "y": [round(float(v), 6) for v in (proj[:, 1] if n_comp > 1 else np.zeros(len(idx)))],
        "cluster": [int(v) for v in labels[idx]],
        "explained_variance": [round(float(v), 6) for v in pca.explained_variance_ratio_],
    }
    # Per-cluster profiles on the original (untransformed) features.
    numeric = [c for c in groups["numeric"] if c in frame]
    categorical = [c for c in groups["categorical"] if c in frame]
    profiles = []
    for c in ids:
        part = frame[labels == c]
        profiles.append(
            {
                "cluster": int(c),
                "size": int(len(part)),
                "means": {col: _f(pd.to_numeric(part[col], errors="coerce").mean()) for col in numeric},
                "top_categories": {
                    col: (str(part[col].mode(dropna=True).iloc[0]) if part[col].notna().any() else None) for col in categorical
                },
            }
        )
    overall = {col: _f(pd.to_numeric(frame[col], errors="coerce").mean()) for col in numeric}
    return {"cluster_sizes": sizes, "projection": projection, "cluster_profiles": profiles, "overall_means": overall}


def _f(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else round(f, 6)


# -- training ----------------------------------------------------------------------------------------------


def train_clustering(
    frame: pd.DataFrame, config: TrainingConfig, schema: Schema | None = None, *, progress: Callable[[float, str], None] | None = None
) -> TrainingResult:
    from .preprocessing import build_preprocessor, rank_numeric, split_features
    from .trainer import AlgorithmResult, TrainingError, TrainingResult, _pca, feature_signature, reference_profile

    started = time.monotonic()
    deadline = started + config.max_training_seconds
    report = progress or (lambda f, m: None)
    cfg = config.clustering or ClusteringConfig()
    if cfg.k_max < cfg.k_min:
        raise TrainingError("clustering.k_max must be ≥ k_min")
    features = config.features or [c for c in frame.columns if c != config.target]
    missing = [c for c in features if c not in frame.columns]
    if missing:
        raise TrainingError(f"unknown feature columns: {missing}")
    frame = frame.reset_index(drop=True)
    if len(frame) < 10:
        raise TrainingError("clustering needs at least 10 rows")
    X = frame[features]
    schema_fields = {f.name: f for f in schema.entities[0].fields} if schema and schema.entities else {}
    groups = split_features(X, features, schema_fields, text=config.preprocessing.text)
    warns: list[str] = []
    if groups["dropped"]:
        warns.append(f"excluded identifier/free-text columns: {', '.join(groups['dropped'])}")
    if config.preprocessing.auto_features and groups["numeric"]:
        groups["engineered"] = rank_numeric(X, groups["numeric"], None, "clustering", config.preprocessing.auto_features.top_k)
    pre = build_preprocessor(groups, config.preprocessing, "clustering")
    steps: list[tuple[str, Any]] = [("prep", pre)]
    if config.preprocessing.pca:
        steps.append(("pca", _pca(config)))
    prep = Pipeline(steps)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        Xt = np.asarray(prep.fit_transform(X), dtype=float)
    Xt = np.nan_to_num(Xt)

    candidates = [a for a in (config.algorithms or DEFAULT_CLUSTERING) if a in CLUSTERING_ALGORITHMS]
    if not candidates:
        raise TrainingError("none of the selected algorithms supports clustering")
    results: list[AlgorithmResult] = []
    for i, algo_id in enumerate(candidates):
        if time.monotonic() > deadline and results:
            warns.append(f"time budget reached; skipped {', '.join(candidates[i:])}")
            break
        algo = CLUSTERING_ALGORITHMS[algo_id]
        report(0.05 + 0.8 * i / len(candidates), f"clustering with {algo.name}")
        t0 = time.monotonic()
        base = {**algo.defaults(), **config.hyperparameters.get(algo_id, {})}
        trials: list[dict[str, Any]] = []
        best: tuple[float, dict[str, Any], ClusterModel, dict[str, Any]] | None = None
        budget_end = t0 + config.automl.timeout_seconds / len(candidates)
        for params in _candidates(algo_id, cfg, base, Xt, config.automl.enabled, len(Xt)):
            if trials and (time.monotonic() > min(budget_end, deadline)):
                break
            try:
                model = ClusterModel(algo_id, params, config.seed, cfg.max_fit_rows).fit(Xt)
            except (ValueError, np.linalg.LinAlgError) as exc:
                trials.append({"params": params, "error": str(exc)[:200]})
                continue
            m = cluster_metrics(Xt, model.labels_, config.seed)
            score = _selection_score(m)
            trials.append({"params": params, "cv_score": score if math.isfinite(score) else None, **m})
            if best is None or score > best[0]:
                best = (score, params, model, m)
        if best is None:
            warns.append(f"{algo.name} failed on every candidate")
            continue
        score, params, model, m = best
        pipeline = Pipeline([*prep.steps, ("model", model)])
        artifacts = _artifacts(X, Xt, model.labels_, groups, config.seed)
        artifacts["k_search"] = [t for t in trials if "error" not in t]
        results.append(
            AlgorithmResult(
                algorithm=algo_id,
                params=params,
                cv_score=score if math.isfinite(score) else -1.0,
                cv_std=0.0,
                metrics={**m, "cv_score": score if math.isfinite(score) else None, "cv_std": 0.0, "cv_metric": "silhouette"},
                artifacts=artifacts,
                pipeline=pipeline,
                duration_seconds=time.monotonic() - t0,
                trials=trials,
            )
        )
    if not results:
        raise TrainingError("no clustering algorithm produced at least two clusters")
    best_index = int(np.argmax([r.cv_score for r in results]))
    signature = {
        "target": None,
        "problem_type": "clustering",
        "classes": None,
        "features": feature_signature(X, features, groups, schema_fields),
    }
    report(0.95, "done")
    return TrainingResult(
        problem_type="clustering",
        scoring="silhouette",
        classes=None,
        results=results,
        best_index=best_index,
        signature=signature,
        warnings=warns,
        background=X.sample(min(100, len(X)), random_state=config.seed),
        reference=reference_profile(X, signature, [r.pipeline for r in results], config.seed),
    )
