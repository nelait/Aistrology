from __future__ import annotations

import json
import time
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.api.deps import build_state
from app.auth.oidc import OIDCClient, OIDCError, OIDCProviderConfig
from app.main import create_app

ISSUER = "https://idp.example"
CLIENT_ID = "client-123"
REDIRECT = "http://localhost:3000/auth/callback"
PASSWORD = "Correct-Horse-9-Battery"


class FakeIdP:
    def __init__(self):
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.claims: dict = {}
        self.pending_nonce = None
        jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key()))
        self.jwks = {"keys": [{**jwk, "kid": "k1", "alg": "RS256", "use": "sig"}]}

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/.well-known/openid-configuration":
            return httpx.Response(
                200,
                json={
                    "issuer": ISSUER,
                    "authorization_endpoint": f"{ISSUER}/authorize",
                    "token_endpoint": f"{ISSUER}/token",
                    "jwks_uri": f"{ISSUER}/jwks",
                },
            )
        if path == "/jwks":
            return httpx.Response(200, json=self.jwks)
        if path == "/token":
            form = parse_qs(request.content.decode())
            assert form["code_verifier"][0] and form["client_secret"][0] == "shh"
            now = int(time.time())
            claims = {
                "iss": ISSUER,
                "aud": CLIENT_ID,
                "sub": "idp-user-1",
                "iat": now,
                "exp": now + 300,
                "nonce": self.pending_nonce,
                **self.claims,
            }
            token = jwt.encode(claims, self.key, algorithm="RS256", headers={"kid": "k1"})
            return httpx.Response(200, json={"id_token": token, "access_token": "x"})
        return httpx.Response(404)


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("AP_OIDC_REDIRECT_URIS", REDIRECT)
    state = build_state(data_dir=tmp_path, dev_auth=False, cloud_provider="local", database_url=None, inline_worker=False)
    idp = FakeIdP()
    cfg = OIDCProviderConfig("acmeidp", ISSUER, CLIENT_ID, "shh")
    state.extras["oidc"] = {
        "acmeidp": OIDCClient(cfg, state.auth.signing_key(), http=httpx.Client(transport=httpx.MockTransport(idp.handler)))
    }
    return state, TestClient(create_app(state)), idp


def _login(client, idp, email, **extra):
    r = client.get("/v1/auth/oidc/acmeidp/authorize", params={"redirect_uri": REDIRECT})
    assert r.status_code == 200, r.text
    q = parse_qs(urlparse(r.json()["authorization_url"]).query)
    assert q["code_challenge_method"] == ["S256"] and q["client_id"] == [CLIENT_ID]
    idp.pending_nonce = q["nonce"][0]
    idp.claims = {"email": email, "email_verified": True, **extra}
    return client.post("/v1/auth/oidc/acmeidp/callback", json={"code": "abc", "state": q["state"][0]})


def test_sso_login_existing_user_and_jit_provisioning(setup):
    state, client, idp = setup
    client.post("/v1/auth/signup", json={"tenant_id": "acme", "org_name": "Acme", "email": "ada@acme.example", "password": PASSWORD})
    assert client.get("/v1/auth/oidc/providers").json() == {"providers": ["acmeidp"]}
    r = _login(client, idp, "Ada@Acme.example")
    assert r.status_code == 200, r.text
    me = client.get("/v1/auth/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"}).json()
    assert me["email"] == "ada@acme.example" and me["role"] == "admin"

    # unknown user → rejected until the admin claims the domain
    r = _login(client, idp, "bob@acme.example")
    assert r.status_code == 401 and r.json()["detail"]["code"] == "sso_no_account"
    admin = {"Authorization": f"Bearer {_login(client, idp, 'ada@acme.example').json()['access_token']}"}
    assert client.put("/v1/tenant/sso", json={"domains": ["acme.example"], "default_role": "analyst"}, headers=admin).status_code == 200
    r = _login(client, idp, "bob@acme.example")
    assert r.status_code == 200
    bob = client.get("/v1/auth/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"}).json()
    assert bob["role"] == "analyst" and bob["tenant_id"] == "acme"
    # SSO-only accounts can't log in with a password
    assert client.post("/v1/auth/login", json={"email": "bob@acme.example", "password": "anything-123-ABC"}).status_code == 401
    # another org can't claim the same domain
    client.post("/v1/auth/signup", json={"tenant_id": "globex", "org_name": "G", "email": "gil@globex.example", "password": PASSWORD})
    g = {
        "Authorization": f"Bearer {client.post('/v1/auth/login', json={'email': 'gil@globex.example', 'password': PASSWORD}).json()['access_token']}"
    }
    assert client.put("/v1/tenant/sso", json={"domains": ["acme.example"]}, headers=g).status_code == 409


def test_sso_rejects_bad_tokens(setup):
    state, client, idp = setup
    client.post("/v1/auth/signup", json={"tenant_id": "acme", "org_name": "Acme", "email": "ada@acme.example", "password": PASSWORD})
    assert _login(client, idp, "ada@acme.example", email_verified=False).status_code == 401
    assert _login(client, idp, "ada@acme.example", aud="someone-else").status_code == 401
    assert _login(client, idp, "ada@acme.example", iss="https://evil.example").status_code == 401
    # nonce replay: a token minted for another login attempt
    r = client.get("/v1/auth/oidc/acmeidp/authorize", params={"redirect_uri": REDIRECT})
    q = parse_qs(urlparse(r.json()["authorization_url"]).query)
    idp.pending_nonce, idp.claims = "stale-nonce", {"email": "ada@acme.example"}
    assert client.post("/v1/auth/oidc/acmeidp/callback", json={"code": "abc", "state": q["state"][0]}).status_code == 401
    # tampered state
    assert client.post("/v1/auth/oidc/acmeidp/callback", json={"code": "abc", "state": "x.y.z"}).status_code == 401
    # redirect URI allowlist
    assert client.get("/v1/auth/oidc/acmeidp/authorize", params={"redirect_uri": "https://evil.example/cb"}).status_code == 400
    assert client.get("/v1/auth/oidc/nope/authorize", params={"redirect_uri": REDIRECT}).status_code == 404


def test_hs256_id_token_rejected(setup):
    """An attacker can't sign an id_token with the (public) client id or a guessed secret."""
    state, _, idp = setup
    client = state.extras["oidc"]["acmeidp"]
    url, st = client.authorization_url(REDIRECT)
    forged = jwt.encode({"iss": ISSUER, "aud": CLIENT_ID, "sub": "x", "email": "ada@acme.example"}, "guess", algorithm="HS256")

    def handler(request):
        if request.url.path == "/token":
            return httpx.Response(200, json={"id_token": forged})
        return idp.handler(request)

    client.http = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(OIDCError, match="algorithm"):
        client.exchange("code", st)
