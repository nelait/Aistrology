"""Cleaning operations (CLN-001 … CLN-010) as typed, serializable pipeline steps (PIP-001).

Each step is a pure function ``DataFrame -> DataFrame``: the input is never
mutated (ANA-NFR-002), so any prefix of a pipeline can be replayed exactly.
Row expressions (``derive``, ``filter``) use the shared sandboxed SQL-expression
language and are evaluated by a locked-down DuckDB (SEC-009).
"""

from __future__ import annotations

import hashlib
import json
import re
import warnings
from typing import Annotated, Any, Literal

import duckdb
import numpy as np
import pandas as pd
from pydantic import BaseModel, Field, field_validator

from ..analytics.sql_sandbox import UnsafeQueryError, validate_select
from ..privacy import MaskStrategy, mask_value
from ..schema.model import IDENTIFIER_RE, Semantic


class StepError(ValueError):
    pass


def _require_columns(df: pd.DataFrame, columns: list[str]) -> None:
    missing = [c for c in columns if c not in df.columns]
    if missing:
        raise StepError(f"unknown column(s): {', '.join(missing)}")


class _Step(BaseModel):
    note: str | None = Field(default=None, max_length=500)

    def apply(self, df: pd.DataFrame) -> pd.DataFrame:  # pragma: no cover - abstract
        raise NotImplementedError

    def columns_used(self) -> list[str]:
        return [
            c
            for key in ("column", "columns")
            for c in ([getattr(self, key)] if isinstance(getattr(self, key, None), str) else getattr(self, key, None) or [])
        ]


def _targets(df: pd.DataFrame, columns: list[str] | None, numeric_only: bool = False) -> list[str]:
    if columns:
        _require_columns(df, columns)
        return columns
    if numeric_only:
        return [c for c in df.columns if pd.api.types.is_numeric_dtype(df[c]) and not pd.api.types.is_bool_dtype(df[c])]
    return list(df.columns)


# -- CLN-001 missing values -----------------------------------------------------------------


class DropMissing(_Step):
    op: Literal["drop_missing"] = "drop_missing"
    axis: Literal["rows", "columns"] = "rows"
    columns: list[str] | None = None  # rows: consider only these columns
    how: Literal["any", "all"] = "any"
    # columns axis: drop columns whose null share exceeds this
    max_null_fraction: float = Field(default=0.5, ge=0, le=1)

    def apply(self, df):
        if self.axis == "rows":
            return df.dropna(subset=_targets(df, self.columns), how=self.how).reset_index(drop=True)
        cols = _targets(df, self.columns)
        drop = [c for c in cols if df[c].isna().mean() > self.max_null_fraction]
        return df.drop(columns=drop)


class FillMissing(_Step):
    op: Literal["fill_missing"] = "fill_missing"
    columns: list[str] | None = None
    strategy: Literal["mean", "median", "mode", "constant", "ffill", "bfill", "interpolate"]
    value: Any = None

    def apply(self, df):
        out = df.copy()
        numeric_only = self.strategy in ("mean", "median", "interpolate")
        for c in _targets(df, self.columns, numeric_only=numeric_only and not self.columns):
            s = out[c]
            if self.strategy in ("mean", "median", "interpolate") and not pd.api.types.is_numeric_dtype(s):
                raise StepError(f"{self.strategy} needs a numeric column; {c!r} is {s.dtype}")
            if self.strategy == "mean":
                out[c] = s.fillna(s.mean())
            elif self.strategy == "median":
                out[c] = s.fillna(s.median())
            elif self.strategy == "mode":
                mode = s.mode(dropna=True)
                out[c] = s.fillna(mode.iloc[0]) if len(mode) else s
            elif self.strategy == "constant":
                if self.value is None:
                    raise StepError("constant fill needs a value")
                out[c] = s.fillna(self.value)
            elif self.strategy == "ffill":
                out[c] = s.ffill()
            elif self.strategy == "bfill":
                out[c] = s.bfill()
            else:
                out[c] = s.interpolate(limit_direction="both")
        return out


# -- CLN-002 outliers -------------------------------------------------------------------------


