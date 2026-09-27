"""Seeded sample-data generation from a canonical schema (GEN-001 … GEN-010).

Determinism (GEN-007): every column draws from its own RNG, seeded from
``(seed, entity name, field name)``. The same schema, seed and counts produce
identical data, and adding a field does not change the values of other fields.
"""

from __future__ import annotations

import io
import math
import re
import zlib
from datetime import UTC, date, datetime
from typing import Any, Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, field_validator, model_validator
from pydantic import Field as PField

from ..config import settings
from ..schema.model import Entity, Field, FieldType, Schema, Semantic, ensure_valid
from . import values as gen

PREVIEW_ROWS = 50


_TARGET_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}\.[A-Za-z_][A-Za-z0-9_]{0,127}$")


class Distribution(BaseModel):
    """Per-field value distribution (GEN-006).

    * ``uniform`` (default): uniform over [minimum, maximum] (or the name-based default range).
    * ``normal``: ``mean`` / ``std`` (default: the range midpoint and a sixth of the range).
    * ``lognormal`` (right-skewed): ``sigma`` is the shape (default 0.75). With ``mean`` it is the
      log-space mean (``numpy.random.lognormal``); without it, values are scaled into the field's range.
    * ``weights``: relative weights per value, ``{"gold": 1, "silver": 3}``. For enum fields the keys are
      enum values (missing values get weight 0); otherwise the keys are the categories themselves.

    Numeric draws are clipped to the field's ``minimum``/``maximum``.
    """

    kind: Literal["uniform", "normal", "lognormal", "weights"] = "uniform"
    mean: float | None = None
    std: float | None = PField(default=None, gt=0)
    sigma: float | None = PField(default=None, gt=0, le=10)
    weights: dict[str, float] | None = None

    @model_validator(mode="after")
    def _check(self) -> Distribution:
        if self.kind == "weights":
            if not self.weights:
                raise ValueError("weights distribution needs a non-empty 'weights' mapping")
            if len(self.weights) > 10_000:
                raise ValueError("at most 10,000 weighted values")
            if any(not math.isfinite(w) or w < 0 for w in self.weights.values()) or sum(self.weights.values()) <= 0:
                raise ValueError("weights must be finite, non-negative and sum to more than 0")
        return self


class GenerationOptions(BaseModel):
    # Rows per root entity (entities without a parent FK).
    count: int = PField(default=100, ge=1, le=1_000_000)
    # Explicit row counts per entity override ``count`` and ``children_per_parent``.
    counts: dict[str, int] = PField(default_factory=dict)
    seed: int = PField(default=42, ge=0, le=2**32 - 1)
    children_per_parent: tuple[int, int] = (0, 5)
    null_rate: float = PField(default=0.05, ge=0.0, le=1.0)
    # GEN-006: {"entity.field": Distribution}
    distributions: dict[str, Distribution] = PField(default_factory=dict, max_length=2000)
    # GEN-009: share of values per eligible field replaced by anomalies / edge cases (0 = off).
    anomaly_rate: float = PField(default=0.0, ge=0.0, le=0.5)

    @field_validator("distributions")
    @classmethod
    def _targets(cls, v: dict[str, Distribution]) -> dict[str, Distribution]:
        bad = [k for k in v if not _TARGET_RE.match(k)]
        if bad:
            raise ValueError(f"distribution keys must look like 'entity.field': {bad[:5]}")
        return v

    @model_validator(mode="after")
    def _check(self) -> GenerationOptions:
        lo, hi = self.children_per_parent
        if lo < 0 or hi < lo or hi > 1000:
            raise ValueError("children_per_parent must satisfy 0 <= min <= max <= 1000")
        for name, n in self.counts.items():
            if not 1 <= n <= 1_000_000:
                raise ValueError(f"counts[{name!r}] must be between 1 and 1,000,000")
        return self


class GenerationTooLarge(ValueError):
    def __init__(self, estimated_bytes: int, max_count: int):
        self.estimated_bytes = estimated_bytes
        self.max_count = max_count
        super().__init__(
            f"estimated output is {estimated_bytes / 1e9:.2f} GB, over the "
            f"{settings.max_dataset_bytes / 1e9:.0f} GB dataset limit; reduce count to at most {max_count:,}"
        )


