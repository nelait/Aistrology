"""ING-008 streaming ingestion: micro-batches into an append-only dataset, compaction and the 1 GB cap."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.api.deps import build_state
from app.jobs.core import JobService, Worker
from app.main import create_app
from app.streams import compact, request_compaction
from app.webhooks import sign

H = {"X-Tenant-ID": "acme", "X-User-ID": "admin"}


@pytest.fixture
def state(tmp_path):
    return build_state(data_dir=tmp_path, dev_auth=True, cloud_provider="local", database_url=None, inline_worker=False)


@pytest.fixture
def client(state):
    return TestClient(create_app(state))


def drain(state) -> int:
    return Worker(state, wait_seconds=0).drain()


def api_key(client, *scopes: str) -> dict:
    r = client.post("/v1/tenant/api-keys", json={"name": "ingest", "role": "data_engineer", "scopes": list(scopes)}, headers=H)
    assert r.status_code == 201, r.text
    return {"X-API-Key": r.json()["key"]}


def rows(client, ds) -> list:
    return client.post(f"/v1/datasets/{ds}/query", json={"sql": "SELECT * FROM data ORDER BY id"}, headers=H).json()["rows"]


def test_stream_push_compact_and_query(client, state):
    r = client.post("/v1/streams", json={"name": "events", "columns": ["id", "kind"], "compact_rows": 5}, headers=H)
    assert r.status_code == 201, r.text
    ds = r.json()["id"]
    assert r.json()["source"] == "stream"
    writer, reader = api_key(client, "data.write"), api_key(client, "data.read")
    url = f"/v1/streams/{ds}/records"

    batch = [{"id": 1, "kind": "click", "value": 1.5}, {"id": 2, "kind": "view", "value": None}, {"id": 3, "kind": "click"}]
    r = client.post(url, json={"records": batch}, headers=writer)
    assert r.status_code == 202, r.text
    assert r.json()["buffered_rows"] == 3 and "compaction_job_id" not in r.json()
    assert client.post(url, json=batch, headers=reader).status_code == 403  # needs data.write
    assert client.post(url, json=[{"id": 9, "nested": {"a": 1}}], headers=writer).status_code == 422
    assert client.post(url, json=[], headers=writer).status_code == 422
    assert client.post(url, content=b"not json", headers={**writer, "Content-Type": "application/json"}).status_code == 422

    # crossing compact_rows queues a compaction; values of mixed kinds become strings
    r = client.post(url, json=[{"id": 4, "kind": 7}, {"id": 5, "kind": "view", "value": 2}, {"id": 6, "kind": "buy"}], headers=writer)
    job_id = r.json()["compaction_job_id"]
    assert job_id and client.post(f"/v1/streams/{ds}/compact", headers=H).json()["id"] == job_id  # one in flight
    drain(state)
    assert JobService(state).get("acme", job_id).result["rows_added"] == 6
    status = client.get(f"/v1/streams/{ds}", headers=H).json()
    assert status["version"] == 2 and status["buffered_rows"] == 0 and status["stored_rows"] == 6 and status["buffered_batches"] == 0
    got = rows(client, ds)
    assert [r[0] for r in got] == [1, 2, 3, 4, 5, 6] and got[3][1] == "7"

    # appends keep going into new versions
    client.post(url, json=[{"id": 7, "kind": "click"}], headers=writer)
    job = client.post(f"/v1/streams/{ds}/compact", headers=H).json()
    drain(state)
    assert JobService(state).get("acme", job["id"]).result["version"] == 3 and len(rows(client, ds)) == 7

    # regular datasets aren't streams
    plain = client.post("/v1/datasets", files={"file": ("d.csv", b"id\n1\n")}, headers=H).json()["dataset"]["id"]
    assert client.post(f"/v1/streams/{plain}/records", json=[{"id": 1}], headers=writer).status_code == 404
    # other tenants can't push
    other = {"X-Tenant-ID": "globex", "X-User-ID": "admin"}
    assert client.post(url, json=[{"id": 1}], headers=other).status_code == 404


def test_stream_size_cap(client, state):
    ds = client.post("/v1/streams", json={"name": "capped"}, headers=H).json()["id"]
    state.store.max_dataset_bytes = 2000
    url = f"/v1/streams/{ds}/records"
    assert client.post(url, json=[{"id": i, "text": "x" * 20} for i in range(20)], headers=H).status_code == 202
    r = client.post(url, json=[{"id": i, "text": "x" * 20} for i in range(60)], headers=H)
    assert r.status_code == 413 and "limit" in r.json()["detail"]["message"]
    assert state.audit.entries("acme", "stream.rejected")


def test_compaction_lock(client, state):
    ds = client.post("/v1/streams", json={"name": "locked"}, headers=H).json()["id"]
    client.post(f"/v1/streams/{ds}/records", json=[{"id": 1}], headers=H)
    job_id = request_compaction(state, "acme", ds, "admin")
    assert compact(state, "acme", ds, "job_other", "admin") == {"dataset_id": ds, "skipped": "another compaction is running"}
    assert compact(state, "acme", ds, job_id, "admin")["rows_added"] == 1


def test_inbound_hook_and_schedule_feed_the_stream(client, state):
    ds = client.post("/v1/streams", json={"name": "crm"}, headers=H).json()["id"]
    hook = client.post("/v1/inbound-hooks", json={"name": "crm", "action": "ingest", "dataset_id": ds}, headers=H).json()
    body = json.dumps({"rows": [{"id": 1, "stage": "lead"}, {"id": 2, "stage": "won"}]}).encode()
    r = client.post(hook["path"], content=body, headers={"Content-Type": "application/json", "X-AP-Signature": sign(hook["secret"], body)})
    assert r.status_code == 202, r.text
    drain(state)
    result = JobService(state).get("acme", r.json()["id"]).result
    assert result["buffered"] is True and result["accepted"] == 2
    assert client.get(f"/v1/streams/{ds}", headers=H).json()["buffered_rows"] == 2

    # a scheduled stream.compact folds the buffer into a version
    sched = {"name": "compact", "cron": "*/10 * * * *", "job_type": "stream.compact", "params": {"dataset_id": ds}}
    sid = client.post("/v1/schedules", json=sched, headers=H).json()["id"]
    run = client.post(f"/v1/schedules/{sid}/run", headers=H).json()
    drain(state)
    assert JobService(state).get("acme", run["job_id"]).result["rows_added"] == 2
    assert [r[1] for r in rows(client, ds)] == ["lead", "won"]
    plain = client.post("/v1/datasets", files={"file": ("d.csv", b"id\n1\n")}, headers=H).json()["dataset"]["id"]
    assert client.post("/v1/schedules", json={**sched, "params": {"dataset_id": plain}}, headers=H).status_code == 422
