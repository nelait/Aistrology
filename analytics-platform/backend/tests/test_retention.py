"""Retention policies (SOC-PRV-002, Appendix B) and the audit chain staying verifiable through them."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.deps import build_state
from app.audit import AuditLog
from app.db.models import AuditRecord, PredictionLog, UsageCounter
from app.main import create_app
from app.retention import apply_retention, sweep

H = {"X-Tenant-ID": "acme", "X-User-ID": "admin"}


@pytest.fixture
def state(tmp_path):
    return build_state(data_dir=tmp_path, dev_auth=True, cloud_provider="local", database_url=None, inline_worker=False)


@pytest.fixture
def client(state):
    c = TestClient(create_app(state))
    c.get("/v1/tenant/retention", headers=H)  # provisions the dev tenant
    return c


class Clock:
    """Controls the timestamps the audit log writes (they are part of the hash, so they can't be edited later)."""

    offset = timedelta(0)

    @classmethod
    def now(cls, tz=None):
        return datetime.now(tz) + cls.offset


@pytest.fixture
def clock(monkeypatch):
    import app.audit

    Clock.offset = timedelta(0)
    monkeypatch.setattr(app.audit, "datetime", Clock)
    return Clock


def test_policy_defaults_and_validation(client):
    r = client.get("/v1/tenant/retention", headers=H)
    assert r.status_code == 200
    assert r.json() == {"llm_bodies_days": 30, "llm_metadata_days": 395, "audit_days": 395, "inference_logs_days": 30}
    assert client.put("/v1/tenant/retention", json={"audit_days": 30}, headers=H).status_code == 422  # below a year
    r = client.put("/v1/tenant/retention", json={"llm_bodies_days": 7, "audit_days": 400}, headers=H)
    assert r.status_code == 200 and r.json()["llm_bodies_days"] == 7
    assert client.get("/v1/tenant/retention", headers=H).json()["audit_days"] == 400
    viewer = client.post("/v1/tenant/api-keys", json={"name": "v", "role": "viewer"}, headers=H).json()["key"]
    assert client.get("/v1/tenant/retention", headers={"X-API-Key": viewer}).status_code == 403


def test_llm_bodies_are_redacted_and_chain_still_verifies(client, state, clock):
    clock.offset = -timedelta(days=45)
    state.audit.record("acme", "u1", "llm.call", task="t", prompt_excerpt="customer jane@example.com spent 10", error=None)
    clock.offset = timedelta(0)
    state.audit.record("acme", "u1", "llm.call", task="t", prompt_excerpt="recent prompt")
    state.audit.record("acme", "u1", "dataset.upload", dataset_id="ds_x")
    entries = state.audit.entries("acme", action="llm.call")
    assert entries[0].detail["_redactable"] == ["prompt_excerpt"]
    assert state.audit.verify("acme")

    result = client.post("/v1/tenant/retention/apply", headers=H).json()
    assert result["llm_bodies_redacted"] == 1
    old, recent = state.audit.entries("acme", action="llm.call")
    assert old.detail["prompt_excerpt"]["redacted"] is True and "jane" not in str(old.detail)
    assert recent.detail["prompt_excerpt"] == "recent prompt"
    assert state.audit.verify("acme")
    assert apply_retention(state, "acme")["llm_bodies_redacted"] == 0  # idempotent

    # tampering with a redacted field is still detected
    with state.db.session("acme") as s:
        row = s.scalars(select(AuditRecord).where(AuditRecord.tenant_id == "acme", AuditRecord.seq == old.seq)).one()
        row.detail = {**row.detail, "prompt_excerpt": {"redacted": True, "sha256": "0" * 64}}
    assert not state.audit.verify("acme")


def test_audit_prefix_expires_with_anchor(client, state, clock):
    clock.offset = -timedelta(days=500)
    for i in range(4):
        state.audit.record("acme", "u1", "thing.happened", i=i)
    clock.offset = timedelta(0)
    for i in range(2):
        state.audit.record("acme", "u1", "thing.happened", i=i)
    cut = state.audit.entries("acme")[-2].seq
    result = apply_retention(state, "acme")
    assert result["audit_entries_deleted"] == cut
    remaining = state.audit.entries("acme")
    assert remaining[0].seq == cut and remaining[-1].action == "retention.applied"
    assert client.get("/v1/tenant/audit/verify", headers=H).json() == {"valid": True}

    # deleting an entry in the middle (not via retention) still breaks the chain
    with state.db.session("acme") as s:
        s.execute(AuditRecord.__table__.delete().where(AuditRecord.tenant_id == "acme", AuditRecord.seq == cut + 1))
    assert not state.audit.verify("acme")


def test_usage_and_prediction_logs_expire(client, state):
    old_day = (datetime.now(UTC) - timedelta(days=400)).strftime("%Y-%m-%d")
    today = datetime.now(UTC).strftime("%Y-%m-%d")
    with state.db.session("acme") as s:
        s.add(UsageCounter(tenant_id="acme", metric="llm.tokens.input", key="m", day=old_day, value=5))
        s.add(UsageCounter(tenant_id="acme", metric="llm.tokens.input", key="m", day=today, value=5))
        s.add(
            PredictionLog(
                tenant_id="acme",
                endpoint_id="ep",
                model_version_id="mv",
                latency_ms=1,
                status=200,
                at=datetime.now(UTC) - timedelta(days=31),
            )
        )
        s.add(PredictionLog(tenant_id="acme", endpoint_id="ep", model_version_id="mv", latency_ms=1, status=200))
    results = sweep(state)
    assert results["acme"]["usage_rows_deleted"] == 1 and results["acme"]["prediction_logs_deleted"] == 1
    with state.db.session("acme") as s:
        assert s.scalars(select(UsageCounter.day)).all() == [today]
        assert len(s.scalars(select(PredictionLog.id)).all()) == 1


def test_in_memory_log_commits_redactable_fields():
    log = AuditLog()
    log.record("acme", "u", "llm.call", prompt_excerpt="secret")
    from app.audit import redacted

    log._entries[0].detail["prompt_excerpt"] = redacted("secret")
    assert log.verify()
