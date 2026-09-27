from __future__ import annotations

import hashlib
import io
import json
import zipfile

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.api.deps import AppState, build_state
from app.llm.base import LLMRequest
from app.llm.providers.mock import MockProvider
from app.llm.router import LLMRouter
from app.main import create_app

from .conftest import CUSTOMER_ORDERS_SCHEMA

ACME = {"X-Tenant-ID": "acme", "X-User-ID": "ana@acme.example"}
GLOBEX = {"X-Tenant-ID": "globex", "X-User-ID": "gil"}

SALES_CSV = "Order ID,Region,Order Date,Amount,Customer Email\n" + "\n".join(
    f"{i},{['east', 'west', 'north'][i % 3]},2024-{(i % 12) + 1:02d}-15,{10 + i * 1.5:.2f},user{i}@example.com" for i in range(1, 121)
)


@pytest.fixture
def state(tmp_path) -> AppState:
    return build_state(data_dir=tmp_path, dev_auth=True, cloud_provider="local", database_url=None, max_dataset_bytes=200_000)


@pytest.fixture
def client(state) -> TestClient:
    return TestClient(create_app(state=state))


def upload(client: TestClient, content: str = SALES_CSV, name: str = "sales.csv", headers=ACME):
    return client.post("/v1/datasets", files={"file": (name, content.encode(), "text/csv")}, headers=headers)


def test_auth_stub_is_off_by_default(tmp_path):
    client = TestClient(create_app(build_state(data_dir=tmp_path, dev_auth=False, cloud_provider="local", database_url=None)))
    assert client.get("/v1/datasets", headers=ACME).status_code == 401
    assert client.get("/healthz").json() == {"status": "ok", "cloud": "local"}


def test_invalid_tenant_rejected(client):
    assert client.get("/v1/datasets", headers={"X-Tenant-ID": "../etc"}).status_code == 400


def test_parse_json_schema_and_generate(client):
    r = client.post("/v1/schemas/parse", json={"format": "json_schema", "content": json.dumps(CUSTOMER_ORDERS_SCHEMA)}, headers=ACME)
    assert r.status_code == 200, r.text
    schema = r.json()["schema"]
    assert [e["name"] for e in schema["entities"]] == ["customers", "orders"]
    assert r.json()["json_schema"]["$schema"].endswith("2020-12/schema")

    r = client.post("/v1/generate/preview", json={"schema": schema, "options": {"count": 80, "seed": 1}}, headers=ACME)
    assert r.status_code == 200
    body = r.json()
    assert len(body["entities"]["customers"]) == 50 and body["planned_rows"]["customers"] == 80

    r = client.post("/v1/generate", json={"schema": schema, "options": {"count": 30, "seed": 1}, "format": "csv"}, headers=ACME)
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        customers = pd.read_csv(zf.open("customers.csv"))
    assert len(customers) == 30
    again = client.post("/v1/generate", json={"schema": schema, "options": {"count": 30, "seed": 1}, "format": "csv"}, headers=ACME)
    with zipfile.ZipFile(io.BytesIO(again.content)) as zf:
        assert zf.read("customers.csv") == zipfile.ZipFile(io.BytesIO(r.content)).read("customers.csv")


def test_parse_errors_are_422_with_issues(client):
    r = client.post("/v1/schemas/parse", json={"format": "xsd", "content": "<not-xsd/>"}, headers=ACME)
    assert r.status_code == 422 and r.json()["detail"]["issues"][0]["message"]


def test_generation_size_and_sync_limits(client):
    schema = client.post(
        "/v1/schemas/parse", json={"format": "json_schema", "content": json.dumps(CUSTOMER_ORDERS_SCHEMA)}, headers=ACME
    ).json()["schema"]
    r = client.post("/v1/generate", json={"schema": schema, "options": {"count": 90_000}}, headers=ACME)
    assert r.status_code == 422 and "synchronous generation" in r.json()["detail"]


