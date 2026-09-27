from __future__ import annotations

import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.api.deps import build_state
from app.jobs.core import HANDLERS, JobContext, JobService, Worker, job_handler
from app.main import create_app

from .conftest import CUSTOMER_ORDERS_SCHEMA

H = {"X-Tenant-ID": "acme", "X-User-ID": "eng"}
CSV = "id,name,amount,region\n" + "\n".join(
    f"{i},{'  name' + str(i) + ' ' if i % 5 else ''},{'' if i % 7 == 0 else i * 1.5},{['east', 'west', 'TEST'][i % 3]}"
    for i in range(1, 201)
)


@pytest.fixture
def state(tmp_path):
    return build_state(data_dir=tmp_path, dev_auth=True, cloud_provider="local", database_url=None, inline_worker=False)


@pytest.fixture
def client(state):
    return TestClient(create_app(state))


def drain(state):
    return Worker(state, wait_seconds=0).drain()


def upload(client):
    r = client.post("/v1/datasets", files={"file": ("sales.csv", CSV.encode())}, headers=H)
    assert r.status_code == 201, r.text
    return r.json()["dataset"]["id"]


def test_pipeline_edit_preview_apply_versions(client, state):
    ds = upload(client)
    p = client.post("/v1/pipelines", json={"dataset_id": ds, "name": "clean sales"}, headers=H).json()
    pid = p["id"]
    for step in [
        {"op": "normalize_strings", "columns": ["name", "region"], "case": "lower"},
        {"op": "fill_missing", "columns": ["amount"], "strategy": "median"},
        {"op": "filter", "condition": "region <> 'test'"},
    ]:
        r = client.post(f"/v1/pipelines/{pid}/steps", json={"step": step}, headers=H)
        assert r.status_code == 200, r.text
    # a step referencing a missing column is rejected up front
    bad = client.post(f"/v1/pipelines/{pid}/steps", json={"step": {"op": "drop_columns", "columns": ["nope"]}}, headers=H)
    assert bad.status_code == 422 and "unknown column" in bad.json()["detail"]
    # undo / redo
    assert len(client.post(f"/v1/pipelines/{pid}/undo", headers=H).json()["steps"]) == 2
    assert client.post(f"/v1/pipelines/{pid}/redo", headers=H).json()["can_redo"] is False
    # preview with a candidate step (not saved)
    prev = client.post(
        f"/v1/pipelines/{pid}/preview", json={"step": {"op": "derive", "name": "double", "expression": "amount * 2"}, "rows": 5}, headers=H
    )
    assert prev.status_code == 200, prev.text
    body = prev.json()
    assert body["sample_rows"] == 200 and len(body["rows"]) == 5 and "double" in body["columns"]
    assert [s["op"] for s in body["step_stats"]] == ["normalize_strings", "fill_missing", "filter", "derive"]
    assert any(d["column"] == "double" for d in body["column_deltas"])
    assert len(client.get(f"/v1/pipelines/{pid}", headers=H).json()["steps"]) == 3

    job = client.post(f"/v1/pipelines/{pid}/apply", headers=H)
    assert job.status_code == 202 and job.json()["status"] == "queued"
    assert drain(state) == 1
    done = client.get(f"/v1/jobs/{job.json()['id']}", headers=H).json()
    assert done["status"] == "succeeded", done["error"]
    assert done["result"]["version"] == 2 and done["result"]["parent_version"] == 1

    versions = client.get(f"/v1/datasets/{ds}/versions", headers=H).json()
    assert [v["version"] for v in versions] == [1, 2]
    assert versions[1]["parent_version"] == 1 and versions[1]["pipeline_id"] == pid
    # the new version is what queries see by default; v1 is still readable (non-destructive)
    regions = client.post(f"/v1/datasets/{ds}/query", json={"sql": "SELECT DISTINCT region FROM data ORDER BY 1"}, headers=H).json()["rows"]
    assert regions == [["east"], ["west"]]
    old = client.post(f"/v1/datasets/{ds}/query?version=1", json={"sql": "SELECT count(*) FROM data"}, headers=H).json()["rows"]
    assert old == [[200]]
    nulls = client.post(f"/v1/datasets/{ds}/query", json={"sql": "SELECT count(*) FROM data WHERE amount IS NULL"}, headers=H).json()[
        "rows"
    ]
    assert nulls == [[0]]
    # audit trail of every edit (PIP-006) and a notification for the job (NTF-001)
    actions = [e["action"] for e in client.get("/v1/tenant/audit", headers=H).json()]
    for a in ["pipeline.create", "pipeline.step.add", "pipeline.step.undo", "pipeline.step.redo", "pipeline.apply", "job.succeeded"]:
        assert a in actions
    notes = client.get("/v1/notifications", headers={**H, "X-User-ID": "eng"}).json()
    assert notes[0]["kind"] == "job.succeeded"
    client.post(f"/v1/notifications/{notes[0]['id']}/read", headers=H)
    assert client.get("/v1/notifications?unread_only=true", headers=H).json() == []


