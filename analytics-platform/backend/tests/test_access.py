"""MGT-004a OAuth client credentials, MGT-007 IP policy, AUTH-004 teams, AUTH-001a SCIM."""

from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient

from app.api.deps import build_state
from app.main import create_app

from .test_auth import CSV, PASSWORD, admin_headers, bearer, login


@pytest.fixture
def state(tmp_path):
    return build_state(data_dir=tmp_path, dev_auth=False, cloud_provider="local", database_url=None, inline_worker=False)


@pytest.fixture
def app(state):
    return create_app(state)


@pytest.fixture
def client(app):
    return TestClient(app)


def add_user(client, h, email, role="analyst"):
    r = client.post("/v1/tenant/users", json={"email": email, "role": role, "password": PASSWORD}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"], bearer(login(client, email).json()["access_token"])


# -- MGT-004a --------------------------------------------------------------------------------------------


def test_oauth_client_credentials(client, state):
    h = admin_headers(client)
    r = client.post("/v1/tenant/oauth-clients", json={"name": "etl", "role": "analyst", "scopes": ["data.read"]}, headers=h)
    assert r.status_code == 201, r.text
    created = r.json()
    cid, secret = created["client_id"], created["client_secret"]
    assert "client_secret" not in client.get("/v1/tenant/oauth-clients", headers=h).json()[0]

    basic = base64.b64encode(f"{cid}:{secret}".encode()).decode()
    tok = client.post("/oauth/token", data={"grant_type": "client_credentials"}, headers={"Authorization": f"Basic {basic}"})
    assert tok.status_code == 200 and tok.headers["cache-control"] == "no-store"
    body = tok.json()
    assert body["token_type"] == "bearer" and body["scope"] == "data.read" and body["expires_in"] == 900
    at = bearer(body["access_token"])
    me = client.get("/v1/auth/me", headers=at).json()
    assert me["method"] == "oauth_client" and me["tenant_id"] == "acme" and me["role"] == "analyst"
    assert client.get("/v1/datasets", headers=at).status_code == 200
    # scopes narrow the role: analysts may upload, this client may not
    assert client.post("/v1/datasets", files={"file": ("d.csv", CSV.encode())}, headers=at).status_code == 403

    # credentials in the body; sub-scope request
    body2 = client.post(
        "/oauth/token", data={"grant_type": "client_credentials", "client_id": cid, "client_secret": secret, "scope": "data.read"}
    )
    assert body2.status_code == 200
    bad_scope = client.post(
        "/oauth/token", data={"grant_type": "client_credentials", "client_id": cid, "client_secret": secret, "scope": "tenant.manage"}
    )
    assert bad_scope.status_code == 400 and bad_scope.json()["error"] == "invalid_scope"
    wrong = client.post("/oauth/token", data={"grant_type": "client_credentials", "client_id": cid, "client_secret": secret + "x"})
    assert wrong.status_code == 401 and wrong.json()["error"] == "invalid_client"
    assert client.post("/oauth/token", data={"grant_type": "password"}).json()["error"] == "unsupported_grant_type"
    assert client.post("/oauth/token", data={}).json()["error"] == "invalid_request"
    # a user access token is not an OAuth token and vice versa; tampering is rejected
    assert client.get("/v1/auth/me", headers=h).json()["method"] == "jwt"
    assert client.get("/v1/auth/me", headers=bearer(body["access_token"][:-2] + "xx")).status_code == 401

    # revocation takes effect immediately
    assert client.delete(f"/v1/tenant/oauth-clients/{created['id']}", headers=h).status_code == 204
    assert client.get("/v1/datasets", headers=at).status_code == 401
    assert (
        client.post("/oauth/token", data={"grant_type": "client_credentials", "client_id": cid, "client_secret": secret}).status_code == 401
    )
    assert state.audit.entries("acme", "oauth_client.create") and state.audit.entries("acme", "oauth_client.revoke")


def test_oauth_admin_clients_need_admin(client):
    h = admin_headers(client)
    _, ds = add_user(client, h, "ds@acme.example", "data_scientist")
    assert client.post("/v1/tenant/oauth-clients", json={"name": "x", "role": "admin"}, headers=ds).status_code == 403
    assert client.post("/v1/tenant/oauth-clients", json={"name": "x", "role": "viewer"}, headers=ds).status_code == 201


# -- MGT-007 ---------------------------------------------------------------------------------------------


def test_network_policy(app, state):
    office = TestClient(app, client=("10.1.2.3", 5000))
    home = TestClient(app, client=("198.51.100.7", 5000))
    h = admin_headers(office)
    key = office.post("/v1/tenant/api-keys", json={"name": "k", "role": "analyst"}, headers=h).json()["key"]
    assert office.put("/v1/tenant/network-policy", json={"allow": ["not-an-ip"]}, headers=h).status_code == 422
    # can't lock yourself out
    assert office.put("/v1/tenant/network-policy", json={"deny": ["10.0.0.0/8"]}, headers=h).status_code == 409
    r = office.put("/v1/tenant/network-policy", json={"allow": ["10.0.0.0/8", "10.1.2.3"]}, headers=h)
    assert r.status_code == 200 and r.json()["allow"] == ["10.0.0.0/8", "10.1.2.3/32"]
    assert office.get("/v1/datasets", headers=h).status_code == 200
    denied = home.get("/v1/datasets", headers=h)
    assert denied.status_code == 403 and denied.json()["detail"]["code"] == "ip_denied"
    assert home.get("/v1/datasets", headers={"X-API-Key": key}).status_code == 403  # every principal type
    assert office.get("/v1/datasets", headers={"X-API-Key": key}).status_code == 200
    # other tenants are unaffected
    other = admin_headers(home, "globex", "gia@globex.example")
    assert home.get("/v1/datasets", headers=other).status_code == 200
    # deny beats allow
    office.put("/v1/tenant/network-policy", json={"allow": ["10.0.0.0/8"], "deny": ["10.9.0.0/16"]}, headers=h)
    assert TestClient(app, client=("10.9.1.1", 1)).get("/v1/datasets", headers=h).status_code == 403
    assert state.audit.entries("acme", "auth.ip_denied")


# -- AUTH-004 --------------------------------------------------------------------------------------------


def test_teams_grant_project_visibility(client, state):
    h = admin_headers(client)
    an_id, an = add_user(client, h, "an@acme.example")
    secret = client.post("/v1/projects", json={"name": "Secret"}, headers=h).json()["id"]
    visible = lambda: {p["id"] for p in client.get("/v1/projects", headers=an).json()}  # noqa: E731
    assert secret not in visible()
    team = client.post("/v1/teams", json={"name": "Finance", "members": [an_id]}, headers=h)
    assert team.status_code == 201 and team.json()["members"] == [an_id]
    tid = team.json()["id"]
    assert client.post("/v1/teams", json={"name": "Finance"}, headers=h).status_code == 409
    assert client.post("/v1/teams", json={"name": "Other", "members": ["usr_nope"]}, headers=h).status_code == 422
    assert client.post(f"/v1/projects/{secret}/teams", json={"team_id": tid}, headers=h).status_code == 204
    assert secret in visible()
    assert client.get(f"/v1/teams/{tid}", headers=an).json()["projects"] == [secret]
    assert client.post(f"/v1/projects/{secret}/teams", json={"team_id": tid}, headers=an).status_code == 403
    assert client.delete(f"/v1/teams/{tid}/members/{an_id}", headers=h).status_code == 204
    assert secret not in visible()
    client.post(f"/v1/teams/{tid}/members", json={"user_id": an_id}, headers=h)
    assert secret in visible()
    assert client.delete(f"/v1/projects/{secret}/teams/{tid}", headers=h).status_code == 204
    assert secret not in visible()
    # tenant isolation: another tenant can't see or use the team
    g = admin_headers(client, "globex", "gia@globex.example")
    assert client.get(f"/v1/teams/{tid}", headers=g).status_code == 404
    gp = client.post("/v1/projects", json={"name": "G"}, headers=g).json()["id"]
    assert client.post(f"/v1/projects/{gp}/teams", json={"team_id": tid}, headers=g).status_code == 404
    assert client.delete(f"/v1/teams/{tid}", headers=h).status_code == 204
    assert state.audit.entries("acme", "team.create") and state.audit.entries("acme", "project.team.add")


# -- AUTH-001a SCIM --------------------------------------------------------------------------------------

EXT = "urn:ietf:params:scim:schemas:extension:analyticsplatform:2.0:User"


def test_scim_provisioning(client, state):
    h = admin_headers(client)
    assert client.get("/scim/v2/Users").status_code == 401
    assert client.get("/v1/tenant/scim-token", headers=h).json()["configured"] is False
    token = client.post("/v1/tenant/scim-token", headers=h).json()["token"]
    assert token.startswith("scim_acme_")
    s = {"Authorization": f"Bearer {token}"}
    assert client.get("/scim/v2/Users", headers={"Authorization": "Bearer scim_acme_wrong"}).status_code == 401
    assert client.get("/scim/v2/ServiceProviderConfig").json()["patch"]["supported"] is True

    listed = client.get("/scim/v2/Users", headers=s).json()
    assert listed["totalResults"] == 1 and listed["Resources"][0]["userName"] == "ada@acme.example"
    new = {
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
        "userName": "Carl@Acme.example",
        "name": {"givenName": "Carl", "familyName": "Sagan"},
        "externalId": "okta-123",
        "active": True,
        EXT: {"role": "analyst"},
    }
    r = client.post("/scim/v2/Users", json=new, headers={**s, "Content-Type": "application/scim+json"})
    assert r.status_code == 201, r.text
    user = r.json()
    assert user["userName"] == "carl@acme.example" and user["name"]["formatted"] == "Carl Sagan" and user[EXT]["role"] == "analyst"
    assert r.headers["content-type"].startswith("application/scim+json")
    assert client.post("/scim/v2/Users", json=new, headers=s).json()["scimType"] == "uniqueness"
    assert client.post("/scim/v2/Users", json={"userName": "nope"}, headers=s).status_code == 400
    # provisioned users have no password
    assert login(client, "carl@acme.example", PASSWORD).status_code == 401
    found = client.get('/scim/v2/Users?filter=externalId eq "okta-123"', headers=s).json()
    assert found["totalResults"] == 1 and found["Resources"][0]["id"] == user["id"]
    assert client.get('/scim/v2/Users?filter=userName eq "CARL@acme.example"', headers=s).json()["totalResults"] == 1
    assert client.get('/scim/v2/Users?filter=title co "x"', headers=s).status_code == 400

    patch = {
        "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        "Operations": [
            {"op": "replace", "path": f"{EXT}:role", "value": "data_scientist"},
            {"op": "Replace", "value": {"active": "False"}},
        ],
    }
    patched = client.patch(f"/scim/v2/Users/{user['id']}", json=patch, headers=s).json()
    assert patched["active"] is False and patched[EXT]["role"] == "data_scientist"
    users = {u["email"]: u for u in client.get("/v1/tenant/users", headers=h).json()}
    assert users["carl@acme.example"]["disabled"] and users["carl@acme.example"]["role"] == "data_scientist"
    bad = {"Operations": [{"op": "replace", "path": f"{EXT}:role", "value": "overlord"}]}
    assert client.patch(f"/scim/v2/Users/{user['id']}", json=bad, headers=s).status_code == 400
    assert (
        client.patch(f"/scim/v2/Users/{user['id']}", json={"Operations": [{"op": "remove", "path": "active"}]}, headers=s).status_code
        == 400
    )

    # the last active admin can't be deprovisioned
    ada = listed["Resources"][0]["id"]
    assert client.delete(f"/scim/v2/Users/{ada}", headers=s).json()["scimType"] == "mutability"
    assert client.delete(f"/scim/v2/Users/{user['id']}", headers=s).status_code == 204

    # tenant isolation: globex's token can't see acme users
    g = admin_headers(client, "globex", "gia@globex.example")
    gtok = client.post("/v1/tenant/scim-token", headers=g).json()["token"]
    assert client.get(f"/scim/v2/Users/{user['id']}", headers={"Authorization": f"Bearer {gtok}"}).status_code == 404
    assert client.get("/scim/v2/Users", headers={"Authorization": f"Bearer {gtok}"}).json()["totalResults"] == 1
    # rotating / revoking the token
    assert client.delete("/v1/tenant/scim-token", headers=h).status_code == 204
    assert client.get("/scim/v2/Users", headers=s).status_code == 401
    assert state.audit.entries("acme", "scim.user.create") and state.audit.entries("acme", "scim.user.deprovision")
