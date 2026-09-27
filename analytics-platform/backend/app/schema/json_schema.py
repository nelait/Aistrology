"""JSON Schema → canonical schema (SCH-001, SCH-007, SCH-008, SCH-009).

Mapping rules:

* The root object becomes an entity (named after ``title``, else ``root``).
  If the root has *only* array-of-object properties (``{"customers": [...],
  "orders": [...]}``), each of those becomes a top-level entity instead.
* Nested objects are flattened into ``parent_child`` columns (1:1).
* Arrays of objects become child entities with a generated FK to the parent,
  and the parent gets an ``id`` primary key if it has none.
* ``$ref`` to ``#/$defs/…`` / ``#/definitions/…`` is resolved in-document.
* Extensions: ``x-primary-key``, ``x-unique``, ``x-semantic`` and
  ``x-foreign-key: "entity.field"`` (what :func:`to_json_schema` emits, so exports round-trip).
"""

from __future__ import annotations

import json
import re
from typing import Any

from .model import (
    Entity,
    Field,
    FieldType,
    ForeignKey,
    Issue,
    Schema,
    SchemaValidationError,
    Semantic,
    ensure_valid,
)
from .semantics import guess_semantic

_FORMAT_TYPES = {"date": FieldType.DATE, "date-time": FieldType.DATETIME}
_FORMAT_SEMANTICS = {
    "email": Semantic.EMAIL,
    "idn-email": Semantic.EMAIL,
    "uuid": Semantic.UUID,
    "uri": Semantic.URL,
    "url": Semantic.URL,
    "ipv4": Semantic.IP_ADDRESS,
}
_PRIMITIVES = {
    "string": FieldType.STRING,
    "integer": FieldType.INTEGER,
    "number": FieldType.NUMBER,
    "boolean": FieldType.BOOLEAN,
}
_MAX_REF_DEPTH = 32


def _safe_name(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_]", "_", name).strip("_") or "field"
    return f"_{cleaned}" if cleaned[0].isdigit() else cleaned


def _singular(name: str) -> str:
    if name.endswith("ies"):
        return name[:-3] + "y"
    if name.endswith("s") and not name.endswith("ss"):
        return name[:-1]
    return name


