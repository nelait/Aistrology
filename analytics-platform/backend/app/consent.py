"""Consent management (SEC-003, SOC-PRV-005).

Users record consent to a policy version (terms of service, privacy policy, LLM data-processing addendum);
withdrawal is recorded, never deleted, so the history stays auditable.

A tenant can require consent before any of its data is sent to an LLM (tenant setting ``consent``:
``{"llm_requires_consent": true, "llm_addendum_version": "1"}``). While it is on, ``AppState.router`` refuses
every LLM call until a tenant *admin* has an active consent to ``llm_processing`` at the required version.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import Enum
from typing import TYPE_CHECKING

from pydantic import BaseModel, Field
from sqlalchemy import select

from .auth.rbac import Role
from .db.models import Consent

if TYPE_CHECKING:  # pragma: no cover
    from .api.deps import AppState

SETTING_KEY = "consent"


class Policy(str, Enum):
    TERMS = "terms"
    PRIVACY = "privacy"
    LLM_PROCESSING = "llm_processing"


class ConsentSettings(BaseModel):
    llm_requires_consent: bool = False
    llm_addendum_version: str = Field(default="1", min_length=1, max_length=32)


class LLMConsentRequired(Exception):
    pass


def consent_settings(state: AppState, tenant_id: str) -> ConsentSettings:
    return ConsentSettings.model_validate(state.get_setting(tenant_id, SETTING_KEY) or {})


def has_admin_llm_consent(state: AppState, tenant_id: str, version: str) -> bool:
    with state.db.session(tenant_id) as s:
        row = s.execute(
            select(Consent.id)
            .where(
                Consent.tenant_id == tenant_id,
                Consent.policy == Policy.LLM_PROCESSING.value,
                Consent.version == version,
                Consent.role == Role.ADMIN.value,
                Consent.withdrawn_at.is_(None),
            )
            .limit(1)
        ).first()
    return row is not None


def check_llm_consent(state: AppState, tenant_id: str) -> None:
    """Raise :class:`LLMConsentRequired` when the tenant requires consent and no admin has given it."""
    settings = consent_settings(state, tenant_id)
    if not settings.llm_requires_consent:
        return
    if not has_admin_llm_consent(state, tenant_id, settings.llm_addendum_version):
        raise LLMConsentRequired(
            "LLM features are disabled for this organization until an admin accepts the LLM data-processing addendum "
            f'(version {settings.llm_addendum_version}): POST /v1/consents {{"policy": "llm_processing", '
            f'"version": "{settings.llm_addendum_version}"}}'
        )


def record_consent(state: AppState, tenant_id: str, user_id: str, role: str, policy: Policy, version: str, ip: str | None) -> Consent:
    with state.db.session(tenant_id) as s:
        row = Consent(tenant_id=tenant_id, user_id=user_id, role=role, policy=policy.value, version=version, ip=ip)
        s.add(row)
        s.flush()
        s.expunge(row)
    return row


def withdraw_consent(state: AppState, tenant_id: str, user_id: str, policy: Policy) -> int:
    now = datetime.now(UTC)
    with state.db.session(tenant_id) as s:
        rows = s.execute(
            select(Consent).where(
                Consent.tenant_id == tenant_id, Consent.user_id == user_id, Consent.policy == policy.value, Consent.withdrawn_at.is_(None)
            )
        ).scalars()
        count = 0
        for row in rows:
            row.withdrawn_at = now
            count += 1
    return count
