"""Opt-in profiling analyses (ANA-004a, ANA-005a, ANA-008).

* Isolation Forest outlier flags over the numeric columns, fitted and scored on a
  sample of at most 200K rows.
* Near-duplicate rows (fuzzy matching with blocking, shared with CLN-003a).
* Missing-value patterns: co-missingness, missingness-indicator correlations,
  the most common row-level patterns and a **heuristic** MCAR/MAR label per
  column. MNAR can't be identified from the observed data alone, so it is never
  asserted; the report says so.
"""

from __future__ import annotations

import math
import warnings
from typing import Any, Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field, model_validator

from ..cleaning.fuzzy import METHOD as FUZZY_METHOD
from ..cleaning.fuzzy import find_near_duplicates
from ..export_utils import jsonable

MAX_SAMPLE_ROWS = 200_000


# -- ANA-004a Isolation Forest -----------------------------------------------------------------


class IsolationForestOptions(BaseModel):
    enabled: bool = True
    contamination: float | Literal["auto"] = "auto"
    n_estimators: int = Field(default=100, ge=10, le=500)
    max_rows: int = Field(default=MAX_SAMPLE_ROWS, ge=100, le=MAX_SAMPLE_ROWS)
    columns: list[str] | None = Field(default=None, max_length=200)
    seed: int = Field(default=42, ge=0, le=2**32 - 1)

    @model_validator(mode="after")
    def _check(self) -> IsolationForestOptions:
        if isinstance(self.contamination, float) and not 0 < self.contamination <= 0.5:
            raise ValueError("contamination must be 'auto' or in (0, 0.5]")
        return self


class OutlierExample(BaseModel):
    row: int
    score: float  # higher = more anomalous
    values: dict[str, Any]


class IsolationForestReport(BaseModel):
    columns: list[str]
    contamination: float | str
    sampled_rows: int
    total_rows: int
    outlier_count: int
    outlier_fraction: float
    examples: list[OutlierExample]
    message: str | None = None


def isolation_forest(frame: pd.DataFrame, options: IsolationForestOptions | None = None) -> IsolationForestReport:
    from sklearn.ensemble import IsolationForest

    options = options or IsolationForestOptions()
    numeric = [
        c
        for c in frame.columns
        if pd.api.types.is_numeric_dtype(frame[c]) and not pd.api.types.is_bool_dtype(frame[c]) and frame[c].notna().any()
    ]
    if options.columns:
        missing = [c for c in options.columns if c not in frame.columns]
        if missing:
            raise ValueError(f"unknown column(s): {missing}")
        non_numeric = [c for c in options.columns if c not in numeric]
        if non_numeric:
            raise ValueError(f"Isolation Forest needs numeric columns; not numeric: {non_numeric}")
        numeric = list(options.columns)
    report = IsolationForestReport(
        columns=[str(c) for c in numeric],
        contamination=options.contamination,
        sampled_rows=0,
        total_rows=len(frame),
        outlier_count=0,
        outlier_fraction=0.0,
        examples=[],
    )
    if not numeric or len(frame) < 10:
        report.message = "needs at least one numeric column and 10 rows"
        return report
    positions = np.arange(len(frame))
    if len(frame) > options.max_rows:
        positions = np.sort(np.random.default_rng(options.seed).choice(len(frame), options.max_rows, replace=False))
    sample = frame.iloc[positions]
    x = sample[numeric].astype(float).replace([np.inf, -np.inf], np.nan)
    x = x.fillna(x.median())
    model = IsolationForest(n_estimators=options.n_estimators, contamination=options.contamination, random_state=options.seed, n_jobs=1)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        model.fit(x.to_numpy())
        flags = model.predict(x.to_numpy()) == -1
        scores = -model.score_samples(x.to_numpy())
    report.sampled_rows = len(sample)
    report.outlier_count = int(flags.sum())
    report.outlier_fraction = round(float(flags.mean()), 6)
    top = [i for i in np.argsort(-scores) if flags[i]][:10]
    report.examples = [
        OutlierExample(
            row=int(positions[i]),
            score=round(float(scores[i]), 4),
            values={str(c): jsonable(sample.iloc[i][c]) for c in numeric},
        )
        for i in top
    ]
    return report


# -- ANA-005a near duplicates -----------------------------------------------------------------


class NearDuplicateOptions(BaseModel):
    enabled: bool = True
    columns: list[str] | None = Field(default=None, max_length=50)
    threshold: float = Field(default=0.9, ge=0.5, le=1.0)
    window: int = Field(default=10, ge=1, le=100)
    max_rows: int = Field(default=MAX_SAMPLE_ROWS, ge=100, le=MAX_SAMPLE_ROWS)


