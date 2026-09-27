"""Canonical schema model (SCH-*, INF-*).

Every schema input format (JSON Schema, XSD, natural language, and later SQL
DDL / Avro) is parsed into this one model, and every downstream module
(generation, inference, profiling, LLM context) consumes it.
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Any

from pydantic import BaseModel, model_validator
from pydantic import Field as PField

IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")


class FieldType(str, Enum):
    STRING = "string"
    INTEGER = "integer"
    NUMBER = "number"
    BOOLEAN = "boolean"
    DATE = "date"
    DATETIME = "datetime"
    ARRAY = "array"  # array of primitives; arrays of objects become child entities


class Semantic(str, Enum):
    """Domain meaning of a field — drives realistic generation (GEN-003) and PII tagging (INF-009)."""

    EMAIL = "email"
    PHONE = "phone"
    FIRST_NAME = "first_name"
    LAST_NAME = "last_name"
    FULL_NAME = "full_name"
    ADDRESS = "address"
    CITY = "city"
    COUNTRY = "country"
    POSTAL_CODE = "postal_code"
    URL = "url"
    UUID = "uuid"
    SSN = "ssn"
    CREDIT_CARD = "credit_card"
    IP_ADDRESS = "ip_address"
    COMPANY = "company"
    PRODUCT = "product"
    CURRENCY = "currency"


PII_SEMANTICS = frozenset(
    {
        Semantic.EMAIL,
        Semantic.PHONE,
        Semantic.FIRST_NAME,
        Semantic.LAST_NAME,
        Semantic.FULL_NAME,
        Semantic.ADDRESS,
        Semantic.POSTAL_CODE,
        Semantic.SSN,
        Semantic.CREDIT_CARD,
        Semantic.IP_ADDRESS,
    }
)


class ColumnRole(str, Enum):
    """Analytical role of a column (INF-003)."""

    IDENTIFIER = "identifier"
    CATEGORICAL = "categorical"
    CONTINUOUS = "continuous"
    DATETIME = "datetime"
    TEXT = "text"
    BOOLEAN = "boolean"


class ForeignKey(BaseModel):
    entity: str
    field: str


class Field(BaseModel):
    name: str
    type: FieldType = FieldType.STRING
    items_type: FieldType | None = None  # for ARRAY
    nullable: bool = True
    primary_key: bool = False
    unique: bool = False
    enum: list[Any] | None = None
    minimum: float | None = None
    maximum: float | None = None
    min_length: int | None = None
    max_length: int | None = None
    pattern: str | None = None
    semantic: Semantic | None = None
    role: ColumnRole | None = None
    pii: bool = False
    references: ForeignKey | None = None
    description: str | None = None
    # Original column name in an uploaded file, when it differed from ``name`` (INF-001).
    source_name: str | None = None

    @model_validator(mode="after")
    def _normalize(self) -> Field:
        if self.primary_key:
            self.nullable = False
            self.unique = True
        if self.semantic in PII_SEMANTICS:
            self.pii = True
        return self


class Entity(BaseModel):
    name: str
    fields: list[Field]
    description: str | None = None

    def field(self, name: str) -> Field | None:
        return next((f for f in self.fields if f.name == name), None)

    @property
    def primary_key(self) -> Field | None:
        return next((f for f in self.fields if f.primary_key), None)


def column_renames(entity: Entity) -> dict[str, str]:
    """{source column name: canonical field name} for columns renamed during inference."""
    return {f.source_name: f.name for f in entity.fields if f.source_name and f.source_name != f.name}


class Schema(BaseModel):
    name: str = "schema"
    entities: list[Entity] = PField(default_factory=list)

    def entity(self, name: str) -> Entity | None:
        return next((e for e in self.entities if e.name == name), None)

    def relationships(self) -> list[tuple[str, str, str, str]]:
        """(child_entity, child_field, parent_entity, parent_field) for every FK."""
        return [(e.name, f.name, f.references.entity, f.references.field) for e in self.entities for f in e.fields if f.references]

    def topological_order(self) -> list[Entity]:
        """Parents before children, so FK targets exist when children are generated (GEN-005).

        Self-references are allowed (e.g. employees.manager_id) and ignored for ordering.
        """
        deps = {e.name: set() for e in self.entities}
        for child, _, parent, _ in self.relationships():
            if child != parent and parent in deps:
                deps[child].add(parent)
        ordered: list[str] = []
        visiting: set[str] = set()

        def visit(name: str) -> None:
            if name in ordered:
                return
            if name in visiting:
                raise SchemaValidationError([Issue(path=f"/entities/{name}", message="circular foreign-key dependency")])
            visiting.add(name)
            for dep in sorted(deps[name]):
                visit(dep)
            visiting.discard(name)
            ordered.append(name)

        for e in self.entities:
            visit(e.name)
        return [self.entity(n) for n in ordered]  # type: ignore[misc]


class Issue(BaseModel):
    """A located problem in a schema (SCH-009). ``path`` is a JSON Pointer or ``line:col``."""

    path: str
    message: str
    severity: str = "error"  # "error" | "warning"


class SchemaValidationError(ValueError):
    def __init__(self, issues: list[Issue]):
        self.issues = issues
        super().__init__("; ".join(f"{i.path}: {i.message}" for i in issues))


NUMERIC_TYPES = (FieldType.INTEGER, FieldType.NUMBER)


def validate_schema(schema: Schema) -> list[Issue]:
    """Structural validation. Returns errors and warnings; callers decide whether to raise."""
    issues: list[Issue] = []
    if not schema.entities:
        issues.append(Issue(path="/entities", message="schema has no entities"))
    seen_entities: set[str] = set()
    for ei, entity in enumerate(schema.entities):
        base = f"/entities/{ei}"
        if not IDENTIFIER_RE.match(entity.name):
            issues.append(Issue(path=f"{base}/name", message=f"invalid entity name {entity.name!r}"))
        if entity.name in seen_entities:
            issues.append(Issue(path=f"{base}/name", message=f"duplicate entity {entity.name!r}"))
        seen_entities.add(entity.name)
        if not entity.fields:
            issues.append(Issue(path=f"{base}/fields", message=f"entity {entity.name!r} has no fields"))
        if sum(f.primary_key for f in entity.fields) > 1:
            issues.append(Issue(path=f"{base}/fields", message="composite primary keys are not supported yet"))
        seen_fields: set[str] = set()
        for fi, f in enumerate(entity.fields):
            fp = f"{base}/fields/{fi}"
            if not IDENTIFIER_RE.match(f.name):
                issues.append(Issue(path=f"{fp}/name", message=f"invalid field name {f.name!r}"))
            if f.name in seen_fields:
                issues.append(Issue(path=f"{fp}/name", message=f"duplicate field {f.name!r} in {entity.name!r}"))
            seen_fields.add(f.name)
            if f.minimum is not None and f.maximum is not None and f.minimum > f.maximum:
                issues.append(Issue(path=fp, message="minimum is greater than maximum"))
            if f.min_length is not None and f.max_length is not None and f.min_length > f.max_length:
                issues.append(Issue(path=fp, message="min_length is greater than max_length"))
            if (f.minimum is not None or f.maximum is not None) and f.type not in (*NUMERIC_TYPES, FieldType.DATE, FieldType.DATETIME):
                issues.append(Issue(path=fp, message=f"minimum/maximum ignored for type {f.type.value}", severity="warning"))
            if f.enum is not None and len(f.enum) == 0:
                issues.append(Issue(path=f"{fp}/enum", message="enum must not be empty"))
            if f.pattern:
                try:
                    re.compile(f.pattern)
                except re.error as exc:
                    issues.append(Issue(path=f"{fp}/pattern", message=f"invalid regex: {exc}"))
            if f.type == FieldType.ARRAY and f.items_type in (None, FieldType.ARRAY):
                issues.append(Issue(path=fp, message="array fields need a primitive items_type"))
    for ei, entity in enumerate(schema.entities):
        for fi, f in enumerate(entity.fields):
            if not f.references:
                continue
            fp = f"/entities/{ei}/fields/{fi}/references"
            parent = schema.entity(f.references.entity)
            if parent is None:
                issues.append(Issue(path=fp, message=f"references unknown entity {f.references.entity!r}"))
                continue
            target = parent.field(f.references.field)
            if target is None:
                issues.append(Issue(path=fp, message=f"references unknown field {f.references.entity}.{f.references.field}"))
            elif not (target.primary_key or target.unique):
                issues.append(Issue(path=fp, message="foreign keys must reference a primary key or unique field"))
    if not any(i.severity == "error" for i in issues):
        try:
            schema.topological_order()
        except SchemaValidationError as exc:
            issues.extend(exc.issues)
    return issues


def ensure_valid(schema: Schema) -> list[Issue]:
    """Raise on errors; return warnings."""
    issues = validate_schema(schema)
    errors = [i for i in issues if i.severity == "error"]
    if errors:
        raise SchemaValidationError(errors)
    return issues


def to_json_schema(schema: Schema) -> dict[str, Any]:
    """Export as JSON Schema 2020-12 (SCH-011). Each entity becomes a ``$defs`` entry."""
    type_map = {
        FieldType.STRING: ("string", None),
        FieldType.INTEGER: ("integer", None),
        FieldType.NUMBER: ("number", None),
        FieldType.BOOLEAN: ("boolean", None),
        FieldType.DATE: ("string", "date"),
        FieldType.DATETIME: ("string", "date-time"),
    }
    semantic_formats = {Semantic.EMAIL: "email", Semantic.UUID: "uuid", Semantic.URL: "uri", Semantic.IP_ADDRESS: "ipv4"}

    def prop(f: Field) -> dict[str, Any]:
        if f.type == FieldType.ARRAY:
            jt, fmt = type_map[f.items_type or FieldType.STRING]
            out: dict[str, Any] = {"type": "array", "items": {"type": jt, **({"format": fmt} if fmt else {})}}
        else:
            jt, fmt = type_map[f.type]
            fmt = fmt or semantic_formats.get(f.semantic)  # type: ignore[arg-type]
            out = {"type": [jt, "null"] if f.nullable else jt}
            if fmt:
                out["format"] = fmt
        for key, val in (
            ("enum", f.enum),
            ("minimum", f.minimum),
            ("maximum", f.maximum),
            ("minLength", f.min_length),
            ("maxLength", f.max_length),
            ("pattern", f.pattern),
            ("description", f.description),
        ):
            if val is not None:
                out[key] = val
        if f.semantic:
            out["x-semantic"] = f.semantic.value
        if f.primary_key:
            out["x-primary-key"] = True
        if f.unique and not f.primary_key:
            out["x-unique"] = True
        if f.references:
            out["x-foreign-key"] = f"{f.references.entity}.{f.references.field}"
        return out

    defs = {
        e.name: {
            "type": "object",
            "properties": {f.name: prop(f) for f in e.fields},
            "required": [f.name for f in e.fields if not f.nullable],
            "additionalProperties": False,
        }
        for e in schema.entities
    }
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": schema.name,
        "type": "object",
        "properties": {e.name: {"type": "array", "items": {"$ref": f"#/$defs/{e.name}"}} for e in schema.entities},
        "$defs": defs,
    }