def test_generate_and_save_as_dataset(client):
    schema = client.post(
        "/v1/schemas/parse", json={"format": "json_schema", "content": json.dumps(CUSTOMER_ORDERS_SCHEMA)}, headers=ACME
    ).json()["schema"]
    r = client.post("/v1/generate", json={"schema": schema, "options": {"count": 20}, "save_as": "demo"}, headers=ACME)
    assert r.status_code == 200, r.text
    assert {t["name"] for t in r.json()["tables"]} == {"customers", "orders"}
    assert client.get("/v1/datasets", headers=ACME).json()[0]["source"] == "generated"


def test_upload_infer_profile_query(client, state):
    r = upload(client)
    assert r.status_code == 201, r.text
    body = r.json()
    dataset_id = body["dataset"]["id"]
    table = body["dataset"]["tables"][0]
    assert table["sha256"] == hashlib.sha256(SALES_CSV.encode()).hexdigest()
    fields = {f["name"]: f for f in body["inference"]["schema"]["entities"][0]["fields"]}
    assert fields["order_id"]["primary_key"]
    assert fields["order_date"]["type"] == "date"
    assert fields["customer_email"]["pii"]
    assert fields["region"]["enum"] == ["east", "north", "west"]

    profile = client.get(f"/v1/datasets/{dataset_id}/profile", headers=ACME).json()
    assert profile["row_count"] == 120 and profile["quality"]["score"] > 90

    # canonical (renamed) column names work in SQL
    r = client.post(
        f"/v1/datasets/{dataset_id}/query",
        json={"sql": "SELECT region, round(sum(amount), 2) AS total FROM data GROUP BY region ORDER BY region"},
        headers=ACME,
    )
    assert r.status_code == 200, r.text
    assert [row[0] for row in r.json()["rows"]] == ["east", "north", "west"]

    r = client.post(f"/v1/datasets/{dataset_id}/query", json={"sql": "DROP TABLE data"}, headers=ACME)
    assert r.status_code == 400
    r = client.post(f"/v1/datasets/{dataset_id}/query", json={"sql": "SELECT * FROM read_csv('/etc/passwd')"}, headers=ACME)
    assert r.status_code == 400

    actions = [e["action"] for e in client.get("/v1/tenant/audit", headers=ACME).json()]
    assert actions[:1] == ["dataset.upload"] and "dataset.query" in actions
    assert state.audit.verify()


def test_tenant_isolation(client):
    dataset_id = upload(client).json()["dataset"]["id"]
    assert client.get(f"/v1/datasets/{dataset_id}", headers=GLOBEX).status_code == 404
    assert client.post(f"/v1/datasets/{dataset_id}/query", json={"sql": "SELECT 1"}, headers=GLOBEX).status_code == 404
    assert client.get("/v1/datasets", headers=GLOBEX).json() == []
    assert client.get("/v1/tenant/audit", headers=GLOBEX).json() == []
    assert client.get("/v1/datasets/..%2F..%2Fetc", headers=ACME).status_code == 404


def test_upload_limits_and_checksum(client, state):
    too_big = "a,b\n" + "1,2\n" * 60_000  # > 200 KB test limit
    r = upload(client, too_big)
    assert r.status_code == 413 and "limit" in r.json()["detail"]
    r = client.put("/v1/datasets/upload?filename=big.csv", content=too_big.encode(), headers=ACME)
    assert r.status_code == 413
    r = client.put(
        "/v1/datasets/upload?filename=s.csv",
        content=SALES_CSV.encode(),
        headers={**ACME, "X-Content-SHA256": "0" * 64},
    )
    assert r.status_code == 422 and "checksum" in r.json()["detail"]
    r = client.put(
        "/v1/datasets/upload?filename=s.csv",
        content=SALES_CSV.encode(),
        headers={**ACME, "X-Content-SHA256": hashlib.sha256(SALES_CSV.encode()).hexdigest()},
    )
    assert r.status_code == 201
    assert upload(client, "", "empty.csv").status_code == 422
    assert list(state.store.cache_dir.rglob(".upload-*")) == []  # temp files cleaned up