class GenerationError(ValueError):
    pass


def _rng(seed: int, *parts: str) -> np.random.Generator:
    return np.random.default_rng([seed, *(zlib.crc32(p.encode()) for p in parts)])


# Name-based numeric ranges make default data look plausible without user configuration.
_NUMERIC_HINTS: list[tuple[re.Pattern[str], tuple[float, float]]] = [
    (re.compile(r"(^|_)(qty|quantity|count|units)$"), (1, 10)),
    (re.compile(r"(^|_)age$"), (18, 90)),
    (re.compile(r"(^|_)year$"), (1990, 2025)),
    (re.compile(r"(^|_)(rating|stars)$"), (1, 5)),
    (re.compile(r"(percent|pct|rate)$"), (0, 100)),
    (re.compile(r"(price|amount|total|cost|revenue|salary|balance|fee)"), (1, 5000)),
]
_BIRTH_RE = re.compile(r"(birth|dob)")


def _numeric_range(f: Field) -> tuple[float, float]:
    lo, hi = 0.0, 1000.0
    for pattern, (hlo, hhi) in _NUMERIC_HINTS:
        if pattern.search(f.name.lower()):
            lo, hi = hlo, hhi
            break
    if f.minimum is not None:
        lo = f.minimum
        hi = max(hi, lo)
    if f.maximum is not None:
        hi = f.maximum
        lo = min(lo, hi)
    return lo, hi


def _coerce_key(key: str, ftype: FieldType) -> Any:
    try:
        if ftype == FieldType.INTEGER:
            return int(key)
        if ftype == FieldType.NUMBER:
            return float(key)
        if ftype == FieldType.BOOLEAN and key.lower() in ("true", "false"):
            return key.lower() == "true"
        if ftype == FieldType.DATE:
            return date.fromisoformat(key)
        if ftype == FieldType.DATETIME:
            return datetime.fromisoformat(key)
    except ValueError as exc:
        raise GenerationError(f"weight key {key!r} is not a valid {ftype.value}") from exc
    return key


def _weighted_values(f: Field, ftype: FieldType, dist: Distribution, rng: np.random.Generator, n: int) -> list[Any]:
    weights = dist.weights or {}
    if f.enum:
        by_key = {str(v): v for v in f.enum}
        unknown = [k for k in weights if k not in by_key]
        if unknown:
            raise GenerationError(f"{f.name}: weights for values not in the enum: {unknown[:5]}")
        values = list(f.enum)
        w = np.array([weights.get(str(v), 0.0) for v in values], dtype=float)
        if w.sum() <= 0:
            raise GenerationError(f"{f.name}: weights for the enum values sum to 0")
    else:
        values = [_coerce_key(k, ftype) for k in weights]
        w = np.array(list(weights.values()), dtype=float)
    # ``choice`` with probabilities draws one uniform per row, so the output stays prefix-stable.
    idx = rng.choice(len(values), size=n, p=w / w.sum())
    return [values[i] for i in idx]


def _shaped_numeric(f: Field, ftype: FieldType, dist: Distribution, rng: np.random.Generator, n: int) -> list[Any]:
    lo, hi = _numeric_range(f)
    span = hi - lo if hi > lo else max(abs(lo), 1.0)
    if dist.kind == "normal":
        mean = dist.mean if dist.mean is not None else (lo + hi) / 2
        std = dist.std if dist.std is not None else span / 6 or 1.0
        x = rng.normal(mean, std, n)
    else:
        sigma = dist.sigma or 0.75
        if dist.mean is not None:
            x = rng.lognormal(dist.mean, sigma, n)
        else:
            # Right-skewed within the range: the 99th percentile of lognormal(0, sigma) maps to ``hi``.
            x = lo + span * rng.lognormal(0.0, sigma, n) / math.exp(2.326 * sigma)
    x = np.clip(x, f.minimum if f.minimum is not None else -np.inf, f.maximum if f.maximum is not None else np.inf)
    if ftype == FieldType.INTEGER:
        ints = np.rint(x)
        lo_i = math.ceil(f.minimum) if f.minimum is not None else -np.inf
        hi_i = math.floor(f.maximum) if f.maximum is not None else np.inf
        return np.clip(ints, lo_i, hi_i).astype(np.int64).tolist()
    return np.round(x, 2).tolist()


