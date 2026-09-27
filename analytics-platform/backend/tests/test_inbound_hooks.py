"""WHK-002 incoming webhooks: signed requests trigger ingestion or batch prediction jobs."""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from app.api.deps import build_state
from app.db.models import InboundHook
from app.jobs.core import JobService, Worker
from app.main import create_app
from app.webhooks import sign

H = {"X-Tenant-ID": "acme", "X-User-ID": "admin"}
CSV = "id,region,amount\n1,e,10\n2,w,20\n3,e,30\n"


@pytest.fixture
def state(tmp_path):
    return build_state(data_dir=tmp_path, dev_auth=True, cloud_provider="local", database_url=None, inline_worker=False)


@pytest.fixture
def client(state):
    return TestClient(create_app(state))


def post_signed(client, path, secret, body: bytes, content_type: str, ts: int | None = None):
    return client.post(path, content=body, headers={"Content-Type": content_type, "X-AP-Signature": sign(secret, body, ts)})


def test_ingest_hook_appends_and_replaces(client, state):
    ds = client.post("/v1/datasets", files={"file": ("sales.csv", CSV.encode())}, headers=H).json()["dataset"]["id"]
    r = client.post("/v1/inbound-hooks", json={"name": "crm", "action": "ingest", "dataset_id": ds}, headers=H)
    assert r.status_code == 201, r.text
    hook = r.json()
    secret, path = hook["secret"], hook["path"]
    assert path == f"/hooks/in/acme/{hook['id']}" and secret.startswith("whin_")
    assert "secret" not in client.get("/v1/inbound-hooks", headers=H).json()[0]

    body = b"id,region,amount\n4,w,40\n5,e,50\n"
    accepted = post_signed(client, path, secret, body, "text/csv")
    assert accepted.status_code == 202, accepted.text
    assert accepted.json()["type"] == "inbound.ingest" and accepted.json()["created_by"] == f"inbound:{hook['id']}"
    Worker(state, wait_seconds=0).drain()
    job = JobService(state).get("acme", accepted.json()["id"])
    assert job.status == "succeeded" and job.result["version"] == 2 and job.result["rows"] == 5
    rows = client.post(f"/v1/datasets/{ds}/query", json={"sql": "SELECT count(*) AS n, sum(amount) AS s FROM data"}, headers=H).json()
    assert rows["rows"][0] == [5, 150]

    # replay of the exact same signed request is rejected
    replay = client.post(
        path, content=body, headers={"Content-Type": "text/csv", "X-AP-Signature": accepted.request.headers["X-AP-Signature"]}
    )
    assert replay.status_code == 401

    # JSON, replace mode
    r2 = client.post("/v1/inbound-hooks", json={"name": "full", "action": "ingest", "dataset_id": ds, "mode": "replace"}, headers=H).json()
    rows_json = json.dumps({"rows": [{"id": 9, "region": "n", "amount": 1}]}).encode()
    assert post_signed(client, r2["path"], r2["secret"], rows_json, "application/json").status_code == 202
    Worker(state, wait_seconds=0).drain()
    rows = client.post(f"/v1/datasets/{ds}/query", json={"sql": "SELECT count(*) FROM data"}, headers=H).json()
    assert rows["rows"][0] == [1]
    assert state.audit.entries("acme", "inbound_hook.triggered") and state.audit.entries("acme", "inbound_hook.create")


def test_signature_and_payload_checks(client, state):
    ds = client.post("/v1/datasets", files={"file": ("sales.csv", CSV.encode())}, headers=H).json()["dataset"]["id"]
    hook = client.post("/v1/inbound-hooks", json={"name": "crm", "action": "ingest", "dataset_id": ds}, headers=H).json()
    path, secret = hook["path"], hook["secret"]
    body = b"id,region,amount\n4,w,40\n"
    assert client.post(path, content=body, headers={"Content-Type": "text/csv"}).status_code == 401  # unsigned
    assert post_signed(client, path, "whin_wrong", body, "text/csv").status_code == 401
    assert post_signed(client, path, secret, body, "text/csv", ts=int(time.time()) - 3600).status_code == 401  # stale
    assert post_signed(client, path, secret, b"", "text/csv").status_code == 422
    assert post_signed(client, path, secret, b'{"rows": "nope"}', "application/json").status_code == 422
    assert post_signed(client, path, secret, b"<xml/>", "application/xml").status_code == 422
    assert post_signed(client, f"/hooks/in/globex/{hook['id']}", secret, body, "text/csv").status_code == 404  # wrong tenant
    assert post_signed(client, "/hooks/in/acme/ih_unknown", secret, body, "text/csv").status_code == 404
    assert state.audit.entries("acme", "inbound_hook.rejected")
    # deleting the hook disables it and removes its secret
    assert client.delete(f"/v1/inbound-hooks/{hook['id']}", headers=H).status_code == 204
    assert post_signed(client, path, secret, body, "text/csv").status_code == 404
    assert state.secrets.get("acme", f"inbound-hook-{hook['id']}") is None


def test_hook_configuration_is_validated(client, state):
    assert client.post("/v1/inbound-hooks", json={"name": "x", "action": "predict", "endpoint": "missing"}, headers=H).status_code == 422
    assert (
        client.post("/v1/inbound-hooks", json={"name": "x", "action": "ingest", "dataset_id": "ds_missing"}, headers=H).status_code == 404
    )
    assert client.post("/v1/inbound-hooks", json={"name": "x", "action": "delete-everything"}, headers=H).status_code == 422
    other = {"X-Tenant-ID": "globex", "X-User-ID": "admin"}
    ds = client.post("/v1/datasets", files={"file": ("sales.csv", CSV.encode())}, headers=H).json()["dataset"]["id"]
    assert client.post("/v1/inbound-hooks", json={"name": "x", "action": "ingest", "dataset_id": ds}, headers=other).status_code == 404


def test_predict_hook_queues_batch_prediction(client, state):
    """The predict action reuses the serving batch job with the posted rows as its input file."""
    client.get("/v1/datasets", headers=H)  # creates the dev tenant
    with state.db.session("acme") as s:
        hook = InboundHook(
            tenant_id="acme", name="score", action="predict", config={"endpoint": "churn"}, secret_name="inbound-hook-x", created_by="t"
        )
        s.add(hook)
        s.flush()
        hook_id = hook.id
    state.secrets.put("acme", "inbound-hook-x", "whin_secret")
    body = json.dumps([{"age": 40, "plan": "pro"}, {"age": 50, "plan": "basic"}]).encode()
    r = post_signed(client, f"/hooks/in/acme/{hook_id}", "whin_secret", body, "application/json")
    assert r.status_code == 202, r.text
    job = r.json()
    assert job["type"] == "serving.batch_predict" and job["params"]["endpoint"] == "churn"
    stored = state.objects.get_bytes("acme", job["params"]["input_key"]).decode()
    assert stored.splitlines()[0] == "age,plan" and len(stored.splitlines()) == 3
