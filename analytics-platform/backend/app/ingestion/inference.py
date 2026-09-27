"""Schema inference from data (INF-001 … INF-004, INF-009)."""

from __future__ import annotations

import re
import warnings
from datetime import date, datetime

import numpy as np
import pandas as pd
from pydantic import BaseModel, ConfigDict
from pydantic import Field as PField

from ..privacy import detect_value_semantic
from ..schema.model import IDENTIFIER_RE, ColumnRole, Entity, Field, FieldType, Schema, Semantic
from ..schema.semantics import guess_semantic

DATE_FORMATS = [
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%d/%m/%Y",
    "%m/%d/%Y",
    "%d-%m-%Y",
    "%m-%d-%Y",
    "%d.%m.%Y",
    "%d %b %Y",
    "%b %d, %Y",
    "%d %B %Y",
    "%B %d, %Y",
    "%Y%m%d",
]
DATETIME_FORMATS = [
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S.%f%z",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%d/%m/%Y %H:%M",
    "%m/%d/%Y %H:%M",
    "%m/%d/%Y %I:%M %p",
]
_TRUE = {"true", "t", "yes", "y", "1"}
_FALSE = {"false", "f", "no", "n", "0"}
_ID_NAME_RE = re.compile(r"(^id$|_id$|^id_|uuid|guid|_key$|^key$|_code$|_no$|_number$)", re.IGNORECASE)
PARSE_THRESHOLD = 0.95


class ColumnReport(BaseModel):
    source_name: str
    name: str
    type: FieldType
    role: ColumnRole
    semantic: Semantic | None = None
    pii: bool = False
    nullable: bool
    null_fraction: float
    distinct_count: int
    unique: bool
    primary_key_candidate: bool
    detected_format: str | None = None  # strptime format for string-encoded dates (INF-002)
    ambiguous_formats: list[str] | None = None
    parse_rate: float | None = None  # share of non-null values that parse as ``type``


class InferenceResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    schema_: Schema = PField(alias="schema")
    columns: list[ColumnReport]
    sampled_rows: int
    warnings: list[str]


def normalize_name(raw: str, taken: set[str]) -> str:
    name = re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", str(raw).strip())
    name = re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_").lower() or "column"
    if name[0].isdigit():
        name = f"c_{name}"
    name = name[:120]
    base, i = name, 2
    while name in taken:
        name = f"{base}_{i}"
        i += 1
    taken.add(name)
    return name


def _best_format(values: pd.Series, formats: list[str]) -> tuple[str | None, float, list[str]]:
    """Return (best format, share parsed, other formats that parse equally well)."""
    sample = values.head(2000)
    scores = []
    for fmt in formats:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            parsed = pd.to_datetime(sample, format=fmt, errors="coerce")
        scores.append((parsed.notna().mean(), fmt))
    scores.sort(key=lambda s: -s[0])
    best_score, best_fmt = scores[0]
    if best_score < PARSE_THRESHOLD:
        return None, float(best_score), []
    ties = [f for s, f in scores[1:] if s == best_score]
    return best_fmt, float(best_score), ties


def _infer_string_column(values: pd.Series) -> tuple[FieldType, str | None, list[str], float | None]:
    """Values are non-null strings. Returns (type, detected date format, ambiguous formats, parse rate)."""
    stripped = values.astype(str).str.strip()
    lowered = stripped.str.lower()
    if lowered.isin(_TRUE | _FALSE).mean() >= PARSE_THRESHOLD and lowered.nunique() <= 2:
        return FieldType.BOOLEAN, None, [], float(lowered.isin(_TRUE | _FALSE).mean())
    numeric = pd.to_numeric(stripped.str.replace(",", "", regex=False), errors="coerce")
    rate = float(numeric.notna().mean())
    # Leading zeros (zip codes, account numbers) mean the values are identifiers, not numbers.
    has_leading_zero = stripped.str.match(r"^0\d").mean() > 0.05
    if rate >= PARSE_THRESHOLD and not has_leading_zero:
        ints = numeric.dropna()
        is_int = bool((ints == ints.round()).all()) and not stripped.str.contains(r"\.", regex=True).any()
        return (FieldType.INTEGER if is_int else FieldType.NUMBER), None, [], rate
    if stripped.str.match(r"^\d").mean() >= PARSE_THRESHOLD or stripped.str.match(r"^[A-Za-z]{3,9}\s").mean() >= PARSE_THRESHOLD:
        fmt, rate, ties = _best_format(stripped, DATETIME_FORMATS)
        if fmt:
            return FieldType.DATETIME, fmt, ties, rate
        fmt, rate, ties = _best_format(stripped, DATE_FORMATS)
        if fmt:
            return FieldType.DATE, fmt, ties, rate
    return FieldType.STRING, None, [], None


def _field_type_from_dtype(series: pd.Series) -> FieldType | None:
    if pd.api.types.is_bool_dtype(series):
        return FieldType.BOOLEAN
    if pd.api.types.is_integer_dtype(series):
        return FieldType.INTEGER
    if pd.api.types.is_float_dtype(series):
        non_null = series.dropna()
        if len(non_null) and bool((non_null == non_null.round()).all()) and non_null.abs().max() < 2**53:
            # Integers with nulls come back as float from pandas.
            return FieldType.INTEGER
        return FieldType.NUMBER
    if pd.api.types.is_datetime64_any_dtype(series):
        non_null = series.dropna()
        if len(non_null) and bool((non_null.dt.normalize() == non_null).all()):
            return FieldType.DATE
        return FieldType.DATETIME
    return None