def _primitive_values(f: Field, ftype: FieldType, rng: np.random.Generator, n: int, dist: Distribution | None = None) -> list[Any]:
    if dist is not None and dist.kind == "weights":
        return _weighted_values(f, ftype, dist, rng, n)
    if f.enum:
        return [f.enum[i] for i in rng.integers(0, len(f.enum), n)]
    if dist is not None and dist.kind in ("normal", "lognormal"):
        if ftype not in (FieldType.INTEGER, FieldType.NUMBER):
            raise GenerationError(f"{f.name}: {dist.kind} distributions apply to integer and number fields")
        return _shaped_numeric(f, ftype, dist, rng, n)
    if ftype == FieldType.INTEGER:
        lo, hi = _numeric_range(f)
        return rng.integers(int(np.ceil(lo)), int(np.floor(hi)) + 1, n).tolist()
    if ftype == FieldType.NUMBER:
        lo, hi = _numeric_range(f)
        return np.round(rng.uniform(lo, hi, n), 2).tolist()
    if ftype == FieldType.BOOLEAN:
        return rng.random(n).__lt__(0.5).tolist()
    if ftype in (FieldType.DATE, FieldType.DATETIME):
        lo = hi = None
        if _BIRTH_RE.search(f.name.lower()):
            lo, hi = date(1940, 1, 1), date(2006, 12, 31)
        fn = gen.date_values if ftype == FieldType.DATE else gen.datetime_values
        return fn(rng, n, lo, hi)
    # strings
    if f.pattern:
        try:
            out = gen.pattern_values(f.pattern, rng, n)
        except gen.UnsupportedPattern:
            out = gen.text_values(rng, n, f.min_length, f.max_length)
    elif f.semantic:
        out = gen.semantic_values(f.semantic, rng, n)
    else:
        out = gen.text_values(rng, n, f.min_length, f.max_length)
    if f.max_length:
        out = [s[: f.max_length] for s in out]
    return out


_STRING_ANOMALIES = ["", "   ", "N/A", "NULL", "#ERROR!", "\u03a9\u2248\u00e7 \U0001f642 \u200b", "' OR '1'='1", "-", "?"]


def _anomaly_values(f: Field, rng: np.random.Generator, n: int) -> list[Any] | None:
    """Edge-case values for GEN-009 (``None`` means the field type has no meaningful anomaly).

    One choice is drawn per row, so the output is prefix-stable like every other column.
    """
    picks = rng.integers(0, 1_000_000, n)
    if f.type in (FieldType.INTEGER, FieldType.NUMBER):
        lo, hi = _numeric_range(f)
        span = max(hi - lo, 1.0)
        raw = [hi + 10 * span, lo - 10 * span, 0, -1, hi * 1000 if hi else 10**9]
        choices: list[Any] = [int(c) for c in raw] if f.type == FieldType.INTEGER else [float(c) for c in raw]
    elif f.type == FieldType.STRING:
        choices = [*_STRING_ANOMALIES, "x" * ((f.max_length or 200) + 50)]
        if f.enum:
            choices.append("UNKNOWN_VALUE")
    elif f.type == FieldType.DATE:
        choices = [date(1900, 1, 1), date(2099, 12, 31), date(1970, 1, 1)]
    elif f.type == FieldType.DATETIME:
        choices = [datetime(1900, 1, 1, tzinfo=UTC), datetime(2099, 12, 31, 23, 59, 59, tzinfo=UTC), datetime(1970, 1, 1, tzinfo=UTC)]
    else:
        return None
    return [choices[p % len(choices)] for p in picks]


