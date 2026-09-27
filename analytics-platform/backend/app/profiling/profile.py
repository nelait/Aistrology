"""Data profiling and quality scoring (ANA-001 … ANA-007, ANA-009)."""

from __future__ import annotations

import math
import warnings
from typing import Any

import numpy as np
import pandas as pd
from pydantic import BaseModel

from ..schema.model import ColumnRole, FieldType, Schema

TOP_K = 10
HISTOGRAM_BINS = 20
Z_THRESHOLD = 3.0
IQR_MULTIPLIER = 1.5


class Histogram(BaseModel):
    edges: list[float]
    counts: list[int]


class OutlierReport(BaseModel):
    iqr_count: int
    iqr_bounds: tuple[float, float]
    zscore_count: int


class ColumnProfile(BaseModel):
    name: str
    type: FieldType | None = None
    role: ColumnRole | None = None
    count: int
    null_count: int
    null_fraction: float
    distinct_count: int
    # numeric / temporal
    min: Any = None
    max: Any = None
    mean: float | None = None
    median: float | None = None
    std: float | None = None
    percentiles: dict[str, float] | None = None
    histogram: Histogram | None = None
    outliers: OutlierReport | None = None
    # categorical / text
    top_values: list[tuple[str, int]] | None = None
    min_length: int | None = None
    max_length: int | None = None
    mean_length: float | None = None
    # ANA-007: share of string values that would parse as a number / date
    numeric_like_fraction: float | None = None
    date_like_fraction: float | None = None
    type_mismatch: str | None = None


class QualityScore(BaseModel):
    """ANA-009. score = 100 × (0.4·completeness + 0.2·uniqueness + 0.25·validity + 0.15·consistency)."""

    score: float
    completeness: float  # 1 − null cells / total cells
    uniqueness: float  # 1 − duplicate rows / rows
    validity: float  # 1 − mean share of values violating the declared type (type mismatches)
    consistency: float  # 1 − share of numeric values flagged as IQR outliers
    formula: str = "100 * (0.4*completeness + 0.2*uniqueness + 0.25*validity + 0.15*consistency)"


class DatasetProfile(BaseModel):
    row_count: int
    column_count: int
    duplicate_row_count: int
    columns: list[ColumnProfile]
    correlations: dict[str, dict[str, float | None]]
    quality: QualityScore
    warnings: list[str]


def _finite(x: Any) -> float | None:
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _hashable(series: pd.Series) -> pd.Series:
    return series.map(lambda v: str(v) if isinstance(v, (list, dict, np.ndarray)) else v)


def _numeric_profile(prof: ColumnProfile, values: pd.Series) -> float:
    """Fill numeric stats. Returns the share of values that are IQR outliers."""
    arr = values.astype(float).to_numpy()
    arr = arr[np.isfinite(arr)]
    if len(arr) == 0:
        return 0.0
    q = np.percentile(arr, [25, 50, 75, 99])
    prof.min, prof.max = _finite(arr.min()), _finite(arr.max())
    prof.mean, prof.median = _finite(arr.mean()), _finite(q[1])
    prof.std = _finite(arr.std(ddof=1)) if len(arr) > 1 else 0.0
    prof.percentiles = {"p25": float(q[0]), "p50": float(q[1]), "p75": float(q[2]), "p99": float(q[3])}
    counts, edges = np.histogram(arr, bins=min(HISTOGRAM_BINS, max(1, len(np.unique(arr)))))
    prof.histogram = Histogram(edges=[float(e) for e in edges], counts=[int(c) for c in counts])
    iqr = q[2] - q[0]
    lo, hi = q[0] - IQR_MULTIPLIER * iqr, q[2] + IQR_MULTIPLIER * iqr
    iqr_count = int(((arr < lo) | (arr > hi)).sum())
    std = arr.std()
    z_count = int((np.abs((arr - arr.mean()) / std) > Z_THRESHOLD).sum()) if std > 0 else 0
    prof.outliers = OutlierReport(iqr_count=iqr_count, iqr_bounds=(float(lo), float(hi)), zscore_count=z_count)
    return iqr_count / len(arr)