def test_confirm_schema_renames_columns(client):
    body = upload(client).json()
    dataset_id = body["dataset"]["id"]
    schema = body["inference"]["schema"]
    amount = next(f for f in schema["entities"][0]["fields"] if f["name"] == "amount")
    amount["name"], amount["source_name"] = "revenue", "Amount"
    assert client.put(f"/v1/datasets/{dataset_id}/schema", json=schema, headers=ACME).status_code == 200
    r = client.post(f"/v1/datasets/{dataset_id}/query", json={"sql": "SELECT sum(revenue) FROM data"}, headers=ACME)
    assert r.status_code == 200, r.text
    profile = client.get(f"/v1/datasets/{dataset_id}/profile", headers=ACME).json()
    assert "revenue" in [c["name"] for c in profile["columns"]]


def test_llm_suggestions_with_minimization(client, state):
    seen: list[LLMRequest] = []

    def responder(req: LLMRequest) -> str:
        seen.append(req)
        return json.dumps(
            {
                "suggestions": [
                    {
                        "title": "Revenue by region",
                        "category": "descriptive",
                        "chart_type": "bar",
                        "x": "region",
                        "y": "amount",
                        "aggregation": "sum",
                        "group_by": ["region"],
                        "rationale": "Shows which region drives revenue.",
                        "sql": "SELECT region, sum(amount) AS revenue FROM data GROUP BY region",
                    },
                    {
                        "title": "Broken",
                        "category": "diagnostic",
                        "chart_type": "line",
                        "rationale": "Uses a column that does not exist.",
                        "sql": "SELECT nope FROM data",
                    },
                    {
                        "title": "Sneaky",
                        "category": "descriptive",
                        "chart_type": "table",
                        "rationale": "Tries to read a file.",
                        "sql": "SELECT * FROM read_csv('/etc/passwd')",
                    },
                ]
            }
        )

    state.router_overrides["acme"] = LLMRouter("acme", [MockProvider(responder)], ledger=state.ledger, audit=state.audit)
    dataset_id = upload(client).json()["dataset"]["id"]
    r = client.post(f"/v1/datasets/{dataset_id}/suggestions", json={"question": "where is revenue coming from?"}, headers=ACME)
    assert r.status_code == 200, r.text
    suggestions = r.json()
    assert [s["valid"] for s in suggestions] == [True, False, False]
    assert suggestions[0]["preview"] and suggestions[1]["validation_error"]

    prompt = seen[0].messages[0].content
    # LLM-NFR-004 (default L2): PII columns are masked in sample rows and excluded from top values.
    assert "user1@example.com" not in prompt and "u***@example.com" in prompt
    assert "where is revenue coming from?" in prompt
    usage = client.get("/v1/tenant/llm-usage", headers=ACME).json()
    assert usage["total_tokens"] > 0


def test_llm_config_and_secrets_are_write_only(client):
    assert client.put("/v1/tenant/secrets/anthropic", json={"value": "sk-ant-secret"}, headers=ACME).status_code == 204
    assert client.get("/v1/tenant/secrets", headers=ACME).json() == {"names": ["anthropic"]}
    config = {"chain": [{"kind": "anthropic", "secret_name": "anthropic"}, {"kind": "mock"}], "data_minimization": "L1"}
    r = client.put("/v1/tenant/llm-config", json=config, headers=ACME)
    assert r.status_code == 200 and r.json()["chain"][0]["kind"] == "anthropic"
    everything = json.dumps(client.get("/v1/tenant/audit", headers=ACME).json()) + json.dumps(r.json())
    assert "sk-ant-secret" not in everything
    assert client.get("/v1/tenant/secrets", headers=GLOBEX).json() == {"names": []}
