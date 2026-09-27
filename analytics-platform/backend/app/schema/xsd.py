"""XML Schema (XSD) → canonical schema (SCH-002).

The supported subset is listed in REQUIREMENTS.md (SCH-002). Constructs outside it
are reported as warnings instead of being silently dropped.

Mapping rules follow the JSON Schema parser: every top-level ``xs:element`` with
a complex type becomes an entity, repeated complex children (``maxOccurs > 1``)
become child entities with a generated FK, and single complex children are
flattened into prefixed columns.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET

import defusedxml.ElementTree as SafeET
from defusedxml import DefusedXmlException

from .model import Entity, Field, FieldType, ForeignKey, Issue, Schema, SchemaValidationError, ensure_valid
from .semantics import guess_semantic

XS = "{http://www.w3.org/2001/XMLSchema}"

_BUILTIN_TYPES = {
    "string": FieldType.STRING,
    "normalizedString": FieldType.STRING,
    "token": FieldType.STRING,
    "anyURI": FieldType.STRING,
    "ID": FieldType.STRING,
    "IDREF": FieldType.STRING,
    "int": FieldType.INTEGER,
    "integer": FieldType.INTEGER,
    "long": FieldType.INTEGER,
    "short": FieldType.INTEGER,
    "byte": FieldType.INTEGER,
    "positiveInteger": FieldType.INTEGER,
    "nonNegativeInteger": FieldType.INTEGER,
    "negativeInteger": FieldType.INTEGER,
    "nonPositiveInteger": FieldType.INTEGER,
    "unsignedInt": FieldType.INTEGER,
    "unsignedLong": FieldType.INTEGER,
    "unsignedShort": FieldType.INTEGER,
    "decimal": FieldType.NUMBER,
    "float": FieldType.NUMBER,
    "double": FieldType.NUMBER,
    "boolean": FieldType.BOOLEAN,
    "date": FieldType.DATE,
    "dateTime": FieldType.DATETIME,
}
_IMPLIED_MIN = {"positiveInteger": 1, "nonNegativeInteger": 0, "unsignedInt": 0, "unsignedLong": 0, "unsignedShort": 0}
_IMPLIED_MAX = {"negativeInteger": -1, "nonPositiveInteger": 0}
_UNSUPPORTED = {"choice", "any", "anyAttribute", "group", "attributeGroup", "union", "list", "extension", "import", "include"}
_DTD_RE = re.compile(r"<!\s*(DOCTYPE|ENTITY)", re.IGNORECASE)


def _local(qname: str | None) -> str | None:
    return qname.split(":", 1)[1] if qname and ":" in qname else qname


def _singular(name: str) -> str:
    return name[:-3] + "y" if name.endswith("ies") else name[:-1] if name.endswith("s") and not name.endswith("ss") else name


class _XsdParser:
    def __init__(self, root: ET.Element):
        self.root = root
        self.complex_types = {ct.get("name"): ct for ct in root.findall(f"{XS}complexType") if ct.get("name")}
        self.simple_types = {st.get("name"): st for st in root.findall(f"{XS}simpleType") if st.get("name")}
        self.entities: list[Entity] = []
        self.issues: list[Issue] = []

    def warn(self, path: str, message: str) -> None:
        self.issues.append(Issue(path=path, message=message, severity="warning"))

    def check_unsupported(self, node: ET.Element, path: str) -> None:
        for child in node.iter():
            tag = child.tag.replace(XS, "") if isinstance(child.tag, str) else ""
            if tag in _UNSUPPORTED:
                self.warn(path, f"xs:{tag} is not supported and was ignored")

    def parse(self) -> None:
        for element in self.root.findall(f"{XS}element"):
            name = element.get("name")
            if not name:
                continue
            ctype = self.complex_type_of(element)
            if ctype is None:
                self.warn(f"/element[@name='{name}']", "top-level simple element ignored (no entity)")
                continue
            self.check_unsupported(ctype, f"/element[@name='{name}']")
            self.parse_entity(name, ctype, f"/element[@name='{name}']")
        if not self.entities:
            self.issues.append(Issue(path="/", message="no top-level xs:element with a complex type found"))

    def complex_type_of(self, element: ET.Element) -> ET.Element | None:
        inline = element.find(f"{XS}complexType")
        if inline is not None:
            return inline
        type_name = _local(element.get("type"))
        return self.complex_types.get(type_name)

    def parse_entity(self, name: str, ctype: ET.Element, path: str, parent: Entity | None = None) -> None:
        entity = Entity(name=name, fields=[])
        self.entities.append(entity)
        if parent is not None:
            pk = self.ensure_pk(parent)
            entity.fields.append(
                Field(
                    name=f"{_singular(parent.name)}_{pk.name}",
                    type=pk.type,
                    nullable=False,
                    references=ForeignKey(entity=parent.name, field=pk.name),
                )
            )
        children: list[tuple[str, ET.Element, str]] = []
        self.collect_fields(entity, ctype, path, "", children, required=True)
        for child_name, child_type, child_path in children:
            self.parse_entity(child_name, child_type, child_path, parent=entity)

    def collect_fields(self, entity: Entity, ctype: ET.Element, path: str, prefix: str, children: list, required: bool) -> None:
        for attr in ctype.findall(f"{XS}attribute"):
            aname = attr.get("name")
            if aname:
                field = self.simple_field(f"{prefix}{aname}", attr, f"{path}/@{aname}")
                field.nullable = (attr.get("use") != "required" or not required) and not field.primary_key
                entity.fields.append(field)
        for compositor in ("sequence", "all"):
            for group in ctype.findall(f"{XS}{compositor}"):
                for el in group.findall(f"{XS}element"):
                    self.element_field(entity, el, path, prefix, children, required)

    def element_field(self, entity: Entity, el: ET.Element, path: str, prefix: str, children: list, required: bool) -> None:
        name = el.get("name") or _local(el.get("ref"))
        if not name:
            return
        epath = f"{path}/{name}"
        max_occurs = el.get("maxOccurs", "1")
        repeated = max_occurs == "unbounded" or (max_occurs.isdigit() and int(max_occurs) > 1)
        optional = el.get("minOccurs", "1") == "0" or el.get("nillable") == "true" or not required
        ctype = self.complex_type_of(el)
        full = f"{prefix}{name}"
        if ctype is not None:
            if repeated:
                children.append((full, ctype, epath))
            else:
                self.collect_fields(entity, ctype, epath, f"{full}_", children, required=not optional)
            return
        field = self.simple_field(full, el, epath)
        if repeated:
            field = Field(name=full, type=FieldType.ARRAY, items_type=field.type, nullable=optional)
        else:
            field.nullable = optional and not field.primary_key
        entity.fields.append(field)

    def simple_field(self, name: str, node: ET.Element, path: str) -> Field:
        field = Field(name=name)
        type_name = _local(node.get("type"))
        restriction = None
        inline = node.find(f"{XS}simpleType")
        if inline is not None:
            restriction = inline.find(f"{XS}restriction")
        elif type_name in self.simple_types:
            restriction = self.simple_types[type_name].find(f"{XS}restriction")
        if restriction is not None:
            type_name = _local(restriction.get("base"))
        if type_name not in _BUILTIN_TYPES:
            if type_name:
                self.warn(path, f"unknown type {type_name!r}; using string")
            type_name = "string"
        field.type = _BUILTIN_TYPES[type_name]
        field.minimum = _IMPLIED_MIN.get(type_name)
        field.maximum = _IMPLIED_MAX.get(type_name)
        if restriction is not None:
            self.apply_facets(field, restriction, path)
        field.semantic = guess_semantic(name, field.type)
        if type_name == "ID":
            field.primary_key = True
        return Field.model_validate(field.model_dump())  # re-run normalizers (PK → unique, PII tag)

    def apply_facets(self, field: Field, restriction: ET.Element, path: str) -> None:
        enum = [e.get("value") for e in restriction.findall(f"{XS}enumeration")]
        if enum:
            field.enum = [self.coerce(v, field.type) for v in enum]
        for facet in restriction:
            tag = facet.tag.replace(XS, "") if isinstance(facet.tag, str) else ""
            value = facet.get("value")
            if value is None or tag == "enumeration":
                continue
            try:
                if tag in ("minInclusive", "minExclusive") and field.type in (FieldType.INTEGER, FieldType.NUMBER):
                    field.minimum = float(value) + (1 if tag == "minExclusive" and field.type == FieldType.INTEGER else 0)
                elif tag in ("maxInclusive", "maxExclusive") and field.type in (FieldType.INTEGER, FieldType.NUMBER):
                    field.maximum = float(value) - (1 if tag == "maxExclusive" and field.type == FieldType.INTEGER else 0)
                elif tag == "minLength":
                    field.min_length = int(value)
                elif tag == "maxLength":
                    field.max_length = int(value)
                elif tag == "length":
                    field.min_length = field.max_length = int(value)
                elif tag == "pattern":
                    field.pattern = value
                elif tag in ("totalDigits", "fractionDigits", "whiteSpace"):
                    pass
                else:
                    self.warn(path, f"facet xs:{tag} ignored")
            except ValueError:
                self.issues.append(Issue(path=path, message=f"invalid value {value!r} for facet xs:{tag}"))

    @staticmethod
    def coerce(value: str | None, ftype: FieldType):
        if value is None:
            return None
        try:
            if ftype == FieldType.INTEGER:
                return int(value)
            if ftype == FieldType.NUMBER:
                return float(value)
        except ValueError:
            return value
        return value

    def ensure_pk(self, entity: Entity) -> Field:
        if entity.primary_key:
            return entity.primary_key
        existing = entity.field("id")
        if existing and existing.type in (FieldType.INTEGER, FieldType.STRING):
            existing.primary_key, existing.unique, existing.nullable = True, True, False
            return existing
        pk = Field(name="id" if existing is None else f"{entity.name}_id", type=FieldType.INTEGER, primary_key=True)
        entity.fields.insert(0, pk)
        return pk


def parse_xsd(source: str) -> tuple[Schema, list[Issue]]:
    """Parse an XSD document. Returns (schema, warnings); raises SchemaValidationError on errors."""
    if _DTD_RE.search(source):
        # SEC-011: no DTDs / entity declarations (XXE, billion laughs).
        raise SchemaValidationError([Issue(path="/", message="DOCTYPE and ENTITY declarations are not allowed")])
    try:
        root = SafeET.fromstring(source)  # defusedxml: no DTDs, entities or external references
    except DefusedXmlException as exc:
        raise SchemaValidationError([Issue(path="/", message=f"unsafe XML construct: {exc}")]) from exc
    except ET.ParseError as exc:
        line, col = exc.position
        raise SchemaValidationError([Issue(path=f"{line}:{col}", message=str(exc))]) from exc
    if root.tag != f"{XS}schema":
        raise SchemaValidationError([Issue(path="/", message="root element must be xs:schema")])
    parser = _XsdParser(root)
    parser.parse()
    errors = [i for i in parser.issues if i.severity == "error"]
    if errors:
        raise SchemaValidationError(errors)
    schema = Schema(name="xsd_schema", entities=parser.entities)
    return schema, [i for i in parser.issues if i.severity == "warning"] + ensure_valid(schema)
