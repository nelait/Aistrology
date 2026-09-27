"""ING-007: S3/GCS and database connectors, credentials in the SecretStore, SSRF guard, imports as jobs."""

from __future__ import annotations

import json
import socket
import sqlite3

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from app.api.deps import build_state
from app.cloud.local import LocalObjectStore
from app.connectors import service as connector_service
from app.connectors.ssrf import BlockedHost, check_host
from app.jobs.core import Worker
from app.main import create_app

ACME = {"X-Tenant-ID": "acme", "X-User-ID": "ana"}
CSV = b"id,region,amount\n" + b"\n".join(f"{i},{'ew'[i % 2]},{i * 1.5}".encode() for i in range(1, 51)) + b"\n"


def test_ssrf_guard(monkeypatch):
    for host in ("127.0.0.1", "localhost", "169.254.169.254", "0.0.0.0", "::1", "224.0.0.1"):
        with pytest.raises(BlockedHost):
            check_host(host, tenant_allowlist=["0.0.0.0/1", "128.0.0.0/1", "localhost"])
    with pytest.raises(BlockedHost, match="private"):
        check_host("10.1.2.3")
    assert check_host("10.1.2.3", tenant_allowlist=["10.0.0.0/8"]) == ["10.1.2.3"]
    assert check_host("8.8.8.8") == ["8.8.8.8"]
    # Loopback / link-local only via the platform allowlist.
    assert check_host("127.0.0.1", platform_allowlist=["127.0.0.1/32"]) == ["127.0.0.1"]
    with pytest.raises(BlockedHost, match="invalid host"):
        check_host("evil.example/@127.0.0.1")

    # Every resolved address is checked (a public name that also resolves to a private address is blocked).
    def fake_getaddrinfo(host, port, *args, **kwargs):
        table = {"db.corp.example": ["10.9.8.7"], "mixed.example": ["93.184.216.34", "192.168.1.1"], "public.example": ["93.184.216.34"]}
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port or 0)) for ip in table[host]]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    assert check_host("db.corp.example", tenant_allowlist=["*.corp.example"]) == ["10.9.8.7"]
    with pytest.raises(BlockedHost):
        check_host("mixed.example")
    assert check_host("public.example") == ["93.184.216.34"]


@pytest.fixture
def state(tmp_path):
    return build_state(
        data_dir=tmp_path / "data",
        dev_auth=True,
        cloud_provider="local",
        database_url=None,
        connector_allow_sqlite=True,
        connector_max_rows=1000,
    )


@pytest.fixture
def client(state):
    return TestClient(create_app(state=state))


def drain(state):
    return Worker(state, wait_seconds=0).drain()


def _job(client, job_id):
    return client.get(f"/v1/jobs/{job_id}", headers=ACME).json()