class _Parser:
    def __init__(self, doc: dict[str, Any]):
        self.doc = doc
        self.entities: list[Entity] = []
        self.issues: list[Issue] = []

    # -- helpers ---------------------------------------------------------
    def resolve(self, node: Any, path: str, depth: int = 0) -> tuple[dict[str, Any], str]:
        if not isinstance(node, dict):
            raise SchemaValidationError([Issue(path=path, message="expected an object schema")])
        ref = node.get("$ref")
        if ref is None:
            return node, path
        if depth > _MAX_REF_DEPTH:
            raise SchemaValidationError([Issue(path=path, message="$ref nesting too deep (cycle?)")])
        if not isinstance(ref, str) or not ref.startswith("#/"):
            raise SchemaValidationError([Issue(path=path, message=f"only in-document $ref is supported, got {ref!r}")])
        target: Any = self.doc
        for part in ref[2:].split("/"):
            part = part.replace("~1", "/").replace("~0", "~")
            if not isinstance(target, dict) or part not in target:
                raise SchemaValidationError([Issue(path=path, message=f"unresolvable $ref {ref!r}")])
            target = target[part]
        return self.resolve(target, ref[1:], depth + 1)

    @staticmethod
    def type_of(node: dict[str, Any]) -> tuple[str | None, bool]:
        """Return (json type, nullable-from-type)."""
        t = node.get("type")
        if isinstance(t, list):
            non_null = [x for x in t if x != "null"]
            return (non_null[0] if non_null else None), "null" in t
        if t is None:
            if "properties" in node:
                return "object", False
            if "items" in node:
                return "array", False
            if "enum" in node:
                return "string", False
        return t, False

    # -- entities --------------------------------------------------------
    def parse_root(self) -> None:
        root, path = self.resolve(self.doc, "")
        rtype, _ = self.type_of(root)
        if rtype != "object":
            raise SchemaValidationError([Issue(path=path or "/", message="root schema must be an object")])
        props = root.get("properties") or {}
        collections = {k: v for k, v in props.items() if self._is_object_array(v, f"{path}/properties/{k}")}
        if props and len(collections) == len(props):
            for key, node in props.items():
                items, ipath = self.resolve(node.get("items", {}), f"{path}/properties/{key}/items")
                self.parse_entity(_safe_name(key), items, ipath)
        else:
            self.parse_entity(_safe_name(root.get("title") or "root"), root, path)

    def _is_object_array(self, node: Any, path: str) -> bool:
        try:
            node, _ = self.resolve(node, path)
            if self.type_of(node)[0] != "array":
                return False
            items, _ = self.resolve(node.get("items", {}), f"{path}/items")
            return self.type_of(items)[0] == "object"
        except SchemaValidationError:
            return False

    def parse_entity(self, name: str, node: dict[str, Any], path: str, parent: Entity | None = None) -> Entity:
        entity = Entity(name=name, fields=[], description=node.get("description"))
        self.entities.append(entity)
        if parent is not None:
            parent_pk = self.ensure_pk(parent)
            fk_name = f"{_singular(parent.name)}_{parent_pk.name}"
            entity.fields.append(
                Field(
                    name=fk_name,
                    type=parent_pk.type,
                    nullable=False,
                    references=ForeignKey(entity=parent.name, field=parent_pk.name),
                )
            )
        required = set(node.get("required") or [])
        children: list[tuple[str, dict[str, Any], str]] = []
        for key, child in (node.get("properties") or {}).items():
            self.parse_property(entity, _safe_name(key), child, f"{path}/properties/{key}", key in required, "", children)
        # Child entities are parsed after all of the parent's own columns, so an
        # explicit ``id`` property is found (and reused as the PK) before a FK is generated.
        for child_name, items, ipath in children:
            self.parse_entity(child_name, items, ipath, parent=entity)
        if not entity.fields:
            self.issues.append(Issue(path=path or "/", message=f"object {name!r} has no properties"))
        return entity

    def ensure_pk(self, entity: Entity) -> Field:
        pk = entity.primary_key
        if pk:
            return pk
        existing = entity.field("id")
        if existing and existing.type in (FieldType.INTEGER, FieldType.STRING):
            existing.primary_key, existing.unique, existing.nullable = True, True, False
            return existing
        pk = Field(name="id" if not existing else f"{entity.name}_id", type=FieldType.INTEGER, primary_key=True)
        entity.fields.insert(0, pk)
        return pk

    def parse_property(
        self,
        entity: Entity,
        name: str,
        node: Any,
        path: str,
        required: bool,
        prefix: str,
        children: list[tuple[str, dict[str, Any], str]],
    ) -> None:
        node, path = self.resolve(node, path)
        jtype, nullable_from_type = self.type_of(node)
        full_name = f"{prefix}{name}"
        if jtype == "object":
            # SCH-007: flatten 1:1 nested objects into prefixed columns
            inner_required = set(node.get("required") or [])
            for key, child in (node.get("properties") or {}).items():
                self.parse_property(
                    entity,
                    _safe_name(key),
                    child,
                    f"{path}/properties/{key}",
                    required and key in inner_required,
                    f"{full_name}_",
                    children,
                )
            return
        if jtype == "array":
            items, ipath = self.resolve(node.get("items", {}), f"{path}/items")
            itype, _ = self.type_of(items)
            if itype == "object":
                children.append((_safe_name(full_name), items, ipath))
                return
            items_type = self._primitive(items, itype, ipath)
            entity.fields.append(Field(name=full_name, type=FieldType.ARRAY, items_type=items_type, nullable=not required))
            return
        ftype = self._primitive(node, jtype, path)
        fmt = node.get("format")
        semantic_ext = node.get("x-semantic")
        try:
            semantic = Semantic(semantic_ext) if semantic_ext else _FORMAT_SEMANTICS.get(fmt) or guess_semantic(full_name, ftype)
        except ValueError:
            self.issues.append(Issue(path=f"{path}/x-semantic", message=f"unknown semantic {semantic_ext!r}", severity="warning"))
            semantic = guess_semantic(full_name, ftype)
        minimum = node.get("minimum", node.get("exclusiveMinimum"))
        maximum = node.get("maximum", node.get("exclusiveMaximum"))
        if ftype in (FieldType.DATE, FieldType.DATETIME):
            minimum = maximum = None  # JSON Schema has no date bounds; formatMinimum is non-standard
        fk = node.get("x-foreign-key")
        references = None
        if fk:
            if not isinstance(fk, str) or fk.count(".") != 1:
                self.issues.append(Issue(path=f"{path}/x-foreign-key", message="expected 'entity.field'"))
            else:
                ent, fld = fk.split(".")
                references = ForeignKey(entity=ent, field=fld)
        entity.fields.append(
            Field(
                name=full_name,
                type=ftype,
                nullable=(not required) or nullable_from_type,
                primary_key=bool(node.get("x-primary-key")),
                unique=bool(node.get("x-unique")),
                enum=[v for v in node["enum"] if v is not None] if isinstance(node.get("enum"), list) else None,
                minimum=minimum,
                maximum=maximum,
                min_length=node.get("minLength"),
                max_length=node.get("maxLength"),
                pattern=node.get("pattern"),
                semantic=semantic,
                references=references,
                description=node.get("description"),
            )
        )

    def _primitive(self, node: dict[str, Any], jtype: str | None, path: str) -> FieldType:
        if jtype is None:
            self.issues.append(Issue(path=path, message="no type given; defaulting to string", severity="warning"))
            return FieldType.STRING
        if jtype == "string" and node.get("format") in _FORMAT_TYPES:
            return _FORMAT_TYPES[node["format"]]
        if jtype in _PRIMITIVES:
            return _PRIMITIVES[jtype]
        if jtype == "array":
            self.issues.append(Issue(path=path, message="nested arrays are stored as strings", severity="warning"))
            return FieldType.STRING
        self.issues.append(Issue(path=path, message=f"unsupported type {jtype!r}; using string", severity="warning"))
        return FieldType.STRING


def parse_json_schema(source: str | dict[str, Any]) -> tuple[Schema, list[Issue]]:
    """Parse a JSON Schema document. Returns (schema, warnings); raises SchemaValidationError on errors."""
    if isinstance(source, str):
        try:
            doc = json.loads(source)
        except json.JSONDecodeError as exc:
            raise SchemaValidationError([Issue(path=f"{exc.lineno}:{exc.colno}", message=exc.msg)]) from exc
    else:
        doc = source
    if not isinstance(doc, dict):
        raise SchemaValidationError([Issue(path="/", message="JSON Schema must be an object")])
    parser = _Parser(doc)
    parser.parse_root()
    errors = [i for i in parser.issues if i.severity == "error"]
    if errors:
        raise SchemaValidationError(errors)
    schema = Schema(name=_safe_name(str(doc.get("title") or "schema")), entities=parser.entities)
    warnings = [i for i in parser.issues if i.severity == "warning"]
    return schema, warnings + ensure_valid(schema)
