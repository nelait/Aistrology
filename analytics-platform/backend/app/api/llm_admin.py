"""LLM provider health (LPA-006) and prompt template management (LPA-008) endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth.rbac import Permission
from ..auth.service import Principal
from ..llm.health import PLATFORM_SCOPE, BreakerConfig
from ..llm.prompts import DEFAULT_PROMPTS, PromptError
from ..llm.prompts import PLATFORM_SCOPE as PROMPT_PLATFORM
from .deps import AppState, PrincipalDep, StateDep, require

router = APIRouter(tags=["llm-admin"])
Admin = require(Permission.MANAGE_TENANT)
Reader = require(Permission.READ_DATA)
PROVIDER_KINDS = ("", "anthropic", "openai", "openai_compatible", "gemini", "mock")


def platform_admin(principal: Principal = PrincipalDep, state: AppState = StateDep) -> Principal:
    """Platform operators: a signed-in user whose email is in AP_PLATFORM_ADMIN_EMAILS."""
    if principal.method != "jwt" or not principal.email or principal.email.lower() not in state.settings.platform_admin_emails:
        raise HTTPException(status_code=403, detail="platform operator access required")
    return principal


PlatformAdmin = Depends(platform_admin)


# -- LPA-006 health ------------------------------------------------------------------------------------


@router.get("/v1/tenant/llm-health")
async def tenant_llm_health(state: AppState = StateDep, principal: Principal = Reader) -> dict[str, Any]:
    """Rolling-window latency, error and refusal rates per provider for this tenant, with circuit-breaker state."""
    return {
        "window_seconds": state.llm_health.window_seconds,
        "breaker": state.breaker_config(principal.tenant_id).model_dump(),
        "providers": state.llm_health.snapshot(principal.tenant_id),
    }


@router.put("/v1/tenant/llm-health/breaker", response_model=BreakerConfig)
async def put_breaker(body: BreakerConfig, state: AppState = StateDep, principal: Principal = Admin) -> BreakerConfig:
    state.put_setting(principal.tenant_id, "llm_breaker", body.model_dump())
    state.audit.record(principal.tenant_id, principal.user_id, "tenant.llm_breaker.update", **body.model_dump())
    return body


@router.get("/v1/platform/llm-health")
async def platform_llm_health(state: AppState = StateDep, principal: Principal = PlatformAdmin) -> dict[str, Any]:
    """Platform-wide provider health across all tenants (no tenant identifiers)."""
    return {"window_seconds": state.llm_health.window_seconds, "providers": state.llm_health.snapshot(PLATFORM_SCOPE)}


# -- LPA-008 prompt templates ------------------------------------------------------------------------------


class PromptVersionCreate(BaseModel):
    system: str = Field(min_length=1, max_length=20_000)
    provider: str = Field(default="", description="Provider kind for a provider-specific variant; empty = any provider")
    description: str | None = Field(default=None, max_length=500)


def _check_template(template_id: str) -> None:
    if template_id not in DEFAULT_PROMPTS:
        raise HTTPException(status_code=404, detail="prompt template not found")


def _summary(state: AppState, tenant_id: str, template_id: str) -> dict[str, Any]:
    default = DEFAULT_PROMPTS[template_id]
    effective = state.prompts.resolve(tenant_id, default.ref)
    return {
        "template_id": template_id,
        "description": default.description,
        "variables": list(default.variables),
        "default": {"ref": default.ref, "system": default.system},
        "effective": {"ref": effective.ref, "source": effective.source} if effective else None,
    }


@router.get("/v1/prompts")
async def list_prompts(state: AppState = StateDep, principal: Principal = Reader) -> list[dict[str, Any]]:
    """Every prompt template with its platform default and the version in effect for this tenant (any provider)."""
    return [_summary(state, principal.tenant_id, t) for t in sorted(DEFAULT_PROMPTS)]


@router.get("/v1/prompts/{template_id}")
async def get_prompt(template_id: str, state: AppState = StateDep, principal: Principal = Reader) -> dict[str, Any]:
    _check_template(template_id)
    return {
        **_summary(state, principal.tenant_id, template_id),
        "tenant_versions": state.prompts.versions(principal.tenant_id, template_id),
        "platform_versions": state.prompts.versions(PROMPT_PLATFORM, template_id),
    }


def _create(state: AppState, scope: str, template_id: str, body: PromptVersionCreate, actor: str) -> dict[str, Any]:
    _check_template(template_id)
    if body.provider not in PROVIDER_KINDS:
        raise HTTPException(status_code=422, detail=f"provider must be one of {[p for p in PROVIDER_KINDS if p]} or empty")
    try:
        return state.prompts.create_version(
            scope, template_id, body.system, provider=body.provider, description=body.description, actor=actor
        )
    except PromptError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/v1/prompts/{template_id}/versions", status_code=201)
async def create_tenant_prompt(
    template_id: str, body: PromptVersionCreate, state: AppState = StateDep, principal: Principal = Admin
) -> dict[str, Any]:
    """Admin: a tenant override (new version, active immediately). Applied to every LLM call using this template."""
    out = _create(state, principal.tenant_id, template_id, body, principal.user_id)
    state.audit.record(principal.tenant_id, principal.user_id, "prompt.version.create", template=out["ref"], provider=body.provider or None)
    return out


@router.post("/v1/prompts/{template_id}/versions/{version}/{action}", status_code=204)
async def toggle_tenant_prompt(
    template_id: str, version: int, action: str, state: AppState = StateDep, principal: Principal = Admin
) -> None:
    """Admin: ``deactivate`` (fall back to the next candidate) or ``activate`` a tenant version."""
    if action not in ("activate", "deactivate"):
        raise HTTPException(status_code=404, detail="unknown action")
    _check_template(template_id)
    try:
        state.prompts.set_active(principal.tenant_id, template_id, version, action == "activate")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail="prompt version not found") from exc
    state.audit.record(principal.tenant_id, principal.user_id, f"prompt.version.{action}", template=f"{template_id}@{version}")


@router.post("/v1/platform/prompts/{template_id}/versions", status_code=201)
async def create_platform_prompt(
    template_id: str, body: PromptVersionCreate, state: AppState = StateDep, principal: Principal = PlatformAdmin
) -> dict[str, Any]:
    """Platform operator: a platform-wide override of the shipped default."""
    out = _create(state, PROMPT_PLATFORM, template_id, body, principal.email or principal.user_id)
    state.audit.record(PROMPT_PLATFORM, principal.email or principal.user_id, "prompt.platform_version.create", template=out["ref"])
    return out