class HandleOutliers(_Step):
    op: Literal["handle_outliers"] = "handle_outliers"
    columns: list[str] | None = None
    method: Literal["iqr", "zscore"] = "iqr"
    threshold: float = Field(default=1.5, gt=0)  # IQR multiplier or |z|
    action: Literal["remove", "cap", "flag"] = "cap"

    def bounds(self, s: pd.Series) -> tuple[float, float]:
        v = s.dropna().astype(float)
        if self.method == "iqr":
            q1, q3 = np.percentile(v, [25, 75]) if len(v) else (0.0, 0.0)
            iqr = q3 - q1
            return q1 - self.threshold * iqr, q3 + self.threshold * iqr
        mean, std = (v.mean(), v.std()) if len(v) else (0.0, 0.0)
        return mean - self.threshold * std, mean + self.threshold * std

    def apply(self, df):
        out = df.copy()
        mask = pd.Series(False, index=df.index)
        for c in _targets(df, self.columns, numeric_only=True):
            if not pd.api.types.is_numeric_dtype(df[c]):
                raise StepError(f"outlier handling needs a numeric column; {c!r} is {df[c].dtype}")
            lo, hi = self.bounds(df[c])
            col_mask = (df[c] < lo) | (df[c] > hi)
            if self.action == "cap":
                out[c] = df[c].clip(lower=lo, upper=hi)
            elif self.action == "flag":
                out[f"{c}_is_outlier"] = col_mask
            mask |= col_mask
        if self.action == "remove":
            out = out[~mask].reset_index(drop=True)
        return out


# -- CLN-003 duplicates -----------------------------------------------------------------------


class Deduplicate(_Step):
    op: Literal["deduplicate"] = "deduplicate"
    columns: list[str] | None = None  # key columns; default: whole row
    keep: Literal["first", "last"] = "first"

    def apply(self, df):
        subset = _targets(df, self.columns) if self.columns else None
        hashable = df.map(lambda v: json.dumps(v, default=str) if isinstance(v, (list, dict, np.ndarray)) else v)
        keep_mask = ~hashable.duplicated(subset=subset, keep=self.keep)
        return df[keep_mask].reset_index(drop=True)


class FuzzyDeduplicate(_Step):
    """CLN-003a: drop near-duplicate rows (normalized string similarity ≥ ``threshold`` on the key columns).

    Default key columns: every column that isn't unique per row. Blocking (sorted neighbourhood,
    ``window`` rows) keeps it roughly linear in the row count; see ``app.cleaning.fuzzy``.
    """

    op: Literal["fuzzy_deduplicate"] = "fuzzy_deduplicate"
    columns: list[str] | None = Field(default=None, max_length=50)
    threshold: float = Field(default=0.9, ge=0.5, le=1.0)
    window: int = Field(default=10, ge=1, le=100)
    keep: Literal["first", "last"] = "first"

    def apply(self, df):
        from .fuzzy import find_near_duplicates, keep_mask

        columns = _targets(df, self.columns) if self.columns else None
        matches = find_near_duplicates(df.reset_index(drop=True), columns, threshold=self.threshold, window=self.window)
        return df.reset_index(drop=True)[keep_mask(matches, self.keep)].reset_index(drop=True)


# -- CLN-004 type conversion ------------------------------------------------------------------


class Cast(_Step):
    op: Literal["cast"] = "cast"
    column: str
    to: Literal["string", "integer", "number", "boolean", "date", "datetime"]
    format: str | None = None  # strptime format for date/datetime
    on_error: Literal["null", "drop_row", "fail"] = "null"

    def apply(self, df):
        _require_columns(df, [self.column])
        s = df[self.column]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            if self.to == "string":
                converted = s.astype("string")
            elif self.to in ("integer", "number"):
                cleaned = s.astype(str).str.replace(",", "", regex=False).str.strip() if s.dtype == object else s
                converted = pd.to_numeric(cleaned, errors="coerce")
                if self.to == "integer":
                    fractional = converted.notna() & (converted != converted.round())
                    converted = converted.where(~fractional).round().astype("Int64")
            elif self.to == "boolean":
                lowered = s.astype(str).str.strip().str.lower()
                converted = lowered.map(
                    {
                        "true": True,
                        "t": True,
                        "yes": True,
                        "y": True,
                        "1": True,
                        "false": False,
                        "f": False,
                        "no": False,
                        "n": False,
                        "0": False,
                    }
                ).astype("boolean")
            else:
                converted = (
                    pd.to_datetime(s, format=self.format, errors="coerce")
                    if self.format
                    else pd.to_datetime(s, errors="coerce", format="mixed")
                )
                if self.to == "date":
                    converted = converted.dt.normalize()
        failed = converted.isna() & s.notna()
        if failed.any():
            if self.on_error == "fail":
                examples = s[failed].astype(str).head(3).tolist()
                raise StepError(f"{int(failed.sum())} values in {self.column!r} could not be cast to {self.to}, e.g. {examples}")
        out = df.copy()
        out[self.column] = converted
        if self.on_error == "drop_row":
            out = out[~failed].reset_index(drop=True)
        return out


# -- CLN-005 string normalization -------------------------------------------------------------


