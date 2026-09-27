"""SHR-001a public links, SEC-003 / SOC-PRV-005 consent, OBS-004 cost attribution."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.api.deps import build_state
from app.auth.service import Principal
from app.dashboards.service import Forbidden
from app.db.models import PublicLink
from app.llm.base import LLMRequest, Message
from app.main import create_app
from app.public_links import PublicLinkService

from .test_auth import CSV, PASSWORD, admin_headers, bearer, login

H = {"X-Tenant-ID": "acme", "X-User-ID": "owner"}


def dev_state(tmp_path):
    return build_state(data_dir=tmp_path, dev_auth=True, cloud_provider="local", database_url=None, inline_worker=False)


@pytest.fixture
def state(tmp_path):
    return build_state(data_dir=tmp_path, dev_auth=False, cloud_provider="local", database_url=None, inline_worker=False)


@pytest.fixture
def client(state):
    return TestClient(create_app(state))


# -- SHR-001a --------------------------------------------------------------------------------------------


def test_public_links(tmp_path):
    state = dev_state(tmp_path)
    c = TestClient(create_app(state))
    ds = c.post("/v1/datasets", files={"file": ("d.csv", CSV.encode())}, headers=H).json()["dataset"]["id"]
    spec = {
        "pages": [
            {
                "id": "p1",
                "title": "Overview",
                "widgets": [
                    {
                        "id": "bar",
                        "type": "chart",
                        "config": {"dataset_id": ds, "chart": {"type": "bar", "x": "region", "y": "amount", "aggregation": "sum"}},
                    }
                ],
            }
        ]
    }
    d = c.post("/v1/dashboards", json={"name": "Sales", "spec": spec}, headers=H).json()
    c.post(f"/v1/dashboards/{d['id']}/share", json={"user_id": "friend", "role": "viewer"}, headers=H)
    r = c.post(f"/v1/dashboards/{d['id']}/public-links", json={"ttl_hours": 24}, headers=H)
    assert r.status_code == 201, r.text
    link = r.json()
    token = link["token"]
    assert link["status"] == "active" and link["path"] == f"/v1/public/{token}"
    assert "token" not in c.get(f"/v1/dashboards/{d['id']}/public-links", headers=H).json()[0]
    with state.db.session("acme") as s:
        assert s.get(PublicLink, link["id"]).token_hash != token  # only the hash is stored

    public = c.get(f"/v1/public/{token}")  # no credentials
    assert public.status_code == 200 and public.json()["name"] == "Sales"
    assert public.json()["shares"] == {} and public.json()["owner_id"] == ""
    data = c.post(f"/v1/public/{token}/widgets/bar/data", json={})
    assert data.status_code == 200 and sorted(r[0] for r in data.json()["rows"]) == ["e", "w"]
    assert c.post(f"/v1/public/{token}/widgets/nope/data", json={}).status_code == 404
    assert c.get("/v1/public/apl_invalid").status_code == 404

    # a viewer without edit rights can't mint links
    viewer = Principal(tenant_id="acme", user_id="friend", role="analyst", method="jwt")
    with pytest.raises(Forbidden):
        PublicLinkService(state).create(viewer, d["id"], 1)

    # revocation
    assert c.delete(f"/v1/dashboards/{d['id']}/public-links/{link['id']}", headers=H).status_code == 204
    assert c.get(f"/v1/public/{token}").status_code == 404
    assert c.get(f"/v1/dashboards/{d['id']}/public-links", headers=H).json()[0]["status"] == "revoked"

    # expiry
    second = c.post(f"/v1/dashboards/{d['id']}/public-links", headers=H).json()
    assert c.get(f"/v1/public/{second['token']}").status_code == 200
    with state.db.session("acme") as s:
        s.get(PublicLink, second["id"]).expires_at = datetime.now(UTC) - timedelta(minutes=1)
    assert c.get(f"/v1/public/{second['token']}").status_code == 404

    # the tenant switch disables creation and every existing link
    third = c.post(f"/v1/dashboards/{d['id']}/public-links", headers=H).json()
    assert c.put("/v1/tenant/sharing", json={"public_links_enabled": False}, headers=H).status_code == 200
    assert c.get(f"/v1/public/{third['token']}").status_code == 404
    assert c.post(f"/v1/dashboards/{d['id']}/public-links", headers=H).status_code == 403
    c.put("/v1/tenant/sharing", json={"public_links_enabled": True}, headers=H)
    assert c.get(f"/v1/public/{third['token']}").status_code == 200
    # archived dashboards aren't served; deleting a dashboard with links works
    c.post(f"/v1/dashboards/{d['id']}/archive", headers=H)
    assert c.get(f"/v1/public/{third['token']}").status_code == 404
    c.post(f"/v1/dashboards/{d['id']}/archive?archived=false", headers=H)
    assert c.get(f"/v1/public/{third['token']}").status_code == 200
    assert c.delete(f"/v1/dashboards/{d['id']}", headers=H).status_code == 204
    assert c.get(f"/v1/public/{third['token']}").status_code == 404
    # other tenants can't manage acme's links
    assert c.get(f"/v1/dashboards/{d['id']}/public-links", headers={"X-Tenant-ID": "globex"}).status_code == 404
    assert state.audit.entries("acme", "dashboard.public_link.create") and state.audit.entries("acme", "tenant.sharing.update")


# -- SEC-003 / SOC-PRV-005 -----------------------------------------------------------------------------------


def llm_call(state):
    request = LLMRequest(messages=[Message(role="user", content="hi")])
    return asyncio.run(state.router("acme").complete(request))


def test_consent_records_and_llm_gate(client, state):
    h = admin_headers(client)
    client.post("/v1/tenant/users", json={"email": "an@acme.example", "role": "analyst", "password": PASSWORD}, headers=h)
    an = bearer(login(client, "an@acme.example").json()["access_token"])
    assert llm_call(state).provider == "platform:mock"  # off by default

    r = client.put("/v1/tenant/consent-settings", json={"llm_requires_consent": True, "llm_addendum_version": "2026-09"}, headers=h)
    assert r.status_code == 200 and r.json()["llm_consent_given"] is False
    with pytest.raises(HTTPException) as exc:
        llm_call(state)
    assert exc.value.status_code == 409 and exc.value.detail["code"] == "llm_consent_required"
    # through the API: every LLM feature is refused with a clear message
    parse = client.post("/v1/schemas/parse", json={"format": "natural_language", "content": "customers"}, headers=h)
    assert parse.status_code == 409 and "addendum" in parse.json()["detail"]["message"]

    # an analyst's consent doesn't count; nor does an admin's consent to an old version
    assert client.post("/v1/consents", json={"policy": "llm_processing", "version": "2026-09"}, headers=an).status_code == 201
    assert client.post("/v1/consents", json={"policy": "llm_processing", "version": "2025-01"}, headers=h).status_code == 201
    with pytest.raises(HTTPException):
        llm_call(state)
    given = client.post("/v1/consents", json={"policy": "llm_processing", "version": "2026-09"}, headers=h)
    assert given.status_code == 201 and given.json()["role"] == "admin"
    assert llm_call(state).text is not None
    assert client.get("/v1/tenant/consent-settings", headers=h).json()["llm_consent_given"] is True

    client.post("/v1/consents", json={"policy": "terms", "version": "3"}, headers=h)
    mine = client.get("/v1/consents", headers=h).json()
    assert {c["policy"] for c in mine} == {"llm_processing", "terms"} and all(c["accepted_at"] for c in mine)
    assert len(client.get("/v1/tenant/consents?policy=llm_processing", headers=h).json()) == 3
    assert client.get("/v1/tenant/consents", headers=an).status_code == 403
    assert client.post("/v1/consents", json={"policy": "marketing", "version": "1"}, headers=h).status_code == 422

    # withdrawal is recorded and re-closes the gate
    assert client.delete("/v1/consents/llm_processing", headers=h).status_code == 204
    history = [c for c in client.get("/v1/consents", headers=h).json() if c["policy"] == "llm_processing"]
    assert len(history) == 2 and all(c["withdrawn_at"] for c in history)  # kept, marked withdrawn
    with pytest.raises(HTTPException):
        llm_call(state)
    assert client.delete("/v1/consents/llm_processing", headers=h).status_code == 404
    # API keys can't give consent on a person's behalf
    key = client.post("/v1/tenant/api-keys", json={"name": "k", "role": "admin"}, headers=h).json()["key"]
    assert client.post("/v1/consents", json={"policy": "terms", "version": "1"}, headers={"X-API-Key": key}).status_code == 400
    assert state.audit.entries("acme", "consent.give") and state.audit.entries("acme", "consent.withdraw")


# -- OBS-004 ----------------------------------------------------------------------------------------------------


def test_cost_attribution(client, state):
    h = admin_headers(client)
    client.post("/v1/datasets", files={"file": ("d.csv", CSV.encode())}, headers=h)
    m = state.metering
    m.add("acme", "llm.cost_usd", "anthropic/claude-opus-5", 1.25, day="2026-03-10")
    m.add("acme", "llm.cost_usd", "openai/gpt-4o", 0.75, day="2026-03-11")
    m.add("acme", "llm.tokens.input", "openai/gpt-4o", 1000, day="2026-03-11")
    m.add("acme", "compute.seconds", "training.run", 100, day="2026-03-12")
    m.add("acme", "api.requests", "churn", 2000, day="2026-03-12")
    m.add("acme", "llm.cost_usd", "openai/gpt-4o", 99, day="2026-04-01")  # outside the range
    m.add("globex", "llm.cost_usd", "openai/gpt-4o", 50, day="2026-03-10")  # another tenant
    r = client.get("/v1/tenant/costs?start=2026-03-01&end=2026-03-30", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["llm"]["cost_usd"] == 2.0 and body["llm"]["input_tokens"] == 1000
    assert body["compute"]["seconds"] == 100 and body["compute"]["cost_usd"] == pytest.approx(100 * 0.0001)
    assert body["api"]["requests"] == 2000 and body["api"]["cost_usd"] == pytest.approx(0.02)
    assert body["storage"]["bytes"] > 0 and body["storage"]["cost_usd"] > 0
    expected = body["llm"]["cost_usd"] + body["compute"]["cost_usd"] + body["api"]["cost_usd"] + body["storage"]["cost_usd"]
    assert body["total_cost_usd"] == pytest.approx(expected, abs=1e-5)
    assert client.get("/v1/tenant/costs?start=2026-03-10&end=2026-03-01", headers=h).status_code == 422
    assert client.get("/v1/tenant/costs?start=March", headers=h).status_code == 422
    assert client.get("/v1/tenant/costs", headers=h).status_code == 200  # default: month to date
