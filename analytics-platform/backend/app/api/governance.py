"""Consent management (SEC-003, SOC-PRV-005) and per-tenant cost attribution (OBS-004)."""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, date, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..auth.rbac import Permission
from ..auth.service import Principal
from ..config import GB
from ..consent import SETTING_KEY, ConsentSettings, Policy, consent_settings, has_admin_llm_consent, record_consent, withdraw_consent
from ..db.models import Consent, UsageCounter
from .deps import AppState, PrincipalDep, StateDep, require

router = APIRouter(prefix="/v1", tags=["governance"])
Admin = require(Permission.MANAGE_TENANT)


class ConsentCreate(BaseModel):
    policy: Policy
    version: str = Field(min_length=1, max_length=32)


def _consent_out(c: Consent) -> dict[str, Any]:
    return {
        "id": c.id,
        "user_id": c.user_id,
        "role": c.role,
        "policy": c.policy,
        "version": c.version,
        "accepted_at": c.accepted_at,
        "withdrawn_at": c.withdrawn_at,
    }


def _human(principal: Principal) -> None:
    if principal.method not in ("jwt", "dev"):
        raise HTTPException(status_code=400, detail="consent can only be given by a signed-in user")


@router.post("/consents", status_code=201)
async def give_consent(
    body: ConsentCreate, request: Request, state: AppState = StateDep, principal: Principal = PrincipalDep
) -> dict[str, Any]:
    """Record the caller's consent to a policy version (with timestamp and IP)."""
    _human(principal)
    ip = request.client.host if request.client else None
    row = record_consent(state, principal.tenant_id, principal.user_id, principal.role, body.policy, body.version, ip)
    state.audit.record(principal.tenant_id, principal.user_id, "consent.give", policy=body.policy.value, version=body.version)
    return _consent_out(row)


@router.get("/consents")
async def my_consents(state: AppState = StateDep, principal: Principal = PrincipalDep) -> list[dict[str, Any]]:
    _human(principal)
    with state.db.session(principal.tenant_id) as s:
        rows = s.execute(
            select(Consent)
            .where(Consent.tenant_id == principal.tenant_id, Consent.user_id == principal.user_id)
            .order_by(Consent.accepted_at.desc())
        ).scalars()
        return [_consent_out(c) for c in rows]


@router.delete("/consents/{policy}", status_code=204)
async def withdraw(policy: Policy, state: AppState = StateDep, principal: Principal = PrincipalDep) -> None:
    _human(principal)
    count = withdraw_consent(state, principal.tenant_id, principal.user_id, policy)
    if not count:
        raise HTTPException(status_code=404, detail="no active consent for this policy")
    state.audit.record(principal.tenant_id, principal.user_id, "consent.withdraw", policy=policy.value)


@router.get("/tenant/consents")
async def tenant_consents(policy: Policy | None = None, state: AppState = StateDep, principal: Principal = Admin) -> list[dict[str, Any]]:
    with state.db.session(principal.tenant_id) as s:
        q = select(Consent).where(Consent.tenant_id == principal.tenant_id).order_by(Consent.accepted_at.desc()).limit(5000)
        if policy:
            q = q.where(Consent.policy == policy.value)
        return [_consent_out(c) for c in s.execute(q).scalars()]


@router.get("/tenant/consent-settings")
async def get_consent_settings(state: AppState = StateDep, principal: Principal = Admin) -> dict[str, Any]:
    settings = consent_settings(state, principal.tenant_id)
    return {
        **settings.model_dump(),
        "llm_consent_given": has_admin_llm_consent(state, principal.tenant_id, settings.llm_addendum_version),
    }


@router.put("/tenant/consent-settings")
async def put_consent_settings(body: ConsentSettings, state: AppState = StateDep, principal: Principal = Admin) -> dict[str, Any]:
    """With ``llm_requires_consent``, every LLM feature returns 409 until an admin consents to the addendum version."""
    state.put_setting(principal.tenant_id, SETTING_KEY, body.model_dump())
    state.audit.record(principal.tenant_id, principal.user_id, "tenant.consent_settings.update", **body.model_dump())
    return await get_consent_settings(state, principal)


# -- OBS-004 cost attribution --------------------------------------------------------------------------------


def _day(value: str | None, default: date) -> date:
    if value is None:
        return default
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="dates must be YYYY-MM-DD") from exc


@router.get("/tenant/costs")
async def tenant_costs(
    start: str | None = None, end: str | None = None, state: AppState = StateDep, principal: Principal = Admin
) -> dict[str, Any]:
    """Estimated cost per category for ``[start, end]`` (inclusive; default: this month to date).

    LLM cost comes from metered token prices; compute is job seconds × rate; API is metered requests × rate;
    storage is the tenant's current stored bytes prorated over the range (GB-months × rate).
    """
    today = datetime.now(UTC).date()
    first, last = _day(start, today.replace(day=1)), _day(end, today)
    if last < first or (last - first).days > 366:
        raise HTTPException(status_code=422, detail="end must be on or after start, within 366 days")
    s_ = state.settings
    rates = {
        "compute_usd_per_second": s_.cost_compute_usd_per_second,
        "storage_usd_per_gb_month": s_.cost_storage_usd_per_gb_month,
        "api_usd_per_1k_requests": s_.cost_api_usd_per_1k_requests,
    }
    totals: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    with state.db.session(principal.tenant_id) as s:
        rows = s.execute(
            select(UsageCounter).where(
                UsageCounter.tenant_id == principal.tenant_id,
                UsageCounter.day >= first.isoformat(),
                UsageCounter.day <= last.isoformat(),
            )
        ).scalars()
        for row in rows:
            totals[row.metric][row.key] += row.value
    llm_by_model = dict(totals.get("llm.cost_usd", {}))
    llm_cost = sum(llm_by_model.values())
    compute_by_type = dict(totals.get("compute.seconds", {}))
    compute_seconds = sum(compute_by_type.values())
    compute_cost = compute_seconds * rates["compute_usd_per_second"]
    api_by_key = dict(totals.get("api.requests", {}))
    api_requests = sum(api_by_key.values())
    api_cost = api_requests / 1000 * rates["api_usd_per_1k_requests"]
    storage_bytes = state.store.tenant_usage_bytes(principal.tenant_id)
    gb_months = storage_bytes / GB * ((last - first).days + 1) / 30
    storage_cost = gb_months * rates["storage_usd_per_gb_month"]
    return {
        "start": first.isoformat(),
        "end": last.isoformat(),
        "currency": "USD",
        "rates": rates,
        "llm": {
            "cost_usd": round(llm_cost, 6),
            "by_model": {k: round(v, 6) for k, v in sorted(llm_by_model.items())},
            "input_tokens": int(sum(totals.get("llm.tokens.input", {}).values())),
            "output_tokens": int(sum(totals.get("llm.tokens.output", {}).values())),
            "unpriced_requests": int(sum(totals.get("llm.unpriced_requests", {}).values())),
        },
        "compute": {
            "seconds": round(compute_seconds, 3),
            "cost_usd": round(compute_cost, 6),
            "by_job_type": {k: round(v, 3) for k, v in sorted(compute_by_type.items())},
        },
        "storage": {
            "bytes": storage_bytes,
            "gb_months": round(gb_months, 12),
            "cost_usd": round(storage_cost, 12),
            "basis": "current usage, prorated",
        },
        "api": {
            "requests": int(api_requests),
            "cost_usd": round(api_cost, 6),
            "by_key": {k: int(v) for k, v in sorted(api_by_key.items())},
        },
        "total_cost_usd": round(llm_cost + compute_cost + api_cost + storage_cost, 6),
    }