class NormalizeStrings(_Step):
    op: Literal["normalize_strings"] = "normalize_strings"
    columns: list[str] | None = None
    trim: bool = True
    case: Literal["lower", "upper", "title"] | None = None
    find: str | None = Field(default=None, max_length=500)  # regex
    replace: str = ""
    collapse_whitespace: bool = False

    @field_validator("find")
    @classmethod
    def _valid_regex(cls, v):
        if v is not None:
            try:
                re.compile(v)
            except re.error as exc:
                raise ValueError(f"invalid regex: {exc}") from exc
        return v

    def apply(self, df):
        out = df.copy()
        cols = self.columns or [c for c in df.columns if df[c].dtype == object or pd.api.types.is_string_dtype(df[c])]
        _require_columns(df, cols)
        for c in cols:
            mask = out[c].map(lambda v: isinstance(v, str))
            s = out.loc[mask, c].astype(str)
            if self.trim:
                s = s.str.strip()
            if self.collapse_whitespace:
                s = s.str.replace(r"\s+", " ", regex=True)
            if self.case:
                s = getattr(s.str, self.case)()
            if self.find:
                s = s.str.replace(self.find, self.replace, regex=True)
            out.loc[mask, c] = s
        return out


# -- CLN-006 dates ----------------------------------------------------------------------------


class NormalizeDates(_Step):
    op: Literal["normalize_dates"] = "normalize_dates"
    column: str
    formats: list[str] = Field(default_factory=list, description="Formats tried in order; empty = flexible parsing")
    output: Literal["date", "datetime"] = "date"
    dayfirst: bool = False

    def apply(self, df):
        _require_columns(df, [self.column])
        s = df[self.column]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            if self.formats:
                parsed = pd.Series(pd.NaT, index=s.index, dtype="datetime64[ns]")
                for fmt in self.formats:
                    attempt = pd.to_datetime(s.where(parsed.isna()), format=fmt, errors="coerce")
                    parsed = parsed.fillna(attempt)
            else:
                parsed = pd.to_datetime(s, errors="coerce", format="mixed", dayfirst=self.dayfirst)
        out = df.copy()
        out[self.column] = parsed.dt.normalize() if self.output == "date" else parsed
        return out


# -- CLN-007 column operations ----------------------------------------------------------------


class Rename(_Step):
    op: Literal["rename"] = "rename"
    mapping: dict[str, str]

    def apply(self, df):
        _require_columns(df, list(self.mapping))
        bad = [n for n in self.mapping.values() if not IDENTIFIER_RE.match(n)]
        if bad:
            raise StepError(f"invalid column name(s): {bad}")
        return df.rename(columns=self.mapping)


class DropColumns(_Step):
    op: Literal["drop_columns"] = "drop_columns"
    columns: list[str]

    def apply(self, df):
        _require_columns(df, self.columns)
        return df.drop(columns=self.columns)


class Reorder(_Step):
    op: Literal["reorder"] = "reorder"
    columns: list[str]  # listed columns first, the rest keep their order

    def apply(self, df):
        _require_columns(df, self.columns)
        return df[self.columns + [c for c in df.columns if c not in self.columns]]


class SplitColumn(_Step):
    op: Literal["split"] = "split"
    column: str
    separator: str = Field(min_length=1, max_length=20)
    into: list[str] = Field(min_length=2, max_length=20)
    drop_original: bool = False

    def apply(self, df):
        _require_columns(df, [self.column])
        parts = df[self.column].astype("string").str.split(self.separator, n=len(self.into) - 1, expand=True, regex=False)
        out = df.copy()
        for i, name in enumerate(self.into):
            out[name] = parts[i] if i in parts.columns else None
        return out.drop(columns=[self.column]) if self.drop_original else out


class MergeColumns(_Step):
    op: Literal["merge"] = "merge"
    columns: list[str] = Field(min_length=2)
    into: str
    separator: str = " "
    drop_original: bool = False

    def apply(self, df):
        _require_columns(df, self.columns)
        out = df.copy()
        out[self.into] = df[self.columns].astype("string").fillna("").agg(self.separator.join, axis=1).str.strip()
        return out.drop(columns=[c for c in self.columns if c != self.into]) if self.drop_original else out


def _run_expression(df: pd.DataFrame, sql: str) -> pd.DataFrame:
    """Evaluate a validated SELECT over ``df`` (registered as ``t``) with external access locked."""
    try:
        validate_select(sql)
    except UnsafeQueryError as exc:
        raise StepError(str(exc)) from exc
    con = duckdb.connect(":memory:", config={"threads": 2})
    try:
        con.register("t", df)
        con.execute("SET enable_external_access = false")
        con.execute("SET lock_configuration = true")
        return con.execute(sql).df()
    except duckdb.Error as exc:
        raise StepError(str(exc).split("\n")[0]) from exc
    finally:
        con.close()


