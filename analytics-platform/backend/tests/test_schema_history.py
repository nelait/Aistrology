"""SCH-010: versioned schema history per project, and schema diffs."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.api.deps import build_state
from app.main import create_app
from app.schema.diff import diff_schemas
from app.schema.model import Entity, Field, FieldType, ForeignKey, Schema

ACME = {"X-Tenant-ID": "acme", "X-User-ID": "ana"}
GLOBEX = {"X-Tenant-ID": "globex", "X-User-ID": "gil"}


def _v1() -> Schema:
    return Schema(
        name="shop",
        entities=[
            Entity(name="customers", fields=[Field(name="id", type=FieldType.INTEGER, primary_key=True), Field(name="email")]),
            Entity(
                name="orders",
                fields=[
                    Field(name="id", type=FieldType.INTEGER, primary_key=True),
                    Field(name="customer_id", type=FieldType.INTEGER, references=ForeignKey(entity="customers", field="id")),
                    Field(name="status", enum=["new", "paid", "shipped"]),
                    Field(name="note"),
                ],
            ),
        ],
    )


def _v2() -> Schema:
    s = _v1().model_copy(deep=True)
    orders = s.entity("orders")
    orders.fields = [f for f in orders.fields if f.name != "note"]
    orders.fields.append(Field(name="total", type=FieldType.NUMBER, minimum=0))
    orders.fields[2] = orders.fields[2].model_copy(update={"enum": ["new", "paid"]})
    s.entity("customers").fields[1] = Field(name="email", nullable=False)
    s.entity("customers").fields[0] = Field(name="id", type=FieldType.STRING, primary_key=True)
    s.entities.append(Entity(name="products", fields=[Field(name="sku", primary_key=True)]))
    return s


def test_diff_schemas():
    d = diff_schemas(_v1(), _v2())
    assert not d.identical and d.breaking
    assert d.added_entities == ["products"] and d.removed_entities == []
    by = {e.name: e for e in d.entities}
    assert [f.name for f in by["orders"].added_fields] == ["total"]
    assert [f.name for f in by["orders"].removed_fields] == ["note"]
    assert [(r.field, r.from_type, r.to_type) for r in by["customers"].retyped_fields] == [("id", "integer", "string")]
    changes = {(c.field, c.attribute): (c.from_value, c.to_value) for c in by["customers"].changed_fields + by["orders"].changed_fields}
    assert changes[("email", "nullable")] == (True, False)
    assert changes[("status", "enum")] == (["new", "paid", "shipped"], ["new", "paid"])
    assert any("retyped integer → string" in line for line in d.summary)
    same = diff_schemas(_v1(), _v1())
    assert same.identical and not same.breaking and same.summary == []
    # Case-insensitive fallback matching, and serialization with from/to aliases.
    upper = _v1().model_copy(deep=True)
    upper.entities[0].name = "Customers"
    assert diff_schemas(_v1(), upper).entities == []
    dumped = d.model_dump(mode="json")
    assert {"from", "to"} <= set(dumped["entities"][0]["changed_fields"][0]) or dumped["entities"][0]["changed_fields"] == []


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(build_state(data_dir=tmp_path, dev_auth=True, cloud_provider="local", database_url=None)))


def test_save_versions_and_diff_api(client):
    body = {"name": "shop", "schema": _v1().model_dump(mode="json"), "message": "initial"}
    r = client.post("/v1/schemas", json=body, headers=ACME)
    assert r.status_code == 201, r.text
    first = r.json()
    sid = first["schema_record"]["id"]
    assert first["version"] == 1 and first["created"] and first["diff"] is None

    # Saving identical content does not create a version.
    again = client.post("/v1/schemas", json=body, headers=ACME)
    assert again.status_code == 200 and again.json()["created"] is False and again.json()["version"] == 1

    r = client.post("/v1/schemas", json={**body, "schema": _v2().model_dump(mode="json"), "message": "v2"}, headers=ACME)
    assert r.status_code == 201 and r.json()["version"] == 2
    assert r.json()["diff"]["added_entities"] == ["products"]

    listing = client.get("/v1/schemas", headers=ACME).json()
    assert [s["name"] for s in listing] == ["shop"] and listing[0]["current_version"] == 2
    versions = client.get(f"/v1/schemas/{sid}/versions", headers=ACME).json()
    assert [v["version"] for v in versions] == [1, 2] and versions[0]["message"] == "initial"
    v1 = client.get(f"/v1/schemas/{sid}/versions/1", headers=ACME).json()
    assert Schema.model_validate(v1["schema"]) == _v1()
    diff = client.get(f"/v1/schemas/{sid}/diff", headers=ACME).json()
    assert diff["added_entities"] == ["products"]
    back = client.get(f"/v1/schemas/{sid}/diff?from_version=2&to_version=1", headers=ACME).json()
    assert back["removed_entities"] == ["products"]
    assert client.get(f"/v1/schemas/{sid}/versions/9", headers=ACME).status_code == 404

    adhoc = client.post("/v1/schemas/diff", json={"a": _v1().model_dump(mode="json"), "b": _v2().model_dump(mode="json")}, headers=ACME)
    assert adhoc.status_code == 200 and adhoc.json()["breaking"] is True

    # Tenant isolation.
    assert client.get(f"/v1/schemas/{sid}", headers=GLOBEX).status_code == 404
    assert client.get("/v1/schemas", headers=GLOBEX).json() == []

    # Invalid schemas are rejected with located issues.
    bad = _v1().model_dump(mode="json")
    bad["entities"][1]["fields"][1]["references"] = {"entity": "nope", "field": "id"}
    r = client.post("/v1/schemas", json={"name": "bad", "schema": bad}, headers=ACME)
    assert r.status_code == 422 and r.json()["detail"]["issues"][0]["path"].startswith("/entities/1")


def test_schema_history_respects_projects(tmp_path):
    client = TestClient(create_app(build_state(data_dir=tmp_path, dev_auth=False, cloud_provider="local", database_url=None)))
    password = "Correct-Horse-9-Battery"

    def bearer(email: str) -> dict[str, str]:
        token = client.post("/v1/auth/login", json={"email": email, "password": password}).json()["access_token"]
        return {"Authorization": f"Bearer {token}"}

    client.post("/v1/auth/signup", json={"tenant_id": "acme", "org_name": "Acme", "email": "ada@acme.example", "password": password})
    admin = bearer("ada@acme.example")
    client.post("/v1/tenant/users", json={"email": "bob@acme.example", "role": "analyst", "password": password}, headers=admin)
    bob = bearer("bob@acme.example")
    project = client.post("/v1/projects", json={"name": "Secret"}, headers=admin).json()
    body = {"name": "hidden", "schema": _v1().model_dump(mode="json"), "project_id": project["id"]}
    r = client.post("/v1/schemas", json=body, headers=admin)
    assert r.status_code == 201, r.text
    sid = r.json()["schema_record"]["id"]
    # A non-member analyst can't see, list or write schemas in a closed project...
    assert client.get(f"/v1/schemas/{sid}", headers=bob).status_code == 404
    assert client.get(f"/v1/schemas/{sid}/diff", headers=bob).status_code == 404
    assert all(s["id"] != sid for s in client.get("/v1/schemas", headers=bob).json())
    assert client.post("/v1/schemas", json=body, headers=bob).status_code == 404
    # ...but can use the open Default project.
    assert client.post("/v1/schemas", json={**body, "project_id": None}, headers=bob).status_code == 201
    assert client.post("/v1/schemas", json={**body, "project_id": "prj_nope"}, headers=admin).status_code == 404
