from __future__ import annotations

import json

import pytest

from app.schema.json_schema import parse_json_schema
from app.schema.model import FieldType, Schema, SchemaValidationError, Semantic, to_json_schema, validate_schema
from app.schema.xsd import parse_xsd

from .conftest import CUSTOMER_ORDERS_SCHEMA


def test_json_schema_collections_nesting_and_child_entities(shop_schema: Schema):
    assert [e.name for e in shop_schema.entities] == ["customers", "orders"]
    customers = shop_schema.entity("customers")
    assert customers.primary_key.name == "id"
    email = customers.field("email")
    assert email.semantic == Semantic.EMAIL and email.pii and email.unique and not email.nullable
    assert customers.field("date_of_birth").type == FieldType.DATE
    assert customers.field("tier").enum == ["bronze", "silver", "gold"]
    # SCH-007: nested object flattened
    assert customers.field("address_city").semantic == Semantic.CITY
    assert customers.field("address_postal_code").pattern == "^[0-9]{5}$"
    # SCH-008: array of objects → child entity with FK to the explicit id (not a generated one)
    orders = shop_schema.entity("orders")
    fk = orders.field("customer_id")
    assert fk.references.entity == "customers" and fk.references.field == "id" and not fk.nullable
    assert sum(f.name == "id" for f in customers.fields) == 1
    assert orders.field("quantity").minimum == 1 and orders.field("quantity").maximum == 20


def test_json_schema_ref_resolution_and_generated_pk():
    doc = {
        "title": "Invoice",
        "type": "object",
        "$defs": {"line": {"type": "object", "properties": {"sku": {"type": "string"}, "qty": {"type": "integer"}}}},
        "properties": {"number": {"type": "string"}, "lines": {"type": "array", "items": {"$ref": "#/$defs/line"}}},
    }
    schema, _ = parse_json_schema(doc)
    invoice = schema.entity("Invoice")
    assert invoice.primary_key.name == "id" and invoice.fields[0].name == "id"
    assert schema.entity("lines").field("Invoice_id").references.entity == "Invoice"


def test_json_schema_errors_are_located():
    with pytest.raises(SchemaValidationError) as exc:
        parse_json_schema('{"type": "object",\n "properties": {')
    assert exc.value.issues[0].path.startswith("2:")
    with pytest.raises(SchemaValidationError) as exc:
        parse_json_schema({"type": "object", "properties": {"a": {"$ref": "#/$defs/missing"}}})
    assert "unresolvable" in exc.value.issues[0].message
    with pytest.raises(SchemaValidationError):
        parse_json_schema({"type": "object", "properties": {"a": {"$ref": "http://evil.example/x.json"}}})


def test_json_schema_round_trip(shop_schema: Schema):
    again, _ = parse_json_schema(json.dumps(to_json_schema(shop_schema)))
    assert again.model_dump(exclude={"name"}) == shop_schema.model_dump(exclude={"name"})


def test_validation_catches_bad_fk_and_bounds(shop_schema: Schema):
    broken = shop_schema.model_copy(deep=True)
    broken.entity("orders").field("customer_id").references.field = "nope"
    broken.entity("orders").field("quantity").minimum = 50
    messages = [i.message for i in validate_schema(broken)]
    assert any("unknown field" in m for m in messages)
    assert any("minimum is greater" in m for m in messages)


def test_input_is_not_mutated():
    before = json.dumps(CUSTOMER_ORDERS_SCHEMA, sort_keys=True)
    parse_json_schema(CUSTOMER_ORDERS_SCHEMA)
    assert json.dumps(CUSTOMER_ORDERS_SCHEMA, sort_keys=True) == before


XSD = """<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:simpleType name="Status">
    <xs:restriction base="xs:string">
      <xs:enumeration value="open"/><xs:enumeration value="closed"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:element name="customers">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="id" type="xs:int"/>
        <xs:element name="email" type="xs:string"/>
        <xs:element name="nickname" type="xs:string" minOccurs="0"/>
        <xs:element name="age">
          <xs:simpleType><xs:restriction base="xs:integer"><xs:minInclusive value="18"/><xs:maxInclusive value="99"/></xs:restriction></xs:simpleType>
        </xs:element>
        <xs:element name="tag" type="xs:string" maxOccurs="unbounded"/>
        <xs:element name="orders" maxOccurs="unbounded">
          <xs:complexType>
            <xs:sequence>
              <xs:element name="total" type="xs:decimal"/>
              <xs:element name="status" type="Status"/>
              <xs:element name="placed" type="xs:dateTime"/>
            </xs:sequence>
            <xs:attribute name="order_no" type="xs:string" use="required"/>
          </xs:complexType>
        </xs:element>
        <xs:choice><xs:element name="a" type="xs:string"/></xs:choice>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>"""


def test_xsd_subset():
    schema, warnings = parse_xsd(XSD)
    customers, orders = schema.entity("customers"), schema.entity("orders")
    assert customers.primary_key.name == "id"
    assert customers.field("email").semantic == Semantic.EMAIL
    assert customers.field("nickname").nullable and not customers.field("email").nullable
    assert (customers.field("age").minimum, customers.field("age").maximum) == (18, 99)
    assert customers.field("tag").type == FieldType.ARRAY
    assert orders.field("status").enum == ["open", "closed"]
    assert orders.field("placed").type == FieldType.DATETIME
    assert not orders.field("order_no").nullable
    assert orders.field("customer_id").references.entity == "customers"
    assert any("xs:choice" in w.message for w in warnings)


def test_xsd_rejects_dtd_and_reports_position():
    with pytest.raises(SchemaValidationError, match="DOCTYPE"):
        parse_xsd('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"/>')
    with pytest.raises(SchemaValidationError) as exc:
        parse_xsd("<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'>\n<xs:element>")
    assert ":" in exc.value.issues[0].path
