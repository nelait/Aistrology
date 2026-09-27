"""Application state (wired from settings + cloud provider) and request dependencies."""

from __future__ import annotations

import dataclasses
import threading
from dataclasses import dataclass, field
from typing import Any

from fastapi import Depends, Header, HTTPException, Request

from ..audit import DbAuditLog
from ..auth.rbac import Permission, Role, has_permission
from ..auth.service import AuthError, AuthService, Principal
from ..cloud.base import Cloud
from ..cloud.crypto import EncryptedObjectStore, TenantKeyring
from ..cloud.factory import build_cloud
from ..config import Settings, load_settings
from ..db.models import TenantSetting
from ..db.session import Database, default_url
from ..llm.base import ProviderError
from ..llm.config import MissingSecretError, TenantLLMConfig, build_provider
from ..llm.router import LLMRouter, ResponseCache
from ..metering import DbUsageLedger, Metering
from ..quotas import QuotaExceededError, check_platform_llm_quota
from ..ratelimit import RateLimiter
from ..storage.datasets import TENANT_ID_RE, DatasetStore


@dataclass
class AppState:
    settings: Settings
    cloud: Cloud
    db: Database
    objects: EncryptedObjectStore
    store: DatasetStore
    audit: DbAuditLog
    metering: Metering
    ledger: DbUsageLedger
    auth: AuthService
    cache: ResponseCache = field(default_factory=ResponseCache)
    rate_limiter: RateLimiter = field(default_factory=RateLimiter)
    # Tests and demos inject routers directly, bypassing provider construction.
    router_overrides: dict[str, LLMRouter] = field(default_factory=dict)
    extras: dict[str, Any] = field(default_factory=dict)  # jobs runner, model cache, ...
    _lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def secrets(self):
        return self.cloud.secrets

    # -- per-tenant settings documents -------------------------------------------
    def get_setting(self, tenant_id: str, key: str) -> dict | None:
        with self.db.session(tenant_id) as s:
            row = s.get(TenantSetting, (tenant_id, key))
            return dict(row.value) if row else None

    def put_setting(self, tenant_id: str, key: str, value: dict) -> None:
        with self.db.session(tenant_id) as s:
            row = s.get(TenantSetting, (tenant_id, key))
            if row is None:
                s.add(TenantSetting(tenant_id=tenant_id, key=key, value=value))
            else:
                row.value = value

    def ensure_tenant(self, tenant_id: str) -> None:
        """Dev-auth only: create the tenant row on first use (real tenants come from signup)."""
        from ..db.models import Tenant

        with self.db.session(tenant_id) as s:
            if s.get(Tenant, tenant_id) is None:
                s.add(Tenant(id=tenant_id, name=tenant_id))
        from ..projects import default_project_id

        default_project_id(self, tenant_id)

    def llm_config(self, tenant_id: str) -> TenantLLMConfig:
        raw = self.get_setting(tenant_id, "llm")
        return TenantLLMConfig.model_validate(raw) if raw else TenantLLMConfig()

    def set_llm_config(self, tenant_id: str, config: TenantLLMConfig) -> None:
        self.put_setting(tenant_id, "llm", config.model_dump(mode="json"))

    def router(self, tenant_id: str, task: str | None = None) -> LLMRouter:
        """The tenant's LLM router. ``task`` selects a per-task model for the primary provider (LPA-009)."""
        if tenant_id in self.router_overrides:
            return self.router_overrides[tenant_id]
        config = self.llm_config(tenant_id)
        chain = list(config.chain)
        if task and task in config.task_models:
            chain[0] = chain[0].model_copy(update={"model": config.task_models[task]})
        platform = {
            "kind": self.settings.platform_llm_kind,
            "model": self.settings.platform_llm_model,
            "base_url": self.settings.platform_llm_base_url,
        }
        try:
            providers = [build_provider(tenant_id, p, self.secrets, platform=platform) for p in chain]
        except (MissingSecretError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=f"LLM provider is not configured: {exc}") from exc

        def precheck(provider) -> None:
            # LPA-011 / MT-006: the platform-provided LLM is capped per tenant per month; BYOK providers are not.
            if provider.name.startswith("platform:"):
                try:
                    check_platform_llm_quota(self, tenant_id)
                except QuotaExceededError as exc:
                    raise ProviderError(provider.name, str(exc), retryable=True) from exc

        return LLMRouter(
            tenant_id,
            providers,
            ledger=self.ledger,
            audit=self.audit,
            cache=self.cache if config.cache_enabled else None,
            precheck=precheck,
        )