def _make_unique(f: Field, col: list[Any], rng: np.random.Generator) -> list[Any]:
    n = len(col)
    if f.type == FieldType.INTEGER and not f.enum:
        lo, hi = _numeric_range(f)
        lo_i, hi_i = int(np.ceil(lo)), int(np.floor(hi))
        if hi_i - lo_i + 1 < n:
            hi_i = lo_i + n - 1
            if f.maximum is not None:
                raise GenerationError(f"{f.name}: range [{lo_i}, {int(f.maximum)}] is too small for {n} unique values")
        return (lo_i + rng.permutation(hi_i - lo_i + 1)[:n]).tolist()
    if f.enum:
        if len(set(f.enum)) < n:
            raise GenerationError(f"{f.name}: enum has fewer values than the {n} unique rows requested")
        return [f.enum[i] for i in rng.permutation(len(f.enum))[:n]]
    if f.type not in (FieldType.STRING,):
        raise GenerationError(f"{f.name}: unique constraint is only supported for integer, string and enum fields")
    seen: set[str] = set()
    out = []
    for i, v in enumerate(col):
        if v in seen:
            if f.semantic == Semantic.EMAIL and "@" in v:
                local, domain = v.split("@", 1)
                v = f"{local}.{i}@{domain}"
            else:
                v = f"{v}-{i}"
        seen.add(v)
        out.append(v)
    return out


def _pk_values(entity: Entity, pk: Field, n: int, seed: int) -> list[Any]:
    if pk.type == FieldType.INTEGER:
        start = int(pk.minimum) if pk.minimum is not None else 1
        return list(range(start, start + n))
    if pk.semantic == Semantic.UUID or pk.type != FieldType.STRING:
        return gen.semantic_values(Semantic.UUID, _rng(seed, entity.name, pk.name), n)
    prefix = re.sub(r"[^A-Z]", "", entity.name.upper())[:3] or "ID"
    return [f"{prefix}{i:07d}" for i in range(1, n + 1)]


def _owner_fk(schema: Schema, entity: Entity) -> Field | None:
    """The first non-self FK decides how rows are distributed across parents (1:N)."""
    return next((f for f in entity.fields if f.references and f.references.entity != entity.name), None)


def plan_counts(schema: Schema, options: GenerationOptions) -> dict[str, int]:
    """Expected rows per entity, used for the size estimate before generating."""
    lo, hi = options.children_per_parent
    expected: dict[str, int] = {}
    for entity in schema.topological_order():
        if entity.name in options.counts:
            expected[entity.name] = options.counts[entity.name]
            continue
        owner = _owner_fk(schema, entity)
        if owner is None:
            expected[entity.name] = options.count
        else:
            expected[entity.name] = int(expected[owner.references.entity] * (lo + hi) / 2)  # type: ignore[union-attr]
    return expected