def _check_expression(expression: str) -> str:
    if ";" in expression or "--" in expression or "/*" in expression:
        raise ValueError("expressions may not contain ';' or comments")
    if re.search(r"\b(select|from|read_\w+|glob|copy|attach|install|load|pragma)\b", expression, re.IGNORECASE):
        raise ValueError("expressions may not contain subqueries or table functions")
    return expression


class Derive(_Step):
    """New calculated column from a SQL expression, e.g. ``quantity * unit_price`` (CLN-007, USR-004)."""

    op: Literal["derive"] = "derive"
    name: str = Field(pattern=IDENTIFIER_RE.pattern)
    expression: str = Field(min_length=1, max_length=2000)

    @field_validator("expression")
    @classmethod
    def _safe(cls, v: str) -> str:
        return _check_expression(v)

    def apply(self, df):
        result = _run_expression(df, f'SELECT ({self.expression}) AS "{self.name}" FROM t')
        out = df.copy()
        out[self.name] = result[self.name].to_numpy()
        return out


class Filter(_Step):
    """Keep rows where the SQL condition holds (CLN-008), e.g. ``amount > 0 AND region <> 'test'``."""

    op: Literal["filter"] = "filter"
    condition: str = Field(min_length=1, max_length=2000)

    @field_validator("condition")
    @classmethod
    def _safe(cls, v: str) -> str:
        return _check_expression(v)

    def apply(self, df):
        idx = df.reset_index(drop=True).assign(__row=range(len(df)))
        kept = _run_expression(idx, f"SELECT __row FROM t WHERE ({self.condition})")["__row"].to_numpy()
        return df.reset_index(drop=True).iloc[np.sort(kept)].reset_index(drop=True)


# -- CLN-010 PII masking ----------------------------------------------------------------------


class MaskPII(_Step):
    op: Literal["mask_pii"] = "mask_pii"
    columns: list[str]
    strategy: MaskStrategy = MaskStrategy.PARTIAL
    semantics: dict[str, Semantic] = Field(default_factory=dict)
    salt: str = Field(default="", max_length=100)

    def apply(self, df):
        _require_columns(df, self.columns)
        out = df.copy()
        for c in self.columns:
            out[c] = df[c].map(
                lambda v, c=c: mask_value(v, self.semantics.get(c), self.strategy, self.salt) if v is not None and v == v else v
            )
        return out


Step = Annotated[
    DropMissing
    | FillMissing
    | HandleOutliers
    | Deduplicate
    | FuzzyDeduplicate
    | Cast
    | NormalizeStrings
    | NormalizeDates
    | Rename
    | DropColumns
    | Reorder
    | SplitColumn
    | MergeColumns
    | Derive
    | Filter
    | MaskPII,
    Field(discriminator="op"),
]


class StepList(BaseModel):
    steps: list[Step] = Field(default_factory=list, max_length=500)


class StepStats(BaseModel):
    op: str
    rows_before: int
    rows_after: int
    columns_before: int
    columns_after: int
    nulls_before: int
    nulls_after: int
    added_columns: list[str]
    removed_columns: list[str]
    changed_cells: int | None = None


def _stats(op: str, before: pd.DataFrame, after: pd.DataFrame) -> StepStats:
    changed = None
    if len(before) == len(after):
        common = [c for c in before.columns if c in after.columns]
        try:
            b = before[common].astype(object).where(before[common].notna(), None)
            a = after[common].astype(object).where(after[common].notna(), None)
            changed = int((b.to_numpy() != a.to_numpy()).sum())
        except (TypeError, ValueError):
            changed = None
    return StepStats(
        op=op,
        rows_before=len(before),
        rows_after=len(after),
        columns_before=before.shape[1],
        columns_after=after.shape[1],
        nulls_before=int(before.isna().sum().sum()),
        nulls_after=int(after.isna().sum().sum()),
        added_columns=[c for c in after.columns if c not in before.columns],
        removed_columns=[c for c in before.columns if c not in after.columns],
        changed_cells=changed,
    )


def run_steps(df: pd.DataFrame, steps: list[Any], *, collect_stats: bool = True, on_step=None) -> tuple[pd.DataFrame, list[StepStats]]:
    """Apply steps in order. Returns the result and per-step before/after stats (PIP-005)."""
    stats: list[StepStats] = []
    current = df
    for i, step in enumerate(steps):
        try:
            nxt = step.apply(current)
        except StepError as exc:
            raise StepError(f"step {i + 1} ({step.op}): {exc}") from exc
        if collect_stats:
            stats.append(_stats(step.op, current, nxt))
        current = nxt
        if on_step:
            on_step(i + 1, len(steps))
    return current, stats


def pipeline_hash(steps: list[Any]) -> str:
    payload = json.dumps([s.model_dump(mode="json") for s in steps], sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()