class NearDuplicateExample(BaseModel):
    rows: tuple[int, int]
    score: float
    values: tuple[dict[str, Any], dict[str, Any]]


class NearDuplicateReport(BaseModel):
    columns: list[str]
    threshold: float
    method: str
    rows_scanned: int
    sampled: bool
    pair_count: int
    cluster_count: int
    duplicate_rows: int  # rows fuzzy deduplication would remove
    examples: list[NearDuplicateExample]


def near_duplicates(frame: pd.DataFrame, options: NearDuplicateOptions | None = None) -> NearDuplicateReport:
    options = options or NearDuplicateOptions()
    if options.columns:
        missing = [c for c in options.columns if c not in frame.columns]
        if missing:
            raise ValueError(f"unknown column(s): {missing}")
    sampled = len(frame) > options.max_rows
    data = frame.head(options.max_rows).reset_index(drop=True) if sampled else frame.reset_index(drop=True)
    matches = find_near_duplicates(data, options.columns, threshold=options.threshold, window=options.window)
    shown = [str(c) for c in matches.columns]

    def row(i: int) -> dict[str, Any]:
        return {c: jsonable(data.iloc[i][c]) for c in shown}

    return NearDuplicateReport(
        columns=shown,
        threshold=options.threshold,
        method=FUZZY_METHOD,
        rows_scanned=len(data),
        sampled=sampled,
        pair_count=len(matches.pairs),
        cluster_count=len(matches.clusters),
        duplicate_rows=matches.duplicate_rows,
        examples=[NearDuplicateExample(rows=(a, b), score=s, values=(row(a), row(b))) for a, b, s in matches.pairs[:10]],
    )


# -- ANA-008 missing-value patterns -----------------------------------------------------------


class MissingPatternOptions(BaseModel):
    enabled: bool = True
    alpha: float = Field(default=0.05, gt=0, lt=0.5)
    max_rows: int = Field(default=MAX_SAMPLE_ROWS, ge=100, le=MAX_SAMPLE_ROWS)
    max_columns: int = Field(default=50, ge=2, le=200)


class MissingPattern(BaseModel):
    missing_columns: list[str]
    count: int
    fraction: float


class MissingMechanism(BaseModel):
    column: str
    missing_fraction: float
    label: Literal["MCAR (heuristic)", "MAR (heuristic)", "insufficient data"]
    associated_with: list[str] = Field(default_factory=list)
    min_adjusted_p_value: float | None = None
    evidence: str


class MissingPatternReport(BaseModel):
    heuristic: bool = True
    method: str = (
        "Heuristic, not a formal test. For each column with missing values, its missingness indicator is compared with every "
        "other observed column: Welch's t-test for numeric columns, a chi-square test for categorical ones (≤ 50 levels). "
        "p-values are Bonferroni-corrected. Any significant association → MAR (heuristic); none → consistent with MCAR "
        "(heuristic). MNAR (missingness depending on the missing value itself) can't be detected from observed data."
    )
    rows_analyzed: int
    columns: list[str]
    missing_fraction: dict[str, float]
    co_missingness: dict[str, dict[str, float]]  # P(both missing | either missing)
    indicator_correlation: dict[str, dict[str, float | None]]  # phi coefficients of the missingness indicators
    patterns: list[MissingPattern]
    mechanisms: list[MissingMechanism]


def _p_value(indicator: pd.Series, other: pd.Series) -> float | None:
    from scipy import stats

    present = other.notna()
    ind = indicator[present]
    values = other[present]
    if ind.sum() < 3 or (~ind).sum() < 3:
        return None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if pd.api.types.is_numeric_dtype(values) and not pd.api.types.is_bool_dtype(values):
            a, b = values[ind].astype(float), values[~ind].astype(float)
            if a.std() == 0 and b.std() == 0:
                return 0.0 if a.mean() != b.mean() else 1.0
            p = stats.ttest_ind(a, b, equal_var=False).pvalue
        else:
            cats = values.astype(str)
            if cats.nunique() < 2 or cats.nunique() > 50:
                return None
            table = pd.crosstab(ind, cats)
            if table.shape[0] < 2:
                return None
            p = stats.chi2_contingency(table).pvalue
    return float(p) if p is not None and math.isfinite(p) else None


