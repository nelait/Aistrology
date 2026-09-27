from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.api.deps import build_state
from app.main import create_app

PASSWORD = "Correct-Horse-9-Battery"
CSV = b"id,region,amount\n1,e,1\n2,w,2\n3,e,3\n"


@pytest.fixture
def client(tmp_path):
    return TestClient(
        create_app(build_state(data_dir=tmp_path, dev_auth=False, cloud_provider="local", database_url=None, inline_worker=False))
    )


def bearer(client, email):
    return {"Authorization": f"Bearer {client.post('/v1/auth/login', json={'email': email, 'password': PASSWORD}).json()['access_token']}"}


def test_project_isolation(client):
    client.post("/v1/auth/signup", json={"tenant_id": "acme", "org_name": "Acme", "email": "ada@acme.example", "password": PASSWORD})
    admin = bearer(client, "ada@acme.example")
    for email in ("ann@acme.example", "bob@acme.example"):
        client.post("/v1/tenant/users", json={"email": email, "role": "analyst", "password": PASSWORD}, headers=admin)
    users = {u["email"]: u["id"] for u in client.get("/v1/tenant/users", headers=admin).json()}
    secret = client.post("/v1/projects", json={"name": "Finance", "members": [users["ann@acme.example"]]}, headers=admin).json()
    ann, bob = bearer(client, "ann@acme.example"), bearer(client, "bob@acme.example")

    assert {p["name"] for p in client.get("/v1/projects", headers=bob).json()} == {"Default"}
    assert {p["name"] for p in client.get("/v1/projects", headers=ann).json()} == {"Default", "Finance"}

    fin = client.post(f"/v1/datasets?project_id={secret['id']}", files={"file": ("ledger.csv", CSV)}, headers=ann).json()["dataset"]
    public = client.post("/v1/datasets", files={"file": ("open.csv", CSV)}, headers=bob).json()["dataset"]
    assert fin["project_id"] == secret["id"] and public["project_id"] != secret["id"]

    # bob can't see, query, clean, model or reference the Finance dataset anywhere
    assert [d["name"] for d in client.get("/v1/datasets", headers=bob).json()] == ["open"]
    assert client.get(f"/v1/datasets/{fin['id']}", headers=bob).status_code == 404
    assert client.post(f"/v1/datasets/{fin['id']}/query", json={"sql": "SELECT 1"}, headers=bob).status_code == 404
    assert client.post("/v1/pipelines", json={"dataset_id": fin["id"], "name": "x"}, headers=bob).status_code == 404
    assert client.post("/v1/analytics", json={"dataset_id": fin["id"], "name": "x", "sql": "SELECT 1"}, headers=bob).status_code == 404
    assert client.post(f"/v1/datasets?project_id={secret['id']}", files={"file": ("x.csv", CSV)}, headers=bob).status_code == 404
    # ann and the admin can
    assert client.get(f"/v1/datasets/{fin['id']}", headers=ann).status_code == 200
    assert len(client.get("/v1/datasets", headers=admin).json()) == 2
    assert len(client.get(f"/v1/datasets?project_id={secret['id']}", headers=admin).json()) == 1
    # membership changes take effect immediately
    client.post(f"/v1/projects/{secret['id']}/members", json={"user_id": users["bob@acme.example"]}, headers=admin)
    assert client.get(f"/v1/datasets/{fin['id']}", headers=bob).status_code == 200
    client.delete(f"/v1/projects/{secret['id']}/members/{users['bob@acme.example']}", headers=admin)
    assert client.get(f"/v1/datasets/{fin['id']}", headers=bob).status_code == 404
    assert client.post("/v1/projects", json={"name": "Finance"}, headers=admin).status_code == 409
    assert client.post("/v1/projects", json={"name": "Ops"}, headers=ann).status_code == 403
