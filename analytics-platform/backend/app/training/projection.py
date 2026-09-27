"""2-D projections for visualization only (FE-005a): UMAP when ``umap-learn`` is installed, else t-SNE (PCA on request).

Never part of a trained pipeline. Rows are sampled (at most 5,000), preprocessed (numeric imputation + scaling,
one-hot categoricals, date parts; or the run's own fitted preprocessing), and embedded in two dimensions.
"""

from __future__ import annotations

import importlib.util
import warnings
from typing import Any, Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field

MAX_SAMPLE = 5000
Method = Literal["auto", "umap", "tsne", "pca"]


class ProjectionRequest(BaseModel):
    method: Method = "auto"
    features: list[str] | None = Field(default=None, max_length=500)
    color_by: str | None = None
    sample: int = Field(default=2000, ge=10, le=MAX_SAMPLE)
    perplexity: float = Field(default=30.0, ge=2.0, le=100.0)
    n_neighbors: int = Field(default=15, ge=2, le=200)
    seed: int = Field(default=0, ge=0, le=2**31 - 1)


def umap_available() -> bool:
    return importlib.util.find_spec("umap") is not None


def resolve_method(method: str) -> str:
    if method == "auto":
        return "umap" if umap_available() else "tsne"
    if method == "umap" and not umap_available():
        raise ValueError("UMAP is not installed on this server (pip install umap-learn); use tsne or auto")
    return method


def embed(Xt: np.ndarray, method: str, *, perplexity: float = 30.0, n_neighbors: int = 15, seed: int = 0) -> np.ndarray:
    Xt = np.nan_to_num(np.asarray(Xt, dtype=float))
    n = len(Xt)
    if n < 3:
        raise ValueError("need at least 3 rows to project")
    if Xt.shape[1] == 1:
        Xt = np.column_stack([Xt, np.zeros(n)])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if method == "pca":
            from sklearn.decomposition import PCA

            return PCA(n_components=2, random_state=seed).fit_transform(Xt)
        if Xt.shape[1] > 50:  # the usual PCA pre-reduction before t-SNE / UMAP
            from sklearn.decomposition import PCA

            Xt = PCA(n_components=50, random_state=seed).fit_transform(Xt)
        if method == "umap":
            import umap

            return umap.UMAP(n_components=2, n_neighbors=min(n_neighbors, n - 1), random_state=seed).fit_transform(Xt)
        from sklearn.manifold import TSNE

        return TSNE(n_components=2, perplexity=min(perplexity, (n - 1) / 3), init="pca", random_state=seed).fit_transform(Xt)


def _sample(frame: pd.DataFrame, n: int, seed: int) -> pd.DataFrame:
    return frame.sample(min(n, len(frame)), random_state=seed) if len(frame) > n else frame


def _color(values: pd.Series) -> list[Any]:
    if pd.api.types.is_numeric_dtype(values):
        return [None if pd.isna(v) else round(float(v), 6) for v in values]
    return [None if pd.isna(v) else str(v) for v in values]


def project_dataset(frame: pd.DataFrame, req: ProjectionRequest, schema_fields: dict[str, Any]) -> dict[str, Any]:
    from .preprocessing import PreprocessingConfig, build_preprocessor, split_features

    features = req.features or [c for c in frame.columns if c != req.color_by]
    unknown = [c for c in [*features, *([req.color_by] if req.color_by else [])] if c not in frame.columns]
    if unknown:
        raise ValueError(f"unknown columns: {', '.join(unknown)}")
    # PII columns (INF-009) are not used for the embedding unless requested explicitly.
    if req.features is None:
        features = [c for c in features if not (schema_fields.get(c) is not None and schema_fields[c].pii)]
    method = resolve_method(req.method)
    sample = _sample(frame, req.sample, req.seed).reset_index(drop=True)
    groups = split_features(sample, features, schema_fields)
    pre = build_preprocessor(groups, PreprocessingConfig(), "clustering")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        Xt = np.asarray(pre.fit_transform(sample[features]), dtype=float)
    xy = embed(Xt, method, perplexity=req.perplexity, n_neighbors=req.n_neighbors, seed=req.seed)
    out = _result(xy, method, len(frame))
    out["features"] = [c for c in features if c not in groups["dropped"]]
    if req.color_by:
        out["color_by"], out["color"] = req.color_by, _color(sample[req.color_by])
    return out


def project_run(bundle: Any, frame: pd.DataFrame, req: ProjectionRequest) -> dict[str, Any]:
    """Embed rows through the run's own fitted preprocessing; colour by the model's predictions."""
    from sklearn.pipeline import Pipeline

    pipe = bundle.pipeline
    if not isinstance(pipe, Pipeline) or "prep" not in pipe.named_steps:
        raise TypeError("projections need a platform-trained pipeline")
    method = resolve_method(req.method)
    sample = _sample(frame, req.sample, req.seed).reset_index(drop=True)
    rows = sample[[c for c in bundle.feature_names if c in sample.columns]].to_dict(orient="records")
    X = bundle.frame(rows)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        Xt = np.asarray(pipe[:-1].transform(X), dtype=float)
    xy = embed(Xt, method, perplexity=req.perplexity, n_neighbors=req.n_neighbors, seed=req.seed)
    out = _result(xy, method, len(frame))
    preds = bundle.predict(rows).get("predictions") or []
    if preds and isinstance(preds[0], dict):  # anomaly: colour by the flag
        preds = [p.get("is_anomaly") for p in preds]
    out["color_by"], out["color"] = "prediction", preds
    target = bundle.signature.get("target") or bundle.signature.get("label_column")
    if target and target in sample.columns:
        out["actual"] = _color(sample[target])
    return out


def _result(xy: np.ndarray, method: str, total_rows: int) -> dict[str, Any]:
    return {
        "method": method,
        "n": int(len(xy)),
        "total_rows": int(total_rows),
        "x": [round(float(v), 5) for v in xy[:, 0]],
        "y": [round(float(v), 5) for v in xy[:, 1]],
        "note": "for visualization only; distances in the embedding are not model inputs",
    }
