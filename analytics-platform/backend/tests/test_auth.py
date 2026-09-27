from __future__ import annotations

import pyotp
import pytest
from fastapi.testclient import TestClient

from app.api.deps import build_state
from app.auth.rbac import Permission, Role, has_permission
from app.main import create_app
from app.ratelimit import RateLimiter

PASSWORD = "Correct-Horse-9-Battery"
CSV = "id,region,amount\n" + "\n".join(f"{i},{'ew'[i % 2]},{i}" for i in range(1, 51))


@pytest.fixture
def state(tmp_path):
    return build_state(data_dir=tmp_path, dev_auth=False, cloud_provider="local", database_url=None)


@pytest.fixture
def client(state):
    return TestClient(create_app(state))


def signup(client, tenant="acme", email="ada@acme.example"):
    r = client.post("/v1/auth/signup", json={"tenant_id": tenant, "org_name": tenant.title(), "email": email, "password": PASSWORD})
    assert r.status_code == 201, r.text
    return r.json()


def login(client, email="ada@acme.example", password=PASSWORD, totp=None):
    return client.post("/v1/auth/login", json={"email": email, "password": password, "totp": totp})


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def admin_headers(client, tenant="acme", email="ada@acme.example"):
    signup(client, tenant, email)
    return bearer(login(client, email).json()["access_token"])


def test_rbac_matrix():
    assert has_permission("admin", Permission.MANAGE_TENANT)
    assert has_permission("data_scientist", Permission.TRAIN_MODELS)
    assert not has_permission("analyst", Permission.TRAIN_MODELS)
    assert not has_permission("data_engineer", Permission.TRAIN_MODELS)
    assert has_permission("data_engineer", Permission.DEPLOY)
    assert not has_permission("viewer", Permission.WRITE_DATA)
    assert has_permission("viewer", Permission.VIEW)
    assert not has_permission("nonsense", Permission.VIEW)
    assert not has_permission("admin", Permission.WRITE_DATA, scopes=["endpoints.predict"])


def test_signup_validation_and_conflicts(client):
    signup(client)
    assert (
        client.post(
            "/v1/auth/signup", json={"tenant_id": "acme", "org_name": "x", "email": "b@x.example", "password": PASSWORD}
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/v1/auth/signup", json={"tenant_id": "other", "org_name": "x", "email": "ada@acme.example", "password": PASSWORD}
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/v1/auth/signup", json={"tenant_id": "platform", "org_name": "x", "email": "c@x.example", "password": PASSWORD}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/v1/auth/signup", json={"tenant_id": "weak", "org_name": "x", "email": "d@x.example", "password": "alllowercase123"}
        ).status_code
        == 422
    )