def test_s3_import_with_tenant_credentials(client, state, monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1", aws_access_key_id="AKIATEST", aws_secret_access_key="secret")
        s3.create_bucket(Bucket="tenant-bucket")
        s3.put_object(Bucket="tenant-bucket", Key="exports/sales.csv", Body=CSV)
        s3.put_object(Bucket="tenant-bucket", Key="exports/regions.csv", Body=b"region,name\ne,East\nw,West\n")
        body = {
            "name": "warehouse",
            "kind": "s3",
            "config": {"bucket": "tenant-bucket", "region": "us-east-1"},
            "credentials": {"access_key_id": "AKIATEST", "secret_access_key": "super-secret-value"},
        }
        r = client.post("/v1/connectors", json=body, headers=ACME)
        assert r.status_code == 201, r.text
        conn = r.json()
        assert "credentials" not in conn and "super-secret-value" not in r.text
        stored = json.loads(state.secrets.get("acme", f"connector-{conn['id']}"))
        assert stored["secret_access_key"] == "super-secret-value"
        assert client.post("/v1/connectors", json=body, headers=ACME).status_code == 409
        assert [c["name"] for c in client.get("/v1/connectors", headers=ACME).json()] == ["warehouse"]

        job = client.post(f"/v1/connectors/{conn['id']}/import", json={"key": "exports/sales.csv"}, headers=ACME)
        assert job.status_code == 202, job.text
        drain(state)
        done = _job(client, job.json()["id"])
        assert done["status"] == "succeeded", done
        ds = client.get(f"/v1/datasets/{done['result']['dataset_id']}", headers=ACME).json()
        assert ds["source"] == "connector" and ds["name"] == "sales" and ds["schema"]["entities"][0]["fields"][0]["primary_key"]
        q = client.post(f"/v1/datasets/{ds['id']}/query", json={"sql": "SELECT count(*) FROM data"}, headers=ACME).json()
        assert q["rows"] == [[50]]

        # A prefix imports every object as one table of the dataset.
        job = client.post(f"/v1/connectors/{conn['id']}/import", json={"prefix": "exports/", "name": "exports"}, headers=ACME).json()
        drain(state)
        done = _job(client, job["id"])
        assert done["status"] == "succeeded", done
        assert sorted(t["name"] for t in done["result"]["tables"]) == ["regions", "sales"]

        missing = client.post(f"/v1/connectors/{conn['id']}/import", json={"key": "nope.csv"}, headers=ACME).json()
        drain(state)
        failed = _job(client, missing["id"])
        assert failed["status"] == "failed" and "not found" in failed["error"] and failed["attempts"] == 1

    assert client.post(f"/v1/connectors/{conn['id']}/import", json={"query": "SELECT 1"}, headers=ACME).status_code == 422
    assert client.post(f"/v1/connectors/{conn['id']}/import", json={}, headers=ACME).status_code == 422
    assert client.get(f"/v1/connectors/{conn['id']}", headers={"X-Tenant-ID": "globex"}).status_code == 404
    assert client.delete(f"/v1/connectors/{conn['id']}", headers=ACME).status_code == 204
    assert state.secrets.get("acme", f"connector-{conn['id']}") is None


def test_gcs_import_uses_the_client_factory(client, state, tmp_path, monkeypatch):
    bucket = LocalObjectStore(tmp_path / "fake-gcs")
    bucket.put_bytes("data/sales.csv", CSV)
    seen = {}

    def fake_factory(config, creds):
        seen["bucket"], seen["creds"] = config.bucket, creds.service_account_json.get_secret_value()
        return bucket

    monkeypatch.setitem(connector_service.OBJECT_STORE_FACTORIES, "gcs", fake_factory)
    body = {"name": "gcs", "kind": "gcs", "config": {"bucket": "my-bucket"}, "credentials": {"service_account_json": '{"type": "x"}'}}
    conn = client.post("/v1/connectors", json=body, headers=ACME).json()
    job = client.post(f"/v1/connectors/{conn['id']}/import", json={"key": "data/sales.csv"}, headers=ACME).json()
    drain(state)
    assert _job(client, job["id"])["status"] == "succeeded"
    assert seen == {"bucket": "my-bucket", "creds": '{"type": "x"}'}


def test_database_import_read_only_with_caps(client, state, tmp_path):
    db = tmp_path / "source.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE orders (id INTEGER PRIMARY KEY, region TEXT, amount REAL)")
    con.executemany("INSERT INTO orders VALUES (?, ?, ?)", [(i, "ew"[i % 2], i * 2.0) for i in range(1, 2001)])
    con.commit()
    con.close()
    conn = client.post("/v1/connectors", json={"name": "src", "kind": "sqlite", "config": {"database": str(db)}}, headers=ACME).json()

    job = client.post(
        f"/v1/connectors/{conn['id']}/import", json={"query": "SELECT * FROM orders WHERE region = 'e'", "name": "east"}, headers=ACME
    )
    assert job.status_code == 202, job.text
    drain(state)
    done = _job(client, job.json()["id"])
    assert done["status"] == "succeeded", done
    ds_id = done["result"]["dataset_id"]
    rows = client.post(f"/v1/datasets/{ds_id}/query", json={"sql": "SELECT count(*), min(region) FROM data"}, headers=ACME).json()["rows"]
    assert rows == [[1000, "e"]]

    # The platform row cap (1000 in this test) truncates, and says so.
    job = client.post(f"/v1/connectors/{conn['id']}/import", json={"query": "SELECT * FROM orders -- all"}, headers=ACME).json()
    drain(state)
    done = _job(client, job["id"])
    assert done["result"]["tables"][0]["row_count"] == 1000 and any("truncated" in w for w in done["result"]["warnings"])

    # Only a single SELECT is accepted, checked before a job is queued.
    for sql in ("DELETE FROM orders", "SELECT 1; DROP TABLE orders", "ATTACH 'x' AS y"):
        assert client.post(f"/v1/connectors/{conn['id']}/import", json={"query": sql}, headers=ACME).status_code == 422
    con = sqlite3.connect(db)
    assert con.execute("SELECT count(*) FROM orders").fetchone() == (2000,)
    con.close()


def test_database_connectors_are_ssrf_checked(client, state):
    pg = {
        "name": "pg",
        "kind": "postgresql",
        "config": {"host": "127.0.0.1", "database": "prod"},
        "credentials": {"username": "u", "password": "p"},
    }
    r = client.post("/v1/connectors", json=pg, headers=ACME)
    assert r.status_code == 422 and "loopback" in r.json()["detail"]
    private = {**pg, "config": {"host": "10.20.30.40", "database": "prod"}}
    assert "private" in client.post("/v1/connectors", json=private, headers=ACME).json()["detail"]
    assert client.put("/v1/connectors/allowlist", json={"hosts": ["0.0.0.0/0"]}, headers=ACME).status_code == 422
    assert client.put("/v1/connectors/allowlist", json={"hosts": ["10.20.0.0/16", "*.corp.example"]}, headers=ACME).status_code == 200
    assert client.get("/v1/connectors/allowlist", headers=ACME).json() == {"hosts": ["10.20.0.0/16", "*.corp.example"]}
    assert client.post("/v1/connectors", json=private, headers=ACME).status_code == 201
    # The tenant allowlist can never open loopback or metadata addresses.
    client.put("/v1/connectors/allowlist", json={"hosts": ["127.0.0.0/8", "169.254.0.0/16"]}, headers=ACME)
    assert client.post("/v1/connectors", json={**pg, "name": "pg2"}, headers=ACME).status_code == 422
    meta = {**pg, "name": "meta", "config": {"host": "169.254.169.254", "database": "x"}}
    assert client.post("/v1/connectors", json=meta, headers=ACME).status_code == 422
    s3 = {
        "name": "minio",
        "kind": "s3",
        "config": {"bucket": "bkt", "endpoint_url": "http://127.0.0.1:9000"},
        "credentials": {"access_key_id": "a", "secret_access_key": "b"},
    }
    assert client.post("/v1/connectors", json=s3, headers=ACME).status_code == 422
    bad = {**pg, "name": "bad", "config": {"host": "db.example/../x", "database": "x"}}
    assert client.post("/v1/connectors", json=bad, headers=ACME).status_code == 422


def test_sqlite_connectors_disabled_by_default(tmp_path):
    client = TestClient(create_app(build_state(data_dir=tmp_path, dev_auth=True, cloud_provider="local", database_url=None)))
    r = client.post("/v1/connectors", json={"name": "src", "kind": "sqlite", "config": {"database": "/etc/passwd"}}, headers=ACME)
    assert r.status_code == 422 and "disabled" in r.json()["detail"]