def infer_schema(frame: pd.DataFrame, entity_name: str = "data") -> InferenceResult:
    n = len(frame)
    taken: set[str] = set()
    fields: list[Field] = []
    reports: list[ColumnReport] = []
    result_warnings: list[str] = []
    if n == 0:
        result_warnings.append("file has no data rows; types are guesses")

    for source_name in frame.columns:
        series = frame[source_name]
        name = normalize_name(source_name, taken)
        non_null = series.dropna()
        if non_null.dtype == object:
            non_null = non_null[non_null.astype(str).str.strip() != ""]
        null_fraction = float(1 - len(non_null) / n) if n else 0.0
        detected_format, ties, parse_rate = None, [], None

        ftype = _field_type_from_dtype(series)
        if ftype is None:
            if len(non_null) and non_null.map(lambda v: isinstance(v, datetime)).all():
                ftype = FieldType.DATETIME
            elif len(non_null) and non_null.map(lambda v: isinstance(v, date)).all():
                ftype = FieldType.DATE
            elif len(non_null) and non_null.map(lambda v: isinstance(v, (list, dict, np.ndarray))).any():
                ftype = FieldType.STRING
                result_warnings.append(f"{name}: nested values are kept as JSON strings")
            elif len(non_null):
                ftype, detected_format, ties, parse_rate = _infer_string_column(non_null)
            else:
                ftype = FieldType.STRING

        hashable = non_null.map(lambda v: v if not isinstance(v, (list, dict, np.ndarray)) else str(v))
        distinct = int(hashable.nunique())
        unique = len(non_null) > 0 and distinct == len(non_null)
        pk_candidate = unique and null_fraction == 0 and ftype in (FieldType.INTEGER, FieldType.STRING) and n > 1

        semantic = guess_semantic(name, ftype)
        if semantic is None and ftype == FieldType.STRING and len(non_null):
            semantic = detect_value_semantic(non_null.astype(str).head(500).tolist())

        avg_len = float(non_null.astype(str).str.len().mean()) if len(non_null) and ftype == FieldType.STRING else 0.0
        if ftype in (FieldType.DATE, FieldType.DATETIME):
            role = ColumnRole.DATETIME
        elif ftype == FieldType.BOOLEAN:
            role = ColumnRole.BOOLEAN
        elif pk_candidate and (_ID_NAME_RE.search(name) or semantic == Semantic.UUID):
            role = ColumnRole.IDENTIFIER
        elif ftype == FieldType.NUMBER:
            role = ColumnRole.CONTINUOUS
        elif ftype == FieldType.INTEGER:
            role = ColumnRole.CATEGORICAL if distinct <= 20 and n >= 50 else ColumnRole.CONTINUOUS
        elif unique and n >= 20:
            role = ColumnRole.IDENTIFIER if avg_len < 40 else ColumnRole.TEXT
        elif avg_len > 50 or (n >= 50 and distinct > max(50, 0.5 * len(non_null))):
            role = ColumnRole.TEXT
        else:
            role = ColumnRole.CATEGORICAL

        field = Field(
            name=name,
            source_name=str(source_name) if str(source_name) != name else None,
            type=ftype,
            nullable=null_fraction > 0 or n == 0,
            unique=unique and role == ColumnRole.IDENTIFIER,
            semantic=semantic,
            role=role,
            enum=sorted(hashable.unique().tolist(), key=str)
            if role == ColumnRole.CATEGORICAL and ftype == FieldType.STRING and distinct <= 20 and n >= 50
            else None,
        )
        if ftype in (FieldType.INTEGER, FieldType.NUMBER) and len(non_null) and ftype == _field_type_from_dtype(series):
            field.minimum, field.maximum = float(non_null.min()), float(non_null.max())
        if not IDENTIFIER_RE.match(field.name):  # pragma: no cover - normalize_name guarantees this
            raise AssertionError(field.name)
        fields.append(field)
        reports.append(
            ColumnReport(
                source_name=str(source_name),
                name=name,
                type=ftype,
                role=role,
                semantic=semantic,
                pii=field.pii,
                nullable=field.nullable,
                null_fraction=round(null_fraction, 6),
                distinct_count=distinct,
                unique=unique,
                primary_key_candidate=pk_candidate,
                detected_format=detected_format,
                ambiguous_formats=ties or None,
                parse_rate=round(parse_rate, 6) if parse_rate is not None else None,
            )
        )
        if ties:
            result_warnings.append(f"{name}: date format is ambiguous between {[detected_format, *ties]}; please confirm")

    # INF-004: promote the leftmost id-like PK candidate. Other unique columns stay
    # candidates for the user to pick in review (INF-006) rather than being guessed.
    candidates = [i for i, r in enumerate(reports) if r.primary_key_candidate and _ID_NAME_RE.search(r.name)]
    if candidates:
        idx = candidates[0]
        fields[idx] = fields[idx].model_copy(update={"primary_key": True, "unique": True, "nullable": False, "role": ColumnRole.IDENTIFIER})
        reports[idx].role = ColumnRole.IDENTIFIER

    schema = Schema(name=entity_name, entities=[Entity(name=normalize_name(entity_name, set()), fields=fields)])
    return InferenceResult(schema_=schema, columns=reports, sampled_rows=n, warnings=result_warnings)