def missing_patterns(frame: pd.DataFrame, options: MissingPatternOptions | None = None) -> MissingPatternReport:
    options = options or MissingPatternOptions()
    data = frame.head(options.max_rows)
    rows = len(data)
    nulls = data.isna()
    missing_cols = [c for c in data.columns if nulls[c].any()][: options.max_columns]
    names = [str(c) for c in missing_cols]
    fractions = {str(c): round(float(nulls[c].mean()), 6) for c in missing_cols}
    co: dict[str, dict[str, float]] = {}
    corr: dict[str, dict[str, float | None]] = {}
    if missing_cols:
        ind = nulls[missing_cols].astype(float)
        both = ind.T @ ind
        counts = ind.sum()
        for a in missing_cols:
            co[str(a)] = {}
            for b in missing_cols:
                either = counts[a] + counts[b] - both.loc[a, b]
                co[str(a)][str(b)] = round(float(both.loc[a, b] / either), 4) if either else 0.0
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            phi = ind.corr()
        corr = {
            str(a): {str(b): (None if pd.isna(phi.loc[a, b]) else round(float(phi.loc[a, b]), 4)) for b in missing_cols}
            for a in missing_cols
        }

    patterns: list[MissingPattern] = []
    if rows:
        keys = (
            nulls[missing_cols].apply(lambda r: tuple(c for c, v in zip(names, r) if v), axis=1) if missing_cols else pd.Series([()] * rows)
        )
        for key, count in keys.value_counts().head(10).items():
            patterns.append(MissingPattern(missing_columns=list(key), count=int(count), fraction=round(int(count) / rows, 6)))

    mechanisms: list[MissingMechanism] = []
    for c in missing_cols:
        indicator = nulls[c]
        frac = float(indicator.mean())
        if frac >= 1.0 or indicator.sum() < 3:
            mechanisms.append(
                MissingMechanism(
                    column=str(c), missing_fraction=round(frac, 6), label="insufficient data", evidence="too few missing or observed values"
                )
            )
            continue
        tests = [(str(o), _p_value(indicator, data[o])) for o in data.columns if o != c]
        tests = [(o, p) for o, p in tests if p is not None]
        if not tests:
            mechanisms.append(
                MissingMechanism(
                    column=str(c), missing_fraction=round(frac, 6), label="insufficient data", evidence="no other column could be compared"
                )
            )
            continue
        m = len(tests)
        adjusted = sorted(((o, min(1.0, p * m)) for o, p in tests), key=lambda t: t[1])
        significant = [o for o, p in adjusted if p < options.alpha]
        if significant:
            mechanisms.append(
                MissingMechanism(
                    column=str(c),
                    missing_fraction=round(frac, 6),
                    label="MAR (heuristic)",
                    associated_with=significant[:10],
                    min_adjusted_p_value=round(adjusted[0][1], 6),
                    evidence=f"missingness is associated with {', '.join(significant[:5])} (Bonferroni-adjusted p < {options.alpha})",
                )
            )
        else:
            mechanisms.append(
                MissingMechanism(
                    column=str(c),
                    missing_fraction=round(frac, 6),
                    label="MCAR (heuristic)",
                    min_adjusted_p_value=round(adjusted[0][1], 6),
                    evidence=f"no association with {m} other column(s) at alpha {options.alpha}; MNAR can't be ruled out",
                )
            )
    return MissingPatternReport(
        rows_analyzed=rows,
        columns=names,
        missing_fraction=fractions,
        co_missingness=co,
        indicator_correlation=corr,
        patterns=patterns,
        mechanisms=mechanisms,
    )


# -- request / response -----------------------------------------------------------------------


class AdvancedProfileRequest(BaseModel):
    isolation_forest: IsolationForestOptions | None = Field(default_factory=IsolationForestOptions)
    near_duplicates: NearDuplicateOptions | None = Field(default_factory=NearDuplicateOptions)
    missing_patterns: MissingPatternOptions | None = Field(default_factory=MissingPatternOptions)


class AdvancedProfile(BaseModel):
    row_count: int
    isolation_forest: IsolationForestReport | None = None
    near_duplicates: NearDuplicateReport | None = None
    missing_patterns: MissingPatternReport | None = None


def advanced_profile(frame: pd.DataFrame, request: AdvancedProfileRequest | None = None) -> AdvancedProfile:
    request = request or AdvancedProfileRequest()
    out = AdvancedProfile(row_count=len(frame))
    if request.isolation_forest and request.isolation_forest.enabled:
        out.isolation_forest = isolation_forest(frame, request.isolation_forest)
    if request.near_duplicates and request.near_duplicates.enabled:
        out.near_duplicates = near_duplicates(frame, request.near_duplicates)
    if request.missing_patterns and request.missing_patterns.enabled:
        out.missing_patterns = missing_patterns(frame, request.missing_patterns)
    return out
