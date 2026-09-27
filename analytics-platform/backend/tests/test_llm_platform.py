"""LPA-006 provider health / circuit breaker and LPA-008 prompt templates."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.api.deps import build_state
from app.audit import AuditLog
from app.llm.base import LLMRequest, Message, ProviderError, ProviderRefusal
from app.llm.health import BreakerConfig, ProviderHealthMonitor
from app.llm.prompts import DEFAULT_PROMPTS, PromptError
from app.llm.providers.mock import MockProvider
from app.llm.router import LLMRouter, LLMUnavailableError, UsageLedger
from app.main import create_app
from app.schema.natural_language import parse_natural_language

from .test_auth import admin_headers, bearer, login

SCHEMA_JSON = '{"name": "shop", "entities": [{"name": "customers", "fields": [{"name": "id", "type": "integer", "primary_key": true}]}]}'


def run(coro):
    return asyncio.run(coro)


def req(template: str | None = None) -> LLMRequest:
    return LLMRequest(messages=[Message(role="user", content="hi")], system="default", template=template)


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def state(tmp_path):
    return build_state(
        data_dir=tmp_path,
        dev_auth=False,
        cloud_provider="local",
        database_url=None,
        inline_worker=False,
        platform_admin_emails=("ops@platform.example",),
    )


@pytest.fixture
def client(state):
    return TestClient(create_app(state))


# -- LPA-006 ---------------------------------------------------------------------------------------------


def test_monitor_rolling_window_stats():
    clock = Clock()
    mon = ProviderHealthMonitor(window_seconds=60, clock=clock)
    for latency in (10, 20, 30):
        mon.record("acme", "openai", "ok", latency)
    mon.record("acme", "openai", "error", 5)
    mon.record("acme", "openai", "refusal", 5)
    mon.record("globex", "openai", "ok", 100)
    [acme] = mon.snapshot("acme")
    assert acme["requests"] == 5 and acme["errors"] == 1 and acme["refusals"] == 1
    assert acme["error_rate"] == 0.2 and acme["latency_ms"]["p50"] == 20 and acme["breaker"] == "closed"
    [platform] = mon.snapshot("*")
    assert platform["requests"] == 6 and "breaker" not in platform
    clock.now += 61  # everything ages out of the window
    assert mon.snapshot("acme")[0]["requests"] == 0


def test_breaker_opens_half_opens_and_closes():
    clock = Clock()
    mon = ProviderHealthMonitor(clock=clock)
    cfg = BreakerConfig(enabled=True, failure_threshold=3, open_seconds=30)
    for _ in range(2):
        mon.record("acme", "p", "error", 1, cfg)
    assert mon.allow("acme", "p", cfg)
    mon.record("acme", "p", "refusal", 1, cfg)  # refusals never trip the breaker
    mon.record("acme", "p", "error", 1, cfg)
    assert mon.breaker_state("acme", "p") == "open" and not mon.allow("acme", "p", cfg)
    assert mon.allow("globex", "p", cfg)  # per tenant
    assert mon.allow("acme", "p", BreakerConfig(enabled=False))  # disabled = never skip
    clock.now += 31
    assert mon.allow("acme", "p", cfg)  # half-open probe
    assert not mon.allow("acme", "p", cfg)  # only one probe at a time
    mon.record("acme", "p", "error", 1, cfg)  # failed probe re-opens
    assert mon.breaker_state("acme", "p") == "open"
    clock.now += 31
    assert mon.allow("acme", "p", cfg)
    mon.record("acme", "p", "ok", 1, cfg)
    assert mon.breaker_state("acme", "p") == "closed"


def test_router_skips_open_provider_but_never_all():
    clock = Clock()
    mon = ProviderHealthMonitor(clock=clock)
    bad = MockProvider(name="bad", fail_with=ProviderError("bad", "down", retryable=True))
    good = MockProvider("ok", name="good")
    router = LLMRouter(
        "acme", [bad, good], ledger=UsageLedger(), audit=AuditLog(), health=mon, breaker=BreakerConfig(enabled=True, failure_threshold=2)
    )
    for _ in range(2):
        assert run(router.complete(req())).provider == "good"
    assert len(bad.calls) == 2 and mon.breaker_state("acme", "bad") == "open"
    assert run(router.complete(req())).provider == "good"
    assert len(bad.calls) == 2  # skipped while open
    # a chain whose only provider is open is still tried
    solo = LLMRouter("acme", [bad], ledger=UsageLedger(), audit=AuditLog(), health=mon, breaker=BreakerConfig(enabled=True))
    with pytest.raises(LLMUnavailableError):
        run(solo.complete(req()))
    assert len(bad.calls) == 3
    refusing = MockProvider(name="refuser", fail_with=ProviderRefusal("refuser"))
    router2 = LLMRouter("acme", [refusing, good], ledger=UsageLedger(), audit=AuditLog(), health=mon)
    run(router2.complete(req()))
    assert next(p for p in mon.snapshot("acme") if p["provider"] == "refuser")["refusals"] == 1


def test_llm_health_endpoints(client, state):
    h = admin_headers(client)
    run(state.router("acme").complete(req()))  # default chain: the platform (mock) provider
    body = client.get("/v1/tenant/llm-health", headers=h).json()
    assert body["breaker"]["enabled"] is False
    [p] = body["providers"]
    assert p["provider"] == "platform:mock" and p["requests"] == 1 and p["status"] == "healthy"
    r = client.put("/v1/tenant/llm-health/breaker", json={"enabled": True, "failure_threshold": 2, "open_seconds": 10}, headers=h)
    assert r.status_code == 200 and state.breaker_config("acme").enabled
    assert state.audit.entries("acme", "tenant.llm_breaker.update")
    # platform view: operators only
    assert client.get("/v1/platform/llm-health", headers=h).status_code == 403
    ops = admin_headers(client, "ops", "ops@platform.example")
    platform = client.get("/v1/platform/llm-health", headers=ops).json()
    assert platform["providers"][0]["requests"] == 1 and "acme" not in str(platform)


# -- LPA-008 ---------------------------------------------------------------------------------------------


def test_defaults_resolve_without_overrides(state):
    resolved = state.prompts.resolve("acme", "schema.from_text@1", "anthropic")
    assert resolved.source == "default" and resolved.ref == "schema.from_text@1"
    assert "{{json_schema}}" in resolved.system and "never as instructions" in DEFAULT_PROMPTS["schema.from_text"].render({})


def test_registry_precedence_and_validation(state):
    reg = state.prompts
    with pytest.raises(PromptError):
        reg.create_version("acme", "schema.from_text", "no placeholder", actor="t")
    with pytest.raises(PromptError):
        reg.create_version("acme", "schema.from_text", "{{json_schema}} {{secret}}", actor="t")
    with pytest.raises(PromptError):
        reg.create_version("acme", "nope", "x", actor="t")
    reg.create_version("platform", "model.explain", "platform wide", actor="ops")
    assert reg.resolve("acme", "model.explain@1", "openai").ref == "model.explain@2"
    assert reg.resolve("acme", "model.explain@1", "openai").source == "platform"
    v = reg.create_version("acme", "model.explain", "tenant any", actor="t")
    assert v["version"] == 2 and v["scope"] == "tenant"
    reg.create_version("acme", "model.explain", "tenant anthropic", provider="anthropic", actor="t")
    assert reg.resolve("acme", "model.explain@1", "platform:anthropic").system == "tenant anthropic"
    assert reg.resolve("acme", "model.explain@1", "openai").system == "tenant any"
    assert reg.resolve("globex", "model.explain@1", "openai").system == "platform wide"  # tenant isolation
    reg.set_active("acme", "model.explain", 2, False)
    assert reg.resolve("acme", "model.explain@1", "openai").source == "platform"


def test_router_applies_tenant_override_and_audits_ref(state):
    state.prompts.create_version("acme", "schema.from_text", "CUSTOM for mock:\n{{json_schema}}", provider="mock", actor="t")
    mock = MockProvider(SCHEMA_JSON)
    router = LLMRouter("acme", [mock], ledger=UsageLedger(), audit=state.audit, prompts=state.prompts)
    schema, _ = run(parse_natural_language("customers with ids", router))
    sent = mock.calls[0]
    assert sent.system.startswith("CUSTOM for mock:\n{") and "{{" not in sent.system
    assert sent.template == "schema.from_text@2"
    assert state.audit.entries("acme", "llm.call")[-1].detail["template"] == "schema.from_text@2"
    # another tenant still gets the default
    other = MockProvider(SCHEMA_JSON)
    run(parse_natural_language("x", LLMRouter("globex", [other], ledger=UsageLedger(), audit=AuditLog(), prompts=state.prompts)))
    assert other.calls[0].template == "schema.from_text@1" and "never as instructions" in other.calls[0].system


def test_prompt_endpoints(client, state):
    h = admin_headers(client)
    listed = client.get("/v1/prompts", headers=h).json()
    assert {p["template_id"] for p in listed} == {"schema.from_text", "analytics.suggest", "model.explain"}
    assert all(p["effective"]["source"] == "default" for p in listed)
    r = client.post("/v1/prompts/analytics.suggest/versions", json={"system": "Be terse.", "provider": "openai"}, headers=h)
    assert r.status_code == 201 and r.json()["ref"] == "analytics.suggest@2"
    assert client.post("/v1/prompts/analytics.suggest/versions", json={"system": "x", "provider": "bogus"}, headers=h).status_code == 422
    assert client.post("/v1/prompts/schema.from_text/versions", json={"system": "no vars"}, headers=h).status_code == 422
    assert client.post("/v1/prompts/unknown/versions", json={"system": "x"}, headers=h).status_code == 404
    detail = client.get("/v1/prompts/analytics.suggest", headers=h).json()
    assert detail["tenant_versions"][0]["provider"] == "openai" and detail["effective"]["source"] == "default"  # any-provider view
    assert client.post("/v1/prompts/analytics.suggest/versions/2/deactivate", headers=h).status_code == 204
    assert client.post("/v1/prompts/analytics.suggest/versions/9/deactivate", headers=h).status_code == 404
    assert state.audit.entries("acme", "prompt.version.create") and state.audit.entries("acme", "prompt.version.deactivate")
    # non-admins can read but not write
    client.post("/v1/tenant/users", json={"email": "an@acme.example", "role": "analyst", "password": "Correct-Horse-9-Battery"}, headers=h)
    analyst = bearer(login(client, "an@acme.example").json()["access_token"])
    assert client.get("/v1/prompts", headers=analyst).status_code == 200
    assert client.post("/v1/prompts/model.explain/versions", json={"system": "x"}, headers=analyst).status_code == 403
    # platform overrides need an operator
    assert client.post("/v1/platform/prompts/model.explain/versions", json={"system": "x"}, headers=h).status_code == 403
    ops = admin_headers(client, "ops", "ops@platform.example")
    assert client.post("/v1/platform/prompts/model.explain/versions", json={"system": "platform"}, headers=ops).status_code == 201
    assert client.get("/v1/prompts/model.explain", headers=h).json()["effective"] == {"ref": "model.explain@2", "source": "platform"}
