"""Keys and relationships across the tables of one dataset (INF-004, INF-005).

* Primary keys: each table is inferred on its own (``infer_schema`` promotes the
  leftmost id-like unique, non-null column). A table without one gets its
  referenced unique column promoted when another table points at it.
* Foreign keys: a column ``c`` of table A references key ``k`` of table B when
  - the names are similar (``customer_id`` ↔ ``customers.id``, ``cust_id`` ↔ ``customers``,
    or the same non-generic key name in both tables), score ≥ 0.7, and
  - at least 95% of A.c's distinct non-null values occur in B.k (value containment).

Containment is computed on the inference samples (first 10K rows plus a 50K
reservoir), so it is exact for tables up to 60K rows and an estimate above that.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher

import pandas as pd

from ..schema.model import ColumnRole, Entity, FieldType, ForeignKey, Schema, SchemaValidationError
from .inference import ColumnReport, InferenceResult, Relationship, infer_schema, normalize_name

CONTAINMENT_THRESHOLD = 0.95
NAME_THRESHOLD = 0.7
_KEY_SUFFIX_RE = re.compile(r"(_?(id|key|code|no|num|number|fk|ref))$")
_KEY_TYPES = (FieldType.INTEGER, FieldType.STRING)


def singular(name: str) -> str:
    if name.endswith("ies") and len(name) > 4:
        return name[:-3] + "y"
    if name.endswith(("ses", "xes", "zes", "ches", "shes")):
        return name[:-2]
    if name.endswith("s") and not name.endswith("ss"):
        return name[:-1]
    return name


def name_similarity(child_field: str, parent_entity: str, parent_key: str) -> float:
    """How strongly a column name suggests it references ``parent_entity.parent_key`` (0–1)."""
    child = child_field.lower()
    entity, key = parent_entity.lower(), parent_key.lower()
    one = singular(entity)
    if child == key and not re.fullmatch(r"(id|key|code)", key):
        return 1.0  # the same specific key name in both tables (customer_id ↔ customer_id)
    targets = {f"{one}_{key}", f"{entity}_{key}", f"{one}{key}"}
    if key in ("id", "key", "code"):
        targets |= {f"{one}_id", f"{entity}_id"}
    score = max(SequenceMatcher(None, child, t).ratio() for t in targets)
    base = _KEY_SUFFIX_RE.sub("", child).strip("_")
    if base and base != child:
        score = max(score, SequenceMatcher(None, base, one).ratio(), SequenceMatcher(None, base, entity).ratio())
        if len(base) >= 3 and (one.startswith(base) or base.startswith(one)):
            score = max(score, 0.9)
    return round(score, 4)


def _key_values(series: pd.Series) -> set[str]:
    values = series.dropna()
    if pd.api.types.is_float_dtype(values):
        values = values[values == values.round()].astype("int64")
    return {str(v).strip() for v in values.unique().tolist() if str(v).strip() != ""}


def _column(frame: pd.DataFrame, report: ColumnReport) -> pd.Series:
    return frame[report.source_name] if report.source_name in frame.columns else frame[report.name]


def _acyclic(schema: Schema) -> bool:
    try:
        schema.topological_order()
        return True
    except SchemaValidationError:
        return False


def infer_multi_table(
    frames: dict[str, pd.DataFrame],
    *,
    name: str = "dataset",
    containment_threshold: float = CONTAINMENT_THRESHOLD,
    name_threshold: float = NAME_THRESHOLD,
) -> InferenceResult:
    """Infer one entity per table, then detect keys and foreign keys between them."""
    entities: list[Entity] = []
    reports: dict[str, list[ColumnReport]] = {}
    table_frames: dict[str, pd.DataFrame] = {}
    warnings: list[str] = []
    taken: set[str] = set()
    for table, frame in frames.items():
        entity_name = normalize_name(table, taken)
        result = infer_schema(frame, entity_name=entity_name)
        entity = result.schema_.entities[0]
        entity.name = entity_name
        entities.append(entity)
        for r in result.columns:
            r.table = entity_name
        reports[entity_name] = result.columns
        table_frames[entity_name] = frame
        warnings.extend(f"{entity_name}: {w}" for w in result.warnings)

    schema = Schema(name=name, entities=entities)
    by_name = {e.name: e for e in entities}

    # Candidate keys per table: the PK, or unique non-null id-like/any unique columns (INF-004).
    keys: dict[str, list[str]] = {}
    for entity in entities:
        cands = [r.name for r in reports[entity.name] if r.primary_key_candidate and r.type in _KEY_TYPES]
        pk = entity.primary_key
        keys[entity.name] = [pk.name] if pk else cands
    key_values: dict[tuple[str, str], set[str]] = {}

    def values_of(entity: str, field: str) -> set[str]:
        if (entity, field) not in key_values:
            report = next(r for r in reports[entity] if r.name == field)
            key_values[(entity, field)] = _key_values(_column(table_frames[entity], report))
        return key_values[(entity, field)]

    relationships: list[Relationship] = []
    for child in entities:
        for report in reports[child.name]:
            f = child.field(report.name)
            if f is None or f.primary_key or f.type not in _KEY_TYPES or f.references is not None:
                continue
            child_vals: set[str] | None = None
            best: Relationship | None = None
            for parent in entities:
                if parent.name == child.name:
                    continue
                for key in keys[parent.name]:
                    target = parent.field(key)
                    if target is None:
                        continue
                    score = name_similarity(f.name, parent.name, key)
                    if score < name_threshold:
                        continue
                    if child_vals is None:
                        child_vals = values_of(child.name, f.name)
                    if not child_vals:
                        break
                    parent_vals = values_of(parent.name, key)
                    containment = len(child_vals & parent_vals) / len(child_vals)
                    if containment < containment_threshold:
                        continue
                    candidate = Relationship(
                        child_entity=child.name,
                        child_field=f.name,
                        parent_entity=parent.name,
                        parent_field=key,
                        name_score=score,
                        containment=round(containment, 4),
                    )
                    if best is None or (score + containment) > (best.name_score + best.containment):
                        best = candidate
            if best is None:
                continue
            parent = by_name[best.parent_entity]
            target = parent.field(best.parent_field)
            assert target is not None
            if not target.primary_key and (parent.primary_key is None or not target.unique):
                # INF-004: a referenced key becomes the table's primary key (or at least unique).
                idx = parent.fields.index(target)
                promote = parent.primary_key is None
                parent.fields[idx] = target.model_copy(
                    update={"unique": True, "nullable": False, "primary_key": promote, "role": ColumnRole.IDENTIFIER}
                )
            idx = child.fields.index(f)
            child.fields[idx] = f.model_copy(update={"references": ForeignKey(entity=best.parent_entity, field=best.parent_field)})
            if not _acyclic(schema):
                child.fields[idx] = f
                warnings.append(f"{child.name}.{f.name} → {best.parent_entity}.{best.parent_field} skipped: it would create a cycle")
                continue
            relationships.append(best)

    columns = [r for e in entities for r in reports[e.name]]
    return InferenceResult(
        schema_=schema,
        columns=columns,
        sampled_rows=sum(len(f) for f in frames.values()),
        warnings=warnings,
        relationships=relationships,
    )
