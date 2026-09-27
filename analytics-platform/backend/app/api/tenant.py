"""Tenant admin endpoints: LLM provider configuration, BYOK secrets, usage, audit (MT-008, LPA-004/007)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..audit import AuditEntry
from ..llm.config import TenantLLMConfig
from ..llm.router import UsageRecord
from .deps import AppState, Principal, PrincipalDep, StateDep

router = APIRouter(prefix="/v1/tenant", tags=["tenant"])


class SecretPut(BaseModel):
    value: str = Field(min_length=1, max_length=4096)


@router.get("/llm-config", response_model=TenantLLMConfig)
async def get_llm_config(state: AppState = StateDep, principal: Principal = PrincipalDep) -> TenantLLMConfig:
    return state.llm_config(principal.tenant_id)


@router.put("/llm-config", response_model=TenantLLMConfig)
async def put_llm_config(config: TenantLLMConfig, state: AppState = StateDep, principal: Principal = PrincipalDep) -> TenantLLMConfig:
    # TODO(AUTH-002): restrict to the tenant Admin role once RBAC lands.
    state.llm_configs[principal.tenant_id] = config
    state.audit.record(
        principal.tenant_id,
        principal.user_id,
        "tenant.llm_config.update",
        chain=[f"{p.kind.value}:{p.resolved_model()}" for p in config.chain],
        data_minimization=config.data_minimization.value,
    )
    return config


@router.put("/secrets/{name}", status_code=204)
async def put_secret(name: str, body: SecretPut, state: AppState = StateDep, principal: Principal = PrincipalDep) -> None:
    """Store a BYOK API key. Write-only: secrets are never returned by any endpoint."""
    state.secrets.put(principal.tenant_id, name, body.value)
    state.audit.record(principal.tenant_id, principal.user_id, "tenant.secret.put", name=name)


@router.get("/secrets")
async def list_secrets(state: AppState = StateDep, principal: Principal = PrincipalDep) -> dict[str, list[str]]:
    return {"names": state.secrets.names(principal.tenant_id)}


@router.get("/llm-usage")
async def llm_usage(state: AppState = StateDep, principal: Principal = PrincipalDep) -> dict[str, Any]:
    usage: dict[str, UsageRecord] = state.ledger.for_tenant(principal.tenant_id)
    return {
        "by_model": {k: v.model_dump() for k, v in usage.items()},
        "total_cost_usd": round(sum(v.cost_usd for v in usage.values()), 6),
        "total_tokens": sum(v.input_tokens + v.output_tokens for v in usage.values()),
    }


@router.get("/audit", response_model=list[AuditEntry])
async def audit_log(action: str | None = None, state: AppState = StateDep, principal: Principal = PrincipalDep) -> list[AuditEntry]:
    return state.audit.entries(principal.tenant_id, action)[-500:]