def test_login_refresh_rotation_and_reuse_detection(client):
    signup(client)
    assert login(client, password="Wrong-password-1").status_code == 401
    tokens = login(client).json()
    me = client.get("/v1/auth/me", headers=bearer(tokens["access_token"])).json()
    assert me["role"] == "admin" and me["tenant_id"] == "acme" and me["email"] == "ada@acme.example"
    new = client.post("/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]}).json()
    assert new["refresh_token"] != tokens["refresh_token"]
    # reusing the old refresh token revokes the whole family
    r = client.post("/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert r.status_code == 401 and r.json()["detail"]["code"] == "token_reuse"
    assert client.post("/v1/auth/refresh", json={"refresh_token": new["refresh_token"]}).status_code == 401
    assert client.get("/v1/auth/me", headers=bearer("not.a.jwt")).status_code == 401


def test_lockout_after_repeated_failures(client):
    signup(client)
    for _ in range(5):
        assert login(client, password="Wrong-password-1").status_code == 401
    r = login(client)
    assert r.status_code == 401 and r.json()["detail"]["code"] == "locked"


def test_mfa_enrollment_and_enforcement(client, state):
    headers = admin_headers(client)
    uri = client.post("/v1/auth/mfa/setup", headers=headers).json()["otpauth_uri"]
    secret = pyotp.parse_uri(uri).secret
    assert client.post("/v1/auth/mfa/activate", json={"code": "000000"}, headers=headers).status_code == 401
    assert client.post("/v1/auth/mfa/activate", json={"code": pyotp.TOTP(secret).now()}, headers=headers).status_code == 204
    r = login(client)
    assert r.status_code == 401 and r.json()["detail"]["code"] == "mfa_required"
    assert login(client, totp="123456").status_code == 401
    assert login(client, totp=pyotp.TOTP(secret).now()).status_code == 200
    # the MFA secret lives in the secret store, not the database, and isn't listed to admins
    assert state.secrets.get("acme", next(n for n in state.secrets.names("acme") if n.startswith("mfa-")))
    assert client.get("/v1/tenant/secrets", headers=bearer(login(client, totp=pyotp.TOTP(secret).now()).json()["access_token"])).json() == {
        "names": []
    }


def test_tenant_can_require_mfa(client):
    headers = admin_headers(client)
    client.post("/v1/tenant/users", json={"email": "vic@acme.example", "role": "viewer", "password": PASSWORD}, headers=headers)
    client.patch("/v1/tenant", json={"require_mfa": True}, headers=headers)
    r = login(client, "vic@acme.example")
    assert r.status_code == 401 and r.json()["detail"]["code"] == "mfa_enrollment_required"


def test_rbac_enforced_on_endpoints(client):
    headers = admin_headers(client)
    r = client.post("/v1/tenant/users", json={"email": "vic@acme.example", "role": "viewer", "password": PASSWORD}, headers=headers)
    assert r.status_code == 201
    viewer = bearer(login(client, "vic@acme.example").json()["access_token"])
    assert client.get("/v1/datasets", headers=viewer).status_code == 200
    assert client.post("/v1/datasets", files={"file": ("x.csv", CSV.encode())}, headers=viewer).status_code == 403
    assert client.get("/v1/tenant/users", headers=viewer).status_code == 403
    assert client.get("/v1/tenant/audit", headers=viewer).status_code == 403
    # admin disables the viewer → existing access token stops working immediately
    uid = r.json()["id"]
    assert client.patch(f"/v1/tenant/users/{uid}", json={"disabled": True}, headers=headers).status_code == 200
    assert client.get("/v1/datasets", headers=viewer).status_code == 401
    me = client.get("/v1/auth/me", headers=headers).json()
    assert client.patch(f"/v1/tenant/users/{me['id']}", json={"role": "viewer"}, headers=headers).status_code == 400


def test_api_keys_scopes_rotation_revocation(client):
    headers = admin_headers(client)
    created = client.post(
        "/v1/tenant/api-keys", json={"name": "etl", "role": "data_engineer", "scopes": ["data.read", "data.write"]}, headers=headers
    ).json()
    key = created["key"]
    assert key.startswith("ap_live_") and "key_hash" not in created
    listed = client.get("/v1/tenant/api-keys", headers=headers).json()
    assert [k["prefix"] for k in listed] == [created["prefix"]] and "key" not in listed[0]
    assert client.post("/v1/datasets", files={"file": ("x.csv", CSV.encode())}, headers={"X-API-Key": key}).status_code == 201
    assert client.get("/v1/datasets", headers=bearer(key)).status_code == 200
    # scope narrowing: data_engineer can deploy, but this key isn't scoped for it
    assert client.get("/v1/tenant/api-keys", headers={"X-API-Key": key}).status_code == 403
    rotated = client.post(f"/v1/tenant/api-keys/{created['id']}/rotate", headers=headers).json()
    assert client.get("/v1/datasets", headers={"X-API-Key": key}).status_code == 401
    assert client.get("/v1/datasets", headers={"X-API-Key": rotated["key"]}).status_code == 200
    assert client.delete(f"/v1/tenant/api-keys/{rotated['id']}", headers=headers).status_code == 204
    assert client.get("/v1/datasets", headers={"X-API-Key": rotated["key"]}).status_code == 401
    assert client.get("/v1/datasets", headers={"X-API-Key": "ap_live_000000000000_" + "x" * 40}).status_code == 401
    ip_locked = client.post("/v1/tenant/api-keys", json={"name": "ip", "allowed_ips": ["203.0.113.9"]}, headers=headers).json()
    assert client.get("/v1/datasets", headers={"X-API-Key": ip_locked["key"]}).status_code == 401


def test_jwt_tenant_isolation(client):
    acme = admin_headers(client)
    globex = admin_headers(client, "globex", "gil@globex.example")
    ds = client.post("/v1/datasets", files={"file": ("x.csv", CSV.encode())}, headers=acme).json()["dataset"]["id"]
    assert client.get(f"/v1/datasets/{ds}", headers=globex).status_code == 404
    assert client.get("/v1/datasets", headers=globex).json() == []


def test_rate_limit(client, state):
    state.rate_limiter = RateLimiter(burst_seconds=1)
    headers = admin_headers(client)
    created = client.post("/v1/tenant/api-keys", json={"name": "slow", "rate_limit_per_minute": 60}, headers=headers).json()
    codes = [client.get("/v1/datasets", headers={"X-API-Key": created["key"]}).status_code for _ in range(3)]
    assert codes[0] == 200 and 429 in codes


def test_tenant_deletion_shreds_keys_and_data(client, state):
    headers = admin_headers(client)
    ds = client.post("/v1/datasets", files={"file": ("x.csv", CSV.encode())}, headers=headers).json()["dataset"]["id"]
    client.put("/v1/tenant/secrets/openai", json={"value": "sk-1"}, headers=headers)
    assert list(state.cloud.objects.list("tenants/acme/"))
    assert client.delete("/v1/tenant?confirm=wrong", headers=headers).status_code == 400
    r = client.delete("/v1/tenant?confirm=acme", headers=headers)
    assert r.status_code == 202 and r.json()["key_shredded"]
    assert list(state.cloud.objects.list("tenants/acme/")) == []
    assert not state.cloud.objects.exists("keys/acme/dek.wrapped")
    assert state.secrets.names("acme") == []
    assert client.get(f"/v1/datasets/{ds}", headers=headers).status_code == 401  # tenant no longer active
    assert state.audit.verify("acme") and state.audit.entries("acme")[-1].action == "tenant.deleted"


def test_login_failures_are_audited(client, state):
    signup(client)
    login(client, password="Wrong-password-1")
    assert state.audit.entries("platform", "auth.login_failed")


def test_role_enum_values_match_rbac():
    assert {r.value for r in Role} == {"admin", "data_engineer", "data_scientist", "analyst", "viewer"}