def test_templates(client, state):
    ds = upload(client)
    pid = client.post(
        "/v1/pipelines",
        json={"dataset_id": ds, "name": "p", "steps": [{"op": "deduplicate"}, {"op": "drop_columns", "columns": ["region"]}]},
        headers=H,
    ).json()["id"]
    template = client.post(f"/v1/pipelines/{pid}/template", json={"name": "standard"}, headers=H).json()
    assert template["is_template"] and template["dataset_id"] is None
    assert [t["name"] for t in client.get("/v1/pipelines/templates", headers=H).json()] == ["standard"]
    other = upload(client)
    inst = client.post("/v1/pipelines/from-template", json={"template_id": template["id"], "dataset_id": other}, headers=H)
    assert inst.status_code == 201 and inst.json()["dataset_id"] == other
    assert client.post(f"/v1/pipelines/{template['id']}/apply", headers=H).status_code == 422
    # incompatible dataset
    gen = client.post(
        "/v1/generate",
        json={
            "schema": client.post(
                "/v1/schemas/parse", json={"format": "json_schema", "content": json.dumps(CUSTOMER_ORDERS_SCHEMA)}, headers=H
            ).json()["schema"],
            "options": {"count": 5},
            "save_as": "g",
        },
        headers=H,
    ).json()
    assert (
        client.post("/v1/pipelines/from-template", json={"template_id": template["id"], "dataset_id": gen["id"]}, headers=H).status_code
        == 422
    )


def test_async_generation_job(client, state):
    state.settings = state.settings.__class__(**{**state.settings.__dict__, "sync_generation_row_limit": 50})
    schema = client.post(
        "/v1/schemas/parse", json={"format": "json_schema", "content": json.dumps(CUSTOMER_ORDERS_SCHEMA)}, headers=H
    ).json()["schema"]
    r = client.post("/v1/generate", json={"schema": schema, "options": {"count": 100}, "save_as": "big"}, headers=H)
    assert r.status_code == 202
    drain(state)
    job = client.get(f"/v1/jobs/{r.json()['id']}", headers=H).json()
    assert job["status"] == "succeeded" and job["result"]["rows"]["customers"] == 100
    assert client.get(f"/v1/datasets/{job['result']['dataset_id']}", headers=H).json()["name"] == "big"


def test_retry_then_fail_and_cancel(state):
    calls = {"n": 0}

    @job_handler("test.flaky")
    def flaky(ctx: JobContext) -> dict:
        calls["n"] += 1
        raise RuntimeError("boom")

    @job_handler("test.slow")
    def slow(ctx: JobContext) -> dict:
        ctx.progress(0.5, "halfway")
        return {"ok": True}

    try:
        state.ensure_tenant("acme")
        svc = JobService(state)
        job = svc.submit("acme", "test.flaky", {}, "u", max_attempts=2)
        drain(state)
        out = svc.get("acme", job.id)
        assert out.status == "failed" and calls["n"] == 2 and "boom" in out.error
        queued = svc.submit("acme", "test.slow", {}, "u")
        assert svc.cancel("acme", queued.id, "u").status == "cancelled"
        drain(state)
        assert svc.get("acme", queued.id).status == "cancelled"
        with pytest.raises(ValueError):
            svc.submit("acme", "no.such.type", {}, "u")
        with pytest.raises(LookupError):
            svc.get("globex", job.id)
        assert state.metering.totals("acme")["compute.seconds"]["test.flaky"] >= 0
    finally:
        HANDLERS.pop("test.flaky", None)
        HANDLERS.pop("test.slow", None)


def test_tenant_export(client, state):
    upload(client)
    r = client.post("/v1/tenant/exports", headers=H)
    assert r.status_code == 202
    assert client.get(f"/v1/tenant/exports/{r.json()['id']}", headers=H).status_code == 409
    drain(state)
    data = client.get(f"/v1/tenant/exports/{r.json()['id']}", headers=H)
    assert data.status_code == 200
    with zipfile.ZipFile(io.BytesIO(data.content)) as zf:
        names = zf.namelist()
        assert "audit_log.jsonl" in names and "datasets.json" in names and any(n.endswith("sales.csv") for n in names)