def build_state(settings: Settings | None = None, *, cloud: Cloud | None = None, **overrides: Any) -> AppState:
    """Wire everything from settings. ``overrides`` replace Settings fields (handy in tests)."""
    settings = settings or load_settings()
    if overrides:
        settings = dataclasses.replace(settings, **overrides)
    cloud = cloud or build_cloud(settings)
    db = Database(settings.database_url or default_url(settings.data_dir))
    db.create_all()
    objects = EncryptedObjectStore(cloud.objects, TenantKeyring(cloud.objects, cloud.kms))
    metering = Metering(db)
    return AppState(
        settings=settings,
        cloud=cloud,
        db=db,
        objects=objects,
        store=DatasetStore(
            db,
            objects,
            settings.data_dir,
            max_dataset_bytes=settings.max_dataset_bytes,
            tenant_quota_bytes=settings.tenant_storage_quota_bytes,
        ),
        audit=DbAuditLog(db),
        metering=metering,
        ledger=DbUsageLedger(metering),
        auth=AuthService(db, cloud.secrets, settings),
    )


def get_state(request: Request) -> AppState:
    return request.app.state.ap


def get_principal(
    request: Request,
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None),
    x_tenant_id: str | None = Header(None, description="Development only (AP_DEV_AUTH=1)."),
    x_user_id: str | None = Header(None, max_length=128),
) -> Principal:
    """Resolve the caller from a Bearer JWT, an API key, or (dev only) X-Tenant-ID headers."""
    state: AppState = request.app.state.ap
    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    try:
        if x_api_key or (token and token.startswith("ap_")):
            client_ip = request.client.host if request.client else None
            principal = state.auth.verify_api_key(x_api_key or token, client_ip)  # type: ignore[arg-type]
        elif token:
            principal = state.auth.verify_access_token(token)
        elif state.settings.dev_auth and x_tenant_id:
            if not TENANT_ID_RE.match(x_tenant_id):
                raise HTTPException(status_code=400, detail="invalid tenant id")
            state.ensure_tenant(x_tenant_id)
            principal = Principal(tenant_id=x_tenant_id, user_id=x_user_id or "dev", role=Role.ADMIN.value, method="dev")
        else:
            raise HTTPException(status_code=401, detail="authentication required", headers={"WWW-Authenticate": "Bearer"})
    except AuthError as exc:
        raise HTTPException(
            status_code=401, detail={"code": exc.code, "message": str(exc)}, headers={"WWW-Authenticate": "Bearer"}
        ) from exc
    # MGT-002: per-key / per-user rate limit.
    limit = principal.rate_limit_per_minute or 1200
    if not state.rate_limiter.allow(f"{principal.tenant_id}:{principal.user_id}", limit):
        raise HTTPException(status_code=429, detail="rate limit exceeded", headers={"Retry-After": "60"})
    request.state.principal = principal
    return principal


def require(permission: Permission):
    """Dependency factory: the caller must hold ``permission`` (AUTH-002)."""

    def _dep(principal: Principal = Depends(get_principal)) -> Principal:
        if not has_permission(principal.role, permission, principal.scopes if principal.method == "api_key" else None):
            raise HTTPException(status_code=403, detail=f"missing permission {permission.value}")
        return principal

    return Depends(_dep)


StateDep = Depends(get_state)
PrincipalDep = Depends(get_principal)


def guard_dataset(state: AppState, principal: Principal, dataset_id: str | None) -> None:
    """404 unless the caller can see the dataset (tenant + project access, AUTH-003)."""
    if dataset_id is None:
        return
    from ..projects import ProjectAccessDenied, check_dataset
    from ..storage.datasets import DatasetNotFound

    try:
        check_dataset(state, principal, dataset_id)
    except (DatasetNotFound, ProjectAccessDenied) as exc:
        raise HTTPException(status_code=404, detail="dataset not found") from exc
