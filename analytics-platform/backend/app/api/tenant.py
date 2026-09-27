"""Tenant admin console API (MT-008): users, API keys, LLM provider and BYOK secrets, quotas, usage, audit, lifecycle."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select

from ..audit import AuditEntry
from ..auth.rbac import Permission, Role
from ..auth.service import ConflictError, Principal
from ..db.models import ApiKey, Tenant, User
from ..llm.config import TenantLLMConfig
from ..tenancy import delete_tenant_data
from .deps import AppState, StateDep, require

router = APIRouter(prefix="/v1/tenant", tags=["tenant"])
Admin = require(Permission.MANAGE_TENANT)


class SecretPut(BaseModel):
    value: str = Field(min_length=1, max_length=4096)


class UserCreate(BaseModel):
    email: EmailStr
    role: Role
    password: str = Field(min_length=12, max_length=256)
    name: str | None = None


class UserPatch(BaseModel):
    role: Role | None = None
    disabled: bool | None = None


class UserOut(BaseModel):
    id: str
    email: str
    name: str | None
    role: str
    mfa_enabled: bool
    disabled: bool


class ApiKeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    role: Role = Role.DATA_SCIENTIST
    scopes: list[Permission] = Field(default_factory=list, description="Optional narrowing of the role's permissions")
    rate_limit_per_minute: int = Field(default=600, ge=1, le=100_000)
    expires_in_days: int | None = Field(default=None, ge=1, le=3650)
    allowed_ips: list[str] = Field(default_factory=list, max_length=100)


class ApiKeyOut(BaseModel):
    id: str
    name: str
    prefix: str
    role: str
    scopes: list[str]
    rate_limit_per_minute: int
    allowed_ips: list[str]
    created_at: datetime
    expires_at: datetime | None
    revoked_at: datetime | None
    last_used_at: datetime | None


class TenantPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    require_mfa: bool | None = None
    quotas: dict[str, int] | None = None


def _user_out(u: User) -> UserOut:
    return UserOut(id=u.id, email=u.email, name=u.name, role=u.role, mfa_enabled=u.mfa_enabled, disabled=u.disabled)


def _key_out(k: ApiKey) -> ApiKeyOut:
    return ApiKeyOut(
        id=k.id,
        name=k.name,
        prefix=k.prefix,
        role=k.role,
        scopes=list(k.scopes),
        rate_limit_per_minute=k.rate_limit_per_minute,
        allowed_ips=list(k.allowed_ips),
        created_at=k.created_at,
        expires_at=k.expires_at,
        revoked_at=k.revoked_at,
        last_used_at=k.last_used_at,
    )


# -- organization -------------------------------------------------------------


@router.get("")
async def get_tenant(state: AppState = StateDep, principal: Principal = Admin) -> dict[str, Any]:
    with state.db.session(principal.tenant_id) as s:
        t = s.get(Tenant, principal.tenant_id)
        return {
            "id": t.id,
            "name": t.name,
            "region": t.region,
            "plan": t.plan,
            "status": t.status,
            "require_mfa": t.require_mfa,
            "quotas": t.quotas,
            "storage_used_bytes": state.store.tenant_usage_bytes(t.id),
            "storage_quota_bytes": state.store.tenant_quota_bytes,
            "cloud_provider": state.cloud.provider,
        }


@router.patch("")
async def patch_tenant(body: TenantPatch, state: AppState = StateDep, principal: Principal = Admin) -> dict[str, Any]:
    with state.db.session(principal.tenant_id) as s:
        t = s.get(Tenant, principal.tenant_id)
        for key, value in body.model_dump(exclude_none=True).items():
            setattr(t, key, value)
    state.audit.record(principal.tenant_id, principal.user_id, "tenant.update", **body.model_dump(exclude_none=True))
    return await get_tenant(state, principal)


@router.delete("", status_code=202)
async def delete_tenant(confirm: str, state: AppState = StateDep, principal: Principal = Admin) -> dict[str, Any]:
    """MT-010 / SOC-PRV-004: delete all tenant data and crypto-shred its key. ``confirm`` must equal the tenant ID."""
    if confirm != principal.tenant_id:
        raise HTTPException(status_code=400, detail="pass ?confirm=<tenant id> to confirm deletion")
    state.audit.record(principal.tenant_id, principal.user_id, "tenant.delete_requested")
    return delete_tenant_data(state, principal.tenant_id)


# -- users ---------------------------------------------------------------------


@router.get("/users", response_model=list[UserOut])
async def list_users(state: AppState = StateDep, principal: Principal = Admin) -> list[UserOut]:
    with state.db.session(principal.tenant_id) as s:
        return [_user_out(u) for u in s.execute(select(User).where(User.tenant_id == principal.tenant_id).order_by(User.email)).scalars()]


@router.post("/users", response_model=UserOut, status_code=201)
async def create_user(body: UserCreate, state: AppState = StateDep, principal: Principal = Admin) -> UserOut:
    try:
        user = state.auth.create_user(principal.tenant_id, email=body.email, role=body.role, password=body.password, name=body.name)
    except ConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    state.audit.record(principal.tenant_id, principal.user_id, "user.create", user_id=user.id, role=body.role.value)
    return _user_out(user)


@router.patch("/users/{user_id}", response_model=UserOut)
async def patch_user(user_id: str, body: UserPatch, state: AppState = StateDep, principal: Principal = Admin) -> UserOut:
    with state.db.session(principal.tenant_id) as s:
        user = s.get(User, user_id)
        if user is None or user.tenant_id != principal.tenant_id:
            raise HTTPException(status_code=404, detail="user not found")
        if user.id == principal.user_id and (body.disabled or (body.role and body.role != Role.ADMIN)):
            raise HTTPException(status_code=400, detail="you can't demote or disable yourself")
        if body.role is not None:
            user.role = body.role.value
        if body.disabled is not None:
            user.disabled = body.disabled
        out = _user_out(user)
    state.audit.record(
        principal.tenant_id, principal.user_id, "user.update", user_id=user_id, **body.model_dump(mode="json", exclude_none=True)
    )
    return out


# -- API keys ------------------------------------------------------------------


@router.get("/api-keys", response_model=list[ApiKeyOut])
async def list_api_keys(state: AppState = StateDep, principal: Principal = require(Permission.DEPLOY)) -> list[ApiKeyOut]:
    with state.db.session(principal.tenant_id) as s:
        return [_key_out(k) for k in s.execute(select(ApiKey).where(ApiKey.tenant_id == principal.tenant_id)).scalars()]


@router.post("/api-keys", status_code=201)
async def create_api_key(body: ApiKeyCreate, state: AppState = StateDep, principal: Principal = require(Permission.DEPLOY)) -> dict:
    """MGT-001. The key is shown once; only its hash is stored."""
    if body.role == Role.ADMIN and principal.role != Role.ADMIN.value:
        raise HTTPException(status_code=403, detail="only admins can create admin keys")
    key, secret = state.auth.create_api_key(
        principal.tenant_id,
        name=body.name,
        role=body.role,
        created_by=principal.user_id,
        scopes=[p.value for p in body.scopes],
        rate_limit_per_minute=body.rate_limit_per_minute,
        expires_in_days=body.expires_in_days,
        allowed_ips=body.allowed_ips,
    )
    state.audit.record(principal.tenant_id, principal.user_id, "api_key.create", key_id=key.id, role=body.role.value)
    return {"key": secret, **_key_out(key).model_dump(mode="json")}


@router.post("/api-keys/{key_id}/rotate", status_code=201)
async def rotate_api_key(key_id: str, state: AppState = StateDep, principal: Principal = require(Permission.DEPLOY)) -> dict:
    try:
        key, secret = state.auth.rotate_api_key(principal.tenant_id, key_id, principal.user_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail="API key not found") from exc
    state.audit.record(principal.tenant_id, principal.user_id, "api_key.rotate", old_key_id=key_id, key_id=key.id)
    return {"key": secret, **_key_out(key).model_dump(mode="json")}


@router.delete("/api-keys/{key_id}", status_code=204)
async def revoke_api_key(key_id: str, state: AppState = StateDep, principal: Principal = require(Permission.DEPLOY)) -> None:
    with state.db.session(principal.tenant_id) as s:
        key = s.get(ApiKey, key_id)
        if key is None or key.tenant_id != principal.tenant_id:
            raise HTTPException(status_code=404, detail="API key not found")
        key.revoked_at = key.revoked_at or datetime.now(UTC)
    state.audit.record(principal.tenant_id, principal.user_id, "api_key.revoke", key_id=key_id)


# -- LLM configuration ---------------------------------------------------------


@router.get("/llm-config", response_model=TenantLLMConfig)
async def get_llm_config(state: AppState = StateDep, principal: Principal = require(Permission.READ_DATA)) -> TenantLLMConfig:
    return state.llm_config(principal.tenant_id)


@router.put("/llm-config", response_model=TenantLLMConfig)
async def put_llm_config(config: TenantLLMConfig, state: AppState = StateDep, principal: Principal = Admin) -> TenantLLMConfig:
    state.set_llm_config(principal.tenant_id, config)
    state.audit.record(
        principal.tenant_id,
        principal.user_id,
        "tenant.llm_config.update",
        chain=[f"{p.kind.value}:{p.resolved_model()}" for p in config.chain],
        data_minimization=config.data_minimization.value,
    )
    return config


@router.put("/secrets/{name}", status_code=204)
async def put_secret(name: str, body: SecretPut, state: AppState = StateDep, principal: Principal = Admin) -> None:
    """Store a BYOK API key in the cloud secret manager. Write-only: secrets are never returned by any endpoint."""
    if name.startswith("mfa-"):
        raise HTTPException(status_code=400, detail="reserved secret name")
    state.secrets.put(principal.tenant_id, name, body.value)
    state.audit.record(principal.tenant_id, principal.user_id, "tenant.secret.put", name=name)


@router.delete("/secrets/{name}", status_code=204)
async def delete_secret(name: str, state: AppState = StateDep, principal: Principal = Admin) -> None:
    state.secrets.delete(principal.tenant_id, name)
    state.audit.record(principal.tenant_id, principal.user_id, "tenant.secret.delete", name=name)


@router.get("/secrets")
async def list_secrets(state: AppState = StateDep, principal: Principal = Admin) -> dict[str, list[str]]:
    return {"names": [n for n in state.secrets.names(principal.tenant_id) if not n.startswith("mfa-")]}


# -- usage & audit -------------------------------------------------------------


@router.get("/llm-usage")
async def llm_usage(state: AppState = StateDep, principal: Principal = require(Permission.READ_DATA)) -> dict[str, Any]:
    usage = state.ledger.for_tenant(principal.tenant_id)
    return {
        "by_model": {k: v.model_dump() for k, v in usage.items()},
        "total_cost_usd": round(sum(v.cost_usd for v in usage.values()), 6),
        "total_tokens": sum(v.input_tokens + v.output_tokens for v in usage.values()),
    }


@router.get("/usage")
async def usage(since: str | None = None, state: AppState = StateDep, principal: Principal = Admin) -> dict[str, Any]:
    """MT-009: all metered usage (storage, API calls, compute seconds, LLM tokens)."""
    return {
        "storage_bytes": state.store.tenant_usage_bytes(principal.tenant_id),
        "counters": state.metering.totals(principal.tenant_id, since=since),
    }


@router.get("/audit", response_model=list[AuditEntry])
async def audit_log(
    action: str | None = None, state: AppState = StateDep, principal: Principal = require(Permission.VIEW_AUDIT)
) -> list[AuditEntry]:
    return state.audit.entries(principal.tenant_id, action, limit=500)


@router.get("/audit/verify")
async def verify_audit(state: AppState = StateDep, principal: Principal = require(Permission.VIEW_AUDIT)) -> dict[str, bool]:
    return {"valid": state.audit.verify(principal.tenant_id)}