def generate(schema: Schema, options: GenerationOptions, *, limit_rows: int | None = None) -> dict[str, pd.DataFrame]:
    """Generate every entity. ``limit_rows`` caps each entity (used for previews, GEN-010)."""
    ensure_valid(schema)
    for target in options.distributions:
        ent_name, field_name = target.split(".", 1)
        ent = schema.entity(ent_name)
        if ent is None or ent.field(field_name) is None:
            raise GenerationError(f"distribution target {target!r} is not a field of the schema")
    lo, hi = options.children_per_parent
    frames: dict[str, pd.DataFrame] = {}
    for entity in schema.topological_order():
        owner = _owner_fk(schema, entity)
        owner_col: list[Any] | None = None
        if entity.name in options.counts or owner is None:
            n = options.counts.get(entity.name, options.count)
            if limit_rows is not None:
                n = min(n, limit_rows)
        else:
            parent_pks = frames[owner.references.entity][owner.references.field].tolist()  # type: ignore[union-attr]
            per_parent = _rng(options.seed, entity.name, "__fanout__").integers(lo, hi + 1, len(parent_pks))
            owner_col = np.repeat(np.array(parent_pks, dtype=object), per_parent).tolist()
            if limit_rows is not None:
                owner_col = owner_col[:limit_rows]
            n = len(owner_col)

        columns: dict[str, list[Any]] = {}
        for f in entity.fields:
            # Separate streams for values, uniqueness fixes and the null mask keep every
            # column prefix-stable, so previews equal the head of the full output (GEN-010).
            rng, unique_rng, null_rng = _rng(options.seed, entity.name, f.name).spawn(3)
            if f.primary_key:
                col = _pk_values(entity, f, n, options.seed)
            elif owner is not None and f is owner and owner_col is not None:
                col = owner_col
            elif f.references:
                if f.references.entity == entity.name:
                    # Self-reference (e.g. manager_id): point at an earlier row, first row is the root.
                    pk_field = entity.field(f.references.field)
                    pks = _pk_values(entity, pk_field, n, options.seed)  # type: ignore[arg-type]
                    idx = [int(rng.integers(0, i)) if i else None for i in range(n)]
                    col = [pks[j] if j is not None else None for j in idx]
                else:
                    parent_values = frames[f.references.entity][f.references.field].to_numpy(dtype=object)
                    if len(parent_values) == 0:
                        raise GenerationError(f"{entity.name}.{f.name}: parent {f.references.entity} has no rows")
                    col = parent_values[rng.integers(0, len(parent_values), n)].tolist()
            elif f.type == FieldType.ARRAY:
                size_rng, item_rng = rng.spawn(2)
                sizes = size_rng.integers(0, 4, n)
                flat = _primitive_values(f, f.items_type or FieldType.STRING, item_rng, int(sizes.sum()))
                col, pos = [], 0
                for size in sizes:
                    col.append(flat[pos : pos + size])
                    pos += size
            else:
                col = _primitive_values(f, f.type, rng, n, options.distributions.get(f"{entity.name}.{f.name}"))
                if f.unique:
                    col = _make_unique(f, col, unique_rng)
                elif options.anomaly_rate > 0:
                    # GEN-009: a separate stream, so anomalies never shift the regular values.
                    mask_rng, value_rng = _rng(options.seed, entity.name, f.name, "__anomaly__").spawn(2)
                    mask = mask_rng.random(n) < options.anomaly_rate
                    replacements = _anomaly_values(f, value_rng, n)
                    if replacements is not None:
                        col = [r if m else v for v, r, m in zip(col, replacements, mask)]
            if f.nullable and not (f.primary_key or f.unique) and options.null_rate > 0 and not (owner is not None and f is owner):
                mask = null_rng.random(n) < options.null_rate
                col = [None if m else v for v, m in zip(col, mask)]
            columns[f.name] = col
        frames[entity.name] = pd.DataFrame(columns, columns=[f.name for f in entity.fields])
    return frames


def preview(schema: Schema, options: GenerationOptions) -> dict[str, pd.DataFrame]:
    """First 50 rows per entity (GEN-010).

    Root entities match the head of the full output exactly. In child entities,
    FKs to non-owner parents are drawn from the smaller preview parent set, so
    those values can differ.
    """
    return generate(schema, options, limit_rows=PREVIEW_ROWS)


def estimate_bytes(schema: Schema, options: GenerationOptions) -> int:
    """Estimate CSV output size from a 200-row sample (SCH-NFR-004)."""
    sample_opts = options.model_copy(
        update={"counts": {k: min(v, 200) for k, v in options.counts.items()}, "count": min(options.count, 200)}
    )
    sample = generate(schema, sample_opts, limit_rows=200)
    planned = plan_counts(schema, options)
    total = 0
    for name, frame in sample.items():
        if len(frame) == 0:
            continue
        buf = io.StringIO()
        frame.to_csv(buf, index=False)
        total += int(len(buf.getvalue().encode()) / len(frame) * planned[name])
    return total


def check_size(schema: Schema, options: GenerationOptions) -> int:
    """Raise GenerationTooLarge if the estimate exceeds the 1 GB limit. Returns the estimate."""
    estimate = estimate_bytes(schema, options)
    if estimate > settings.max_dataset_bytes:
        max_count = max(1, int(options.count * settings.max_dataset_bytes / estimate * 0.95))
        raise GenerationTooLarge(estimate, max_count)
    return estimate