def profile_frame(frame: pd.DataFrame, schema: Schema | None = None) -> DatasetProfile:
    rows = len(frame)
    fields = {f.name: f for f in schema.entities[0].fields} if schema and schema.entities else {}
    columns: list[ColumnProfile] = []
    result_warnings: list[str] = []
    mismatch_shares: list[float] = []
    outlier_shares: list[float] = []
    numeric_cols: list[str] = []

    for name in frame.columns:
        series = frame[name]
        field = fields.get(str(name))
        non_null = series.dropna()
        prof = ColumnProfile(
            name=str(name),
            type=field.type if field else None,
            role=field.role if field else None,
            count=int(len(non_null)),
            null_count=int(rows - len(non_null)),
            null_fraction=round(float((rows - len(non_null)) / rows), 6) if rows else 0.0,
            distinct_count=int(_hashable(non_null).nunique()),
        )
        is_bool = pd.api.types.is_bool_dtype(series)
        if pd.api.types.is_numeric_dtype(series) and not is_bool:
            outlier_shares.append(_numeric_profile(prof, non_null))
            numeric_cols.append(str(name))
            mismatch_shares.append(0.0)
        elif pd.api.types.is_datetime64_any_dtype(series):
            if len(non_null):
                prof.min, prof.max = non_null.min().isoformat(), non_null.max().isoformat()
            mismatch_shares.append(0.0)
        else:
            as_str = non_null.astype(str)
            vc = _hashable(non_null).astype(str).value_counts().head(TOP_K)
            prof.top_values = [(str(k), int(v)) for k, v in vc.items()]
            if len(as_str):
                lengths = as_str.str.len()
                prof.min_length, prof.max_length = int(lengths.min()), int(lengths.max())
                prof.mean_length = round(float(lengths.mean()), 3)
                sample = as_str.head(5000).str.strip()
                numeric_like = float(pd.to_numeric(sample.str.replace(",", "", regex=False), errors="coerce").notna().mean())
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    date_like = float(pd.to_datetime(sample, errors="coerce", format="mixed").notna().mean())
                prof.numeric_like_fraction, prof.date_like_fraction = round(numeric_like, 4), round(date_like, 4)
                declared = field.type if field else FieldType.STRING
                mismatch = 0.0
                if declared in (FieldType.INTEGER, FieldType.NUMBER):
                    mismatch = 1 - numeric_like
                    if mismatch < 1:
                        prof.type_mismatch = f"numbers stored as text ({numeric_like:.0%} parse)"
                elif declared in (FieldType.DATE, FieldType.DATETIME):
                    mismatch = 1 - date_like
                    if mismatch < 1:
                        prof.type_mismatch = f"dates stored as text ({date_like:.0%} parse)"
                elif declared == FieldType.STRING and numeric_like >= 0.95 and prof.distinct_count > 1:
                    prof.type_mismatch = "numbers stored as text"
                elif declared == FieldType.STRING and 0.5 <= numeric_like < 0.95:
                    # Mixed column: mostly numbers with some text is a validity problem.
                    mismatch = 1 - numeric_like
                    prof.type_mismatch = f"mixed types: {numeric_like:.0%} numeric"
                mismatch_shares.append(mismatch)
            else:
                mismatch_shares.append(0.0)
        if prof.null_fraction == 1.0 and rows:
            result_warnings.append(f"{name}: column is entirely empty")
        elif prof.distinct_count == 1 and rows > 1:
            result_warnings.append(f"{name}: column has a single constant value")
        columns.append(prof)

    try:
        duplicate_rows = int(frame.apply(_hashable).duplicated().sum()) if rows else 0
    except TypeError:
        duplicate_rows = 0
    if duplicate_rows:
        result_warnings.append(f"{duplicate_rows} exact duplicate rows")

    correlations: dict[str, dict[str, float | None]] = {}
    if len(numeric_cols) >= 2:
        corr = frame[numeric_cols].astype(float).corr(method="pearson")
        correlations = {c: {d: _finite(corr.loc[c, d]) for d in numeric_cols} for c in numeric_cols}
        for i, c in enumerate(numeric_cols):
            for d in numeric_cols[i + 1 :]:
                v = correlations[c][d]
                if v is not None and abs(v) >= 0.95:
                    result_warnings.append(f"{c} and {d} are almost perfectly correlated ({v:.2f})")

    total_cells = rows * max(1, len(frame.columns))
    completeness = 1 - (sum(c.null_count for c in columns) / total_cells) if total_cells else 1.0
    uniqueness = 1 - duplicate_rows / rows if rows else 1.0
    validity = 1 - (sum(mismatch_shares) / len(mismatch_shares)) if mismatch_shares else 1.0
    consistency = 1 - (sum(outlier_shares) / len(outlier_shares)) if outlier_shares else 1.0
    score = 100 * (0.4 * completeness + 0.2 * uniqueness + 0.25 * validity + 0.15 * consistency)
    quality = QualityScore(
        score=round(score, 1),
        completeness=round(completeness, 4),
        uniqueness=round(uniqueness, 4),
        validity=round(validity, 4),
        consistency=round(consistency, 4),
    )
    return DatasetProfile(
        row_count=rows,
        column_count=len(frame.columns),
        duplicate_row_count=duplicate_rows,
        columns=columns,
        correlations=correlations,
        quality=quality,
        warnings=result_warnings,
    )
