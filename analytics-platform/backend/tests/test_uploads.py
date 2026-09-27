"""Resumable uploads (ING-002, ING-NFR-001)."""

from __future__ import annotations

import hashlib

import pytest
from fastapi.testclient import TestClient

from app.api.deps import build_state
from app.main import create_app

H = {"X-Tenant-ID": "acme", "X-User-ID": "admin"}
CSV = b"id,region,amount\n" + b"".join(f"{i},{'north' if i % 2 else 'south'},{i * 1.5}\n".encode() for i in range(1, 2001))


@pytest.fixture
def state(tmp_path):
    return build_state(data_dir=tmp_path, dev_auth=True, cloud_provider="local", database_url=None, inline_worker=False)


@pytest.fixture
def client(state):
    return TestClient(create_app(state))


def start(client, data: bytes = CSV, **extra):
    r = client.post("/v1/datasets/uploads", json={"filename": "sales.csv", "size": len(data), **extra}, headers=H)
    assert r.status_code == 201, r.text
    return r.json()


def send(client, upload_id: str, offset: int, part: bytes, headers=H):
    return client.patch(f"/v1/datasets/uploads/{upload_id}", content=part, headers={**headers, "Upload-Offset": str(offset)})


def test_resume_after_interruption_and_complete(client, state):
    up = start(client, sha256=hashlib.sha256(CSV).hexdigest())
    assert up["offset"] == 0 and up["status"] == "open"
    third = len(CSV) // 3

    r = send(client, up["id"], 0, CSV[:third])
    assert r.status_code == 200 and r.headers["Upload-Offset"] == str(third)
    # The client "lost" the response and resends the same part: refused with the server's offset.
    r = send(client, up["id"], 0, CSV[:third])
    assert r.status_code == 409 and r.headers["Upload-Offset"] == str(third)
    assert r.json()["detail"]["offset"] == third
    # It asks where to resume, then sends the rest.
    assert client.get(f"/v1/datasets/uploads/{up['id']}", headers=H).json()["offset"] == third
    assert client.post(f"/v1/datasets/uploads/{up['id']}/complete", headers=H).status_code == 409  # incomplete
    assert send(client, up["id"], third, CSV[third : 2 * third]).status_code == 200
    assert send(client, up["id"], 2 * third, CSV[2 * third :]).status_code == 200
    # no bytes beyond the declared size
    assert send(client, up["id"], len(CSV), b"x").status_code == 413

    r = client.post(f"/v1/datasets/uploads/{up['id']}/complete", headers=H)
    assert r.status_code == 201, r.text
    body = r.json()
    ds = body["dataset"]
    assert ds["tables"][0]["sha256"] == hashlib.sha256(CSV).hexdigest()
    assert [c["name"] for c in body["inference"]["columns"]][:3] == ["id", "region", "amount"]
    q = client.post(f"/v1/datasets/{ds['id']}/query", json={"sql": "SELECT count(*) AS n FROM data"}, headers=H)
    assert q.json()["rows"] == [[2000]]

    # idempotent completion; parts are gone from object storage
    again = client.post(f"/v1/datasets/uploads/{up['id']}/complete", headers=H)
    assert again.status_code == 201 and again.json()["dataset"]["id"] == ds["id"]
    assert list(state.store.objects.list("acme", f"uploads/{up['id']}/")) == []
    status = client.get(f"/v1/datasets/uploads/{up['id']}", headers=H).json()
    assert status["status"] == "completed" and status["dataset_id"] == ds["id"]


def test_parts_are_encrypted_at_rest(client, state):
    up = start(client)
    assert send(client, up["id"], 0, CSV[:500]).status_code == 200
    stored = [k for k, _ in state.store.objects.list("acme", f"uploads/{up['id']}/")]
    assert len(stored) == 1
    raw = state.cloud.objects.get_bytes(f"tenants/acme/{stored[0]}")
    assert CSV[:100] not in raw


def test_limits_checked_before_transfer(tmp_path):
    state = build_state(
        data_dir=tmp_path, dev_auth=True, cloud_provider="local", database_url=None, inline_worker=False, upload_part_max_bytes=1000
    )
    client = TestClient(create_app(state))
    r = client.post("/v1/datasets/uploads", json={"filename": "big.csv", "size": state.store.max_dataset_bytes + 1}, headers=H)
    assert r.status_code == 413 and "GB" in r.json()["detail"]
    up = start(client)
    assert up["part_max_bytes"] == 1000
    assert send(client, up["id"], 0, CSV[:1001]).status_code == 413
    assert send(client, up["id"], 0, b"").status_code == 422
    assert send(client, up["id"], 0, CSV[:1000]).status_code == 200


def test_checksum_mismatch_aborts(client):
    up = start(client, sha256="0" * 64)
    assert send(client, up["id"], 0, CSV).status_code == 200
    r = client.post(f"/v1/datasets/uploads/{up['id']}/complete", headers=H)
    assert r.status_code == 422 and "checksum" in r.json()["detail"]
    assert client.get(f"/v1/datasets/uploads/{up['id']}", headers=H).status_code == 404


def test_abort_and_isolation(client, state):
    up = start(client)
    assert send(client, up["id"], 0, CSV[:100]).status_code == 200
    other_user = {"X-Tenant-ID": "acme", "X-User-ID": "someone-else"}
    other_tenant = {"X-Tenant-ID": "globex", "X-User-ID": "admin"}
    assert client.get(f"/v1/datasets/uploads/{up['id']}", headers=other_user).status_code == 404
    assert client.get(f"/v1/datasets/uploads/{up['id']}", headers=other_tenant).status_code == 404
    assert send(client, up["id"], 100, CSV[100:200], headers=other_tenant).status_code == 404
    assert client.delete(f"/v1/datasets/uploads/{up['id']}", headers=H).status_code == 204
    assert list(state.store.objects.list("acme", f"uploads/{up['id']}/")) == []
    assert send(client, up["id"], 100, CSV[100:200]).status_code == 404


def test_expired_sessions_are_refused_and_purged(client, state):
    from datetime import timedelta

    from sqlalchemy import update

    from app.db.models import UploadSession, utcnow

    up = start(client)
    assert send(client, up["id"], 0, CSV[:100]).status_code == 200
    with state.db.session("acme") as s:
        s.execute(update(UploadSession).where(UploadSession.id == up["id"]).values(expires_at=utcnow() - timedelta(minutes=1)))
    assert send(client, up["id"], 100, CSV[100:200]).status_code == 410
    assert list(state.store.objects.list("acme", f"uploads/{up['id']}/")) == []


def test_readonly_role_cannot_upload(client):
    r = client.post("/v1/tenant/api-keys", json={"name": "ro", "role": "viewer"}, headers=H)
    assert r.status_code == 201, r.text
    key = {"X-API-Key": r.json()["key"]}
    assert client.post("/v1/datasets/uploads", json={"filename": "a.csv", "size": 10}, headers=key).status_code == 403
