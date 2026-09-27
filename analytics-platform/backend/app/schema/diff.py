"""Structural diff between two canonical schemas (SCH-010, INF-007, INF-008).

Entities and fields are matched by name (case-insensitively as a fallback). The
diff lists added/removed entities and fields, retyped fields and changed
constraints, and flags changes that can break downstream consumers.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from .model import Entity, Schema
from .model import Field as SchemaField

# Attributes compared per field, in report order. ``type``/``items_type`` changes are reported as retypes.
COMPARED_ATTRIBUTES = (
    "nullable",
    "primary_key",
    "unique",
    "enum",
    "minimum",
    "maximum",
    "min_length",
    "max_length",
    "pattern",
    "references",
    "semantic",
    "pii",
    "annotations",
)


class FieldSummary(BaseModel):
    name: str
    type: str
    nullable: bool


class Retype(BaseModel):
    field: str
    from_type: str
    to_type: str


class AttributeChange(BaseModel):
    field: str
    attribute: str
    from_value: Any = Field(default=None, alias="from")
    to_value: Any = Field(default=None, alias="to")

    model_config = {"populate_by_name": True, "serialize_by_alias": True}


class EntityDiff(BaseModel):
    name: str
    added_fields: list[FieldSummary] = Field(default_factory=list)
    removed_fields: list[FieldSummary] = Field(default_factory=list)
    retyped_fields: list[Retype] = Field(default_factory=list)
    changed_fields: list[AttributeChange] = Field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not (self.added_fields or self.removed_fields or self.retyped_fields or self.changed_fields)


class SchemaDiff(BaseModel):
    identical: bool
    added_entities: list[str] = Field(default_factory=list)
    removed_entities: list[str] = Field(default_factory=list)
    entities: list[EntityDiff] = Field(default_factory=list)
    # Removed entities/fields, retypes, nullable → required, new required fields, narrowed enums.
    breaking: bool = False
    summary: list[str] = Field(default_factory=list)


def _type_label(f: SchemaField) -> str:
    return f"array<{f.items_type.value}>" if f.type.value == "array" and f.items_type else f.type.value


def _summary(f: SchemaField) -> FieldSummary:
    return FieldSummary(name=f.name, type=_type_label(f), nullable=f.nullable)


def _match(names_a: list[str], names_b: list[str]) -> tuple[list[tuple[str, str]], list[str], list[str]]:
    """Pair names exactly, then case-insensitively. Returns (pairs, only_in_a, only_in_b)."""
    pairs: list[tuple[str, str]] = []
    rest_b = list(names_b)
    unmatched_a: list[str] = []
    for a in names_a:
        if a in rest_b:
            pairs.append((a, a))
            rest_b.remove(a)
        else:
            unmatched_a.append(a)
    only_a: list[str] = []
    for a in unmatched_a:
        hit = next((b for b in rest_b if b.lower() == a.lower()), None)
        if hit is None:
            only_a.append(a)
        else:
            pairs.append((a, hit))
            rest_b.remove(hit)
    return pairs, only_a, rest_b


def _jsonable(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if hasattr(value, "value") and not isinstance(value, (int, float, str, bool)):
        return value.value
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    return value


def diff_entities(a: Entity, b: Entity) -> EntityDiff:
    out = EntityDiff(name=b.name)
    pairs, removed, added = _match([f.name for f in a.fields], [f.name for f in b.fields])
    out.removed_fields = [_summary(a.field(n)) for n in removed]  # type: ignore[arg-type]
    out.added_fields = [_summary(b.field(n)) for n in added]  # type: ignore[arg-type]
    for name_a, name_b in pairs:
        fa, fb = a.field(name_a), b.field(name_b)
        assert fa is not None and fb is not None
        if _type_label(fa) != _type_label(fb):
            out.retyped_fields.append(Retype(field=fb.name, from_type=_type_label(fa), to_type=_type_label(fb)))
        for attr in COMPARED_ATTRIBUTES:
            va, vb = _jsonable(getattr(fa, attr, None)), _jsonable(getattr(fb, attr, None))
            if attr == "annotations":
                va, vb = sorted(va or []), sorted(vb or [])
            if va != vb:
                out.changed_fields.append(AttributeChange(field=fb.name, attribute=attr, from_value=va, to_value=vb))
    return out


def _is_breaking(entity: EntityDiff) -> bool:
    if entity.removed_fields or entity.retyped_fields:
        return True
    if any(not f.nullable for f in entity.added_fields):
        return True
    for c in entity.changed_fields:
        if c.attribute == "nullable" and c.from_value is True and c.to_value is False:
            return True
        if c.attribute in ("primary_key", "unique") and c.to_value is True:
            return True
        if (
            c.attribute == "enum"
            and c.to_value is not None
            and (c.from_value is None or not set(map(str, c.from_value)) <= set(map(str, c.to_value)))
        ):
            return True
        if c.attribute == "references" and c.from_value is not None:
            return True
    return False


def diff_schemas(a: Schema, b: Schema) -> SchemaDiff:
    """What changed going from ``a`` (old) to ``b`` (new)."""
    pairs, removed, added = _match([e.name for e in a.entities], [e.name for e in b.entities])
    diff = SchemaDiff(identical=False, added_entities=added, removed_entities=removed)
    for name_a, name_b in pairs:
        ed = diff_entities(a.entity(name_a), b.entity(name_b))  # type: ignore[arg-type]
        if not ed.empty:
            diff.entities.append(ed)
    diff.identical = not (added or removed or diff.entities)
    diff.breaking = bool(removed) or any(_is_breaking(e) for e in diff.entities)
    summary = [f"entity {n} added" for n in added] + [f"entity {n} removed" for n in removed]
    for e in diff.entities:
        summary += [f"{e.name}.{f.name} added ({f.type})" for f in e.added_fields]
        summary += [f"{e.name}.{f.name} removed" for f in e.removed_fields]
        summary += [f"{e.name}.{r.field} retyped {r.from_type} → {r.to_type}" for r in e.retyped_fields]
        summary += [f"{e.name}.{c.field}: {c.attribute} {c.from_value!r} → {c.to_value!r}" for c in e.changed_fields]
    diff.summary = summary
    return diff
