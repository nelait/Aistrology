from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.api.deps import build_state
from app.db.models import Tenant
from app.llm.base import LLMRequest, Message
from app.llm.config import ProviderConfig, ProviderKind, TenantLLMConfig
from app.llm.router import LLMUnavailableError
from app.main import create_app
from app.quotas import platform_tokens_this_month

from .conftest import CUSTOMER_ORDERS_SCHEMA

H = {"X-Tenant-ID": "acme", "X-User-ID": "u"}


@pytest.fixture
def state(tmp_path):
    return build_state(data_dir=tmp_path, dev_auth=True, cloud_provider="local", database_url=None, inline_worker=False)


def _set_quotas(state, **quotas):
    state.ensure_tenant("acme")
    with state.db.session("acme") as s:
        s.get(Tenant, "acme").quotas = quotas


def req() -> LLMRequest:
    return LLMRequest(messages=[Message(role="user", content="x" * 400)], task="analytics.suggest")


def test_platform_llm_is_metered_and_capped_with_byok_fallback(state):
    import asyncio

    _set_quotas(state, llm_tokens_per_month=150)
    router = state.router("acme")
    assert router.providers[0].name == "platform:mock"
    asyncio.run(router.complete(req()))
    assert platform_tokens_this_month(state, "acme") > 100
    asyncio.run(router.complete(req().model_copy(update={"system": "different"})))  # still under the cap before this call
    with pytest.raises(LLMUnavailableError, match="allowance"):
        asyncio.run(state.router("acme").complete(req().model_copy(update={"system": "third"})))
    # With a BYOK provider after the platform one, requests fall through to it once the allowance is used up.
    state.set_llm_config(
        "acme",
        TenantLLMConfig(chain=[ProviderConfig(kind=ProviderKind.PLATFORM), ProviderConfig(kind=ProviderKind.MOCK, model="byok-model")]),
    )
    response = asyncio.run(state.router("acme").complete(req().model_copy(update={"system": "fourth"})))
    assert response.model == "byok-model"


def test_task_specific_model(state):
    state.ensure_tenant("acme")
    state.set_llm_config(
        "acme", TenantLLMConfig(chain=[ProviderConfig(kind=ProviderKind.MOCK)], task_models={"analytics.suggest": "fast-model"})
    )
    assert state.router("acme", "analytics.suggest").providers[0].model == "fast-model"
    assert state.router("acme", "schema.from_text").providers[0].model == "mock-1"


def test_concurrent_job_quota(state):
    _set_quotas(state, max_concurrent_jobs=1)
    client = TestClient(create_app(state))
    state.settings = state.settings.__class__(**{**state.settings.__dict__, "sync_generation_row_limit": 1})
    schema = client.post(
        "/v1/schemas/parse", json={"format": "json_schema", "content": json.dumps(CUSTOMER_ORDERS_SCHEMA)}, headers=H
    ).json()["schema"]
    body = {"schema": schema, "options": {"count": 10}, "save_as": "g"}
    assert client.post("/v1/generate", json=body, headers=H).status_code == 202
    r = client.post("/v1/generate", json=body, headers=H)
    assert r.status_code == 429 and r.json()["detail"]["quota"] == "max_concurrent_jobs"
