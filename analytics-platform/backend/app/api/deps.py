"""Shared application state and request dependencies."""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field

from fastapi import Depends, Header, HTTPException, Request

from ..audit import AuditLog
from ..llm.config import MissingSecretError, SecretStore, TenantLLMConfig, build_provider
from ..llm.router import LLMRouter, ResponseCache, UsageLedger
from ..storage.datasets import TENANT_ID_RE, DatasetStore


@dataclass
class AppState:
    store: DatasetStore
    audit: AuditLog = field(default_factory=AuditLog)
    ledger: UsageLedger = field(default_factory=UsageLedger)
    secrets: SecretStore = field(default_factory=SecretStore)
    cache: ResponseCache = field(default_factory=ResponseCache)
    llm_configs: dict[str, TenantLLMConfig] = field(default_factory=dict)
    # Tests and demos inject routers directly, bypassing provider construction.
    router_overrides: dict[str, LLMRouter] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def llm_config(self, tenant_id: str) -> TenantLLMConfig:
        return self.llm_configs.get(tenant_id) or TenantLLMConfig()

    def router(self, tenant_id: str) -> LLMRouter:
        if tenant_id in self.router_overrides:
            return self.router_overrides[tenant_id]
        config = self.llm_config(tenant_id)
        try:
            providers = [build_provider(tenant_id, p, self.secrets) for p in config.chain]
        except (MissingSecretError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=f"LLM provider is not configured: {exc}") from exc
        return LLMRouter(
            tenant_id,
            providers,
            ledger=self.ledger,
            audit=self.audit,
            cache=self.cache if config.cache_enabled else None,
        )


@dataclass(frozen=True)
class Principal:
    tenant_id: str
    user_id: str


def get_state(request: Request) -> AppState:
    return request.app.state.ap


def get_principal(
    x_tenant_id: str = Header(..., description="Tenant ID. DEV STUB: replaced by the verified JWT claim in production."),
    x_user_id: str = Header("anonymous", max_length=128),
) -> Principal:
    """DEV-ONLY identity stub.

    In production, identity comes from a verified OIDC/JWT access token issued by
    the platform IdP (AUTH-001). Tenant and user are claims in that token, never
    client-controlled headers. This stub exists so the modules can be built and
    tested before the auth service; it is disabled unless AP_DEV_AUTH=1.
    """
    if os.environ.get("AP_DEV_AUTH") != "1":
        raise HTTPException(status_code=401, detail="authentication is not configured (set AP_DEV_AUTH=1 for local development)")
    if not TENANT_ID_RE.match(x_tenant_id):
        raise HTTPException(status_code=400, detail="invalid tenant id")
    return Principal(tenant_id=x_tenant_id, user_id=x_user_id)


StateDep = Depends(get_state)
PrincipalDep = Depends(get_principal)
