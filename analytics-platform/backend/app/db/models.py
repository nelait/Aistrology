"""Metadata database schema (SQLAlchemy 2.0). SQLite for development and tests, PostgreSQL 16 in production.

Every tenant-owned table has a ``tenant_id`` column. On PostgreSQL, row-level
security policies (``app/db/rls.py``) restrict each session to the tenant it
declares (MT-001), in addition to the application-level filters.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, BigInteger, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(UTC)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


class Base(DeclarativeBase):
    type_annotation_map = {dict[str, Any]: JSON, list[Any]: JSON}


TS = DateTime(timezone=True)


class Tenant(Base):
    __tablename__ = "tenants"
    id: Mapped[str] = mapped_column(String(63), primary_key=True)  # slug, e.g. "acme"
    name: Mapped[str] = mapped_column(String(200))
    region: Mapped[str] = mapped_column(String(32), default="us")
    plan: Mapped[str] = mapped_column(String(32), default="trial")
    status: Mapped[str] = mapped_column(String(16), default="active")  # active | suspended | deleted
    require_mfa: Mapped[bool] = mapped_column(Boolean, default=False)
    quotas: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("usr"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    name: Mapped[str | None] = mapped_column(String(200))
    password_hash: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(32))
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(TS)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(TS)


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("rt"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(TS)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class ApiKey(Base):
    __tablename__ = "api_keys"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("key"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    prefix: Mapped[str] = mapped_column(String(32), unique=True)
    key_hash: Mapped[str] = mapped_column(String(64))
    role: Mapped[str] = mapped_column(String(32))
    scopes: Mapped[list[Any]] = mapped_column(JSON, default=list)
    rate_limit_per_minute: Mapped[int] = mapped_column(Integer, default=600)
    allowed_ips: Mapped[list[Any]] = mapped_column(JSON, default=list)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    expires_at: Mapped[datetime | None] = mapped_column(TS)
    revoked_at: Mapped[datetime | None] = mapped_column(TS)
    last_used_at: Mapped[datetime | None] = mapped_column(TS)


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("prj"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    # Open projects are visible to every member of the tenant (the Default project is open).
    open: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    __table_args__ = (UniqueConstraint("tenant_id", "name"),)


class ProjectMember(Base):
    """AUTH-003: project membership. Admins see every project; others see open projects and their own."""

    __tablename__ = "project_members"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    added_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class Dataset(Base):
    __tablename__ = "datasets"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("ds"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id"))
    name: Mapped[str] = mapped_column(String(200))
    source: Mapped[str] = mapped_column(String(32))  # upload | generated | pipeline | connector
    current_version: Mapped[int] = mapped_column(Integer, default=1)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(TS)


class DatasetVersion(Base):
    """Immutable snapshot (PIP-007). Tables and schema never change after creation, except schema confirmation (INF-006)."""

    __tablename__ = "dataset_versions"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("dsv"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    parent_version: Mapped[int | None] = mapped_column(Integer)
    pipeline_id: Mapped[str | None] = mapped_column(String(40))
    pipeline_hash: Mapped[str | None] = mapped_column(String(64))
    tables: Mapped[list[Any]] = mapped_column(JSON, default=list)
    schema_json: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    profile_json: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    __table_args__ = (UniqueConstraint("dataset_id", "version"),)


class TenantSetting(Base):
    """Per-tenant JSON settings documents (e.g. ``llm`` → TenantLLMConfig)."""

    __tablename__ = "tenant_settings"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), primary_key=True)
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow, onupdate=utcnow)


class AuditRecord(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(String(63), index=True)
    seq: Mapped[int] = mapped_column(Integer)  # per-tenant sequence; the hash chain is per tenant
    at: Mapped[str] = mapped_column(String(40))
    actor: Mapped[str] = mapped_column(String(320))
    action: Mapped[str] = mapped_column(String(100), index=True)
    detail: Mapped[dict[str, Any]] = mapped_column(JSON)
    prev_hash: Mapped[str] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64))
    __table_args__ = (UniqueConstraint("tenant_id", "seq"),)


class UsageCounter(Base):
    """Usage metering (MT-009): one row per tenant, metric, key and day."""

    __tablename__ = "usage_counters"
    tenant_id: Mapped[str] = mapped_column(String(63), primary_key=True)
    metric: Mapped[str] = mapped_column(String(64), primary_key=True)  # llm.tokens.input, api.requests, ...
    key: Mapped[str] = mapped_column(String(200), primary_key=True)  # provider/model, endpoint id, ...
    day: Mapped[str] = mapped_column(String(10), primary_key=True)
    value: Mapped[float] = mapped_column(Float, default=0.0)


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("job"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    type: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)  # queued|running|succeeded|failed|cancelled
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    message: Mapped[str | None] = mapped_column(Text)
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    error: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(TS)
    finished_at: Mapped[datetime | None] = mapped_column(TS)
    heartbeat_at: Mapped[datetime | None] = mapped_column(TS)


class Pipeline(Base):
    __tablename__ = "pipelines"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("pl"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    dataset_id: Mapped[str | None] = mapped_column(ForeignKey("datasets.id"))
    is_template: Mapped[bool] = mapped_column(Boolean, default=False)
    steps: Mapped[list[Any]] = mapped_column(JSON, default=list)
    redo_stack: Mapped[list[Any]] = mapped_column(JSON, default=list)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow, onupdate=utcnow)


class Experiment(Base):
    __tablename__ = "experiments"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("exp"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"))
    dataset_version: Mapped[int] = mapped_column(Integer)
    config: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class Run(Base):
    __tablename__ = "runs"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("run"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    experiment_id: Mapped[str] = mapped_column(ForeignKey("experiments.id"), index=True)
    job_id: Mapped[str | None] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(16), default="queued")
    algorithm: Mapped[str | None] = mapped_column(String(64))
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    metrics: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    artifacts: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # plots data, explanations, leaderboard
    model_key: Mapped[str | None] = mapped_column(String(300))  # object key of serialized pipeline
    code_version: Mapped[str | None] = mapped_column(String(64))
    duration_seconds: Mapped[float | None] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class RegisteredModel(Base):
    __tablename__ = "models"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("mdl"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    __table_args__ = (UniqueConstraint("tenant_id", "name"),)


class ModelVersion(Base):
    __tablename__ = "model_versions"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("mv"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    model_id: Mapped[str] = mapped_column(ForeignKey("models.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"))
    stage: Mapped[str] = mapped_column(String(16), default="none")  # none | staging | production | archived
    signature: Mapped[dict[str, Any]] = mapped_column(JSON)  # input features/types, target, problem type, classes
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    __table_args__ = (UniqueConstraint("model_id", "version"),)


class Endpoint(Base):
    __tablename__ = "endpoints"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("ep"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    # Traffic split (API-008): [{"model_version_id": ..., "weight": 90}, ...]
    routes: Mapped[list[Any]] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(16), default="active")
    min_replicas: Mapped[int] = mapped_column(Integer, default=0)
    log_payloads: Mapped[bool] = mapped_column(Boolean, default=False)
    cors_origins: Mapped[list[Any]] = mapped_column(JSON, default=list)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    __table_args__ = (UniqueConstraint("tenant_id", "name"),)


class PredictionLog(Base):
    __tablename__ = "prediction_logs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(String(63), index=True)
    endpoint_id: Mapped[str] = mapped_column(String(40), index=True)
    model_version_id: Mapped[str] = mapped_column(String(40))
    at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    latency_ms: Mapped[float] = mapped_column(Float)
    status: Mapped[int] = mapped_column(Integer)
    inputs: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    outputs: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    __table_args__ = (Index("ix_pred_ep_at", "endpoint_id", "at"),)


class Analytic(Base):
    """A saved analytic: SQL + visualization spec (USR-005)."""

    __tablename__ = "analytics"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("an"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"))
    name: Mapped[str] = mapped_column(String(200))
    sql: Mapped[str] = mapped_column(Text)
    chart: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    parameters: Mapped[list[Any]] = mapped_column(JSON, default=list)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class Dashboard(Base):
    __tablename__ = "dashboards"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("db"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    spec: Mapped[dict[str, Any]] = mapped_column(JSON)  # pages, layout, widgets, global filters, theme
    owner_id: Mapped[str] = mapped_column(String(64))
    shares: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # user_id -> editor|viewer
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow, onupdate=utcnow)


class Webhook(Base):
    __tablename__ = "webhooks"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("wh"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    url: Mapped[str] = mapped_column(String(2000))
    events: Mapped[list[Any]] = mapped_column(JSON)
    secret_name: Mapped[str] = mapped_column(String(100))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class WebhookDelivery(Base):
    __tablename__ = "webhook_deliveries"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("whd"))
    tenant_id: Mapped[str] = mapped_column(String(63), index=True)
    webhook_id: Mapped[str] = mapped_column(ForeignKey("webhooks.id"), index=True)
    event: Mapped[str] = mapped_column(String(100))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending | delivered | failed
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    response_code: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    delivered_at: Mapped[datetime | None] = mapped_column(TS)


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("ntf"))
    tenant_id: Mapped[str] = mapped_column(String(63), index=True)
    user_id: Mapped[str | None] = mapped_column(String(64), index=True)  # None = all tenant users
    kind: Mapped[str] = mapped_column(String(64))
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class TrainingTemplate(Base):
    """CFG-007: a named, reusable training configuration."""

    __tablename__ = "training_templates"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("tt"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    config: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    __table_args__ = (UniqueConstraint("tenant_id", "name"),)


class PredictionSample(Base):
    """API-011: a bounded per-endpoint, per-day reservoir of served inputs, stored as drift *tokens* (bins/categories),
    never raw values; PII features are not stored."""

    __tablename__ = "prediction_samples"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(String(63), index=True)
    endpoint_id: Mapped[str] = mapped_column(String(40))
    day: Mapped[str] = mapped_column(String(10))
    slot: Mapped[int] = mapped_column(Integer)
    model_version_id: Mapped[str] = mapped_column(String(40))
    at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    features: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    prediction: Mapped[str | None] = mapped_column(String(200))
    __table_args__ = (UniqueConstraint("endpoint_id", "day", "slot"), Index("ix_ps_ep_at", "endpoint_id", "at"))


class DriftCounter(Base):
    """API-011: instances seen per endpoint and day (the reservoir-sampling denominator)."""

    __tablename__ = "drift_counters"
    tenant_id: Mapped[str] = mapped_column(String(63), primary_key=True)
    endpoint_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    day: Mapped[str] = mapped_column(String(10), primary_key=True)
    seen: Mapped[int] = mapped_column(BigInteger, default=0)


# -- Phase 2 platform features (additive tables) ------------------------------------------------------


class PromptTemplateVersion(Base):
    """LPA-008: a tenant (or platform-wide, ``tenant_id='platform'``) override of a default prompt template.

    ``provider`` is empty for "any provider", or a provider kind (``anthropic``, ``openai``, ...) for a
    provider-specific variant. Versions are immutable; deactivating one falls back to the next candidate.
    """

    __tablename__ = "prompt_template_versions"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("ptv"))
    tenant_id: Mapped[str] = mapped_column(String(63), index=True)
    template_id: Mapped[str] = mapped_column(String(100), index=True)
    version: Mapped[int] = mapped_column(Integer)
    provider: Mapped[str] = mapped_column(String(32), default="")
    system: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(String(500))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[str] = mapped_column(String(320))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    __table_args__ = (UniqueConstraint("tenant_id", "template_id", "version"),)


class NotificationPreference(Base):
    """NTF-002: which notification kinds a user receives by email."""

    __tablename__ = "notification_preferences"
    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    email_kinds: Mapped[list[Any]] = mapped_column(JSON, default=list)
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow, onupdate=utcnow)


class ChatDestination(Base):
    """NTF-003: a Slack or Teams incoming-webhook destination. The URL is a credential and lives in the secret store."""

    __tablename__ = "chat_destinations"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("chd"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # slack | teams
    name: Mapped[str] = mapped_column(String(200))
    host: Mapped[str] = mapped_column(String(255))
    secret_name: Mapped[str] = mapped_column(String(100))
    events: Mapped[list[Any]] = mapped_column(JSON, default=list)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class OAuthClient(Base):
    """MGT-004a: an OAuth 2.0 client-credentials client. Only the SHA-256 of the secret is stored."""

    __tablename__ = "oauth_clients"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("oac"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    client_id: Mapped[str] = mapped_column(String(64), unique=True)
    secret_hash: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(32))
    scopes: Mapped[list[Any]] = mapped_column(JSON, default=list)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    revoked_at: Mapped[datetime | None] = mapped_column(TS)
    last_used_at: Mapped[datetime | None] = mapped_column(TS)


class PublicLink(Base):
    """SHR-001a: a revocable, expiring, view-only public link to a dashboard. Only the token's SHA-256 is stored."""

    __tablename__ = "public_links"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("pub"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    # No FK: deleting a dashboard must not be blocked by its links (a link to a missing dashboard resolves to 404).
    dashboard_id: Mapped[str] = mapped_column(String(40), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(TS)
    revoked_at: Mapped[datetime | None] = mapped_column(TS)


class ScimIdentity(Base):
    """AUTH-001a: the identity provider's ``externalId`` for a SCIM-provisioned user."""

    __tablename__ = "scim_identities"
    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    external_id: Mapped[str | None] = mapped_column(String(255))


class Team(Base):
    """AUTH-004: a group of users inside a tenant; projects can be granted to teams."""

    __tablename__ = "teams"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("team"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(String(1000))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    __table_args__ = (UniqueConstraint("tenant_id", "name"),)


class TeamMember(Base):
    __tablename__ = "team_members"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    team_id: Mapped[str] = mapped_column(ForeignKey("teams.id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    added_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class ProjectTeam(Base):
    """AUTH-004: project membership granted to a whole team."""

    __tablename__ = "project_teams"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    team_id: Mapped[str] = mapped_column(ForeignKey("teams.id"), primary_key=True)
    added_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class Consent(Base):
    """SEC-003 / SOC-PRV-005: a user's consent to a policy version. Withdrawal is recorded, never deleted."""

    __tablename__ = "consents"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("cns"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    role: Mapped[str] = mapped_column(String(32))  # the user's role when consenting
    policy: Mapped[str] = mapped_column(String(32))  # terms | privacy | llm_processing
    version: Mapped[str] = mapped_column(String(32))
    accepted_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    ip: Mapped[str | None] = mapped_column(String(64))
    withdrawn_at: Mapped[datetime | None] = mapped_column(TS)


class InboundHook(Base):
    """WHK-002: an incoming webhook that triggers batch prediction or dataset ingestion. The secret lives in the secret store."""

    __tablename__ = "inbound_hooks"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("ih"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    action: Mapped[str] = mapped_column(String(16))  # predict | ingest
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # {endpoint} | {dataset_id, mode}
    secret_name: Mapped[str] = mapped_column(String(100))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    last_triggered_at: Mapped[datetime | None] = mapped_column(TS)


# -- Phase 2 data-layer features (additive tables) ----------------------------------------------------


class SavedSchema(Base):
    """A named schema in a project (SCH-010). Its content lives in immutable ``schema_versions`` rows."""

    __tablename__ = "schemas"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("sch"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    current_version: Mapped[int] = mapped_column(Integer, default=1)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow, onupdate=utcnow)
    __table_args__ = (UniqueConstraint("tenant_id", "project_id", "name"),)


class SavedSchemaVersion(Base):
    __tablename__ = "schema_versions"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("schv"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    schema_id: Mapped[str] = mapped_column(ForeignKey("schemas.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    schema_json: Mapped[dict[str, Any]] = mapped_column(JSON)
    content_hash: Mapped[str] = mapped_column(String(64))
    source_format: Mapped[str | None] = mapped_column(String(32))
    message: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    __table_args__ = (UniqueConstraint("schema_id", "version"),)


class Connector(Base):
    """An external data source (ING-007). Credentials live in the SecretStore under ``secret_name``, never here."""

    __tablename__ = "connectors"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("conn"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(16))  # s3 | gcs | postgresql | mysql
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # non-secret settings (bucket, host, ...)
    secret_name: Mapped[str] = mapped_column(String(100))
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    __table_args__ = (UniqueConstraint("tenant_id", "name"),)


# -- Phase 3: scheduling & collaboration (additive tables) --------------------------------------------


class Schedule(Base):
    """A cron schedule that submits a job (USR-007, SHR-004, API-011). ``next_run_at`` is claimed with a conditional
    UPDATE, so only one scheduler replica submits each run."""

    __tablename__ = "schedules"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("sched"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    cron: Mapped[str] = mapped_column(String(200))
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    job_type: Mapped[str] = mapped_column(String(64))
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    next_run_at: Mapped[datetime | None] = mapped_column(TS, index=True)
    last_run_at: Mapped[datetime | None] = mapped_column(TS)
    last_job_id: Mapped[str | None] = mapped_column(String(40))
    last_status: Mapped[str | None] = mapped_column(String(16))  # submitted | skipped | failed
    last_error: Mapped[str | None] = mapped_column(Text)
    last_result: Mapped[dict[str, Any] | None] = mapped_column(JSON)  # bounded snapshot for the UI (USR-007)
    owner_role: Mapped[str] = mapped_column(String(32))  # the creator's role at creation (dev principals have no user row)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow, onupdate=utcnow)


class DashboardComment(Base):
    """SHR-005: a threaded comment on a dashboard or one of its widgets."""

    __tablename__ = "dashboard_comments"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("cmt"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    dashboard_id: Mapped[str] = mapped_column(String(40), index=True)  # no FK: comments go with the dashboard in the service
    widget_id: Mapped[str | None] = mapped_column(String(40))
    parent_id: Mapped[str | None] = mapped_column(String(40), index=True)
    author_id: Mapped[str] = mapped_column(String(64))
    body: Mapped[str] = mapped_column(Text)
    mentions: Mapped[list[Any]] = mapped_column(JSON, default=list)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    edited_at: Mapped[datetime | None] = mapped_column(TS)


class SuggestionPreference(Base):
    """LLM-009: per-tenant accept/reject counts by suggestion attribute (never shared across tenants)."""

    __tablename__ = "suggestion_preferences"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), primary_key=True)
    dimension: Mapped[str] = mapped_column(String(32), primary_key=True)  # chart_type | category
    value: Mapped[str] = mapped_column(String(64), primary_key=True)
    accepted: Mapped[int] = mapped_column(Integer, default=0)
    rejected: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow, onupdate=utcnow)


class SuggestionFeedback(Base):
    """LLM-009: one accept/reject event (attributes only; no suggestion SQL or data values)."""

    __tablename__ = "suggestion_feedback"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("sfb"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    dataset_id: Mapped[str] = mapped_column(String(40), index=True)
    user_id: Mapped[str] = mapped_column(String(64))
    accepted: Mapped[bool] = mapped_column(Boolean)
    chart_type: Mapped[str] = mapped_column(String(32))
    category: Mapped[str] = mapped_column(String(32))
    title: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class StreamState(Base):
    """ING-008: an append-only stream dataset's buffer counters and compaction settings."""

    __tablename__ = "streams"
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    buffered_rows: Mapped[int] = mapped_column(BigInteger, default=0)
    buffered_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    compact_rows: Mapped[int] = mapped_column(Integer, default=10_000)
    compact_bytes: Mapped[int] = mapped_column(BigInteger, default=16 * 1024 * 1024)
    compacting_job_id: Mapped[str | None] = mapped_column(String(40))
    compacting_since: Mapped[datetime | None] = mapped_column(TS)
    last_compacted_at: Mapped[datetime | None] = mapped_column(TS)
    total_rows: Mapped[int] = mapped_column(BigInteger, default=0)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


class StreamBatch(Base):
    """ING-008: one buffered micro-batch (rows in the encrypted object store) awaiting compaction."""

    __tablename__ = "stream_batches"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("sb"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    object_key: Mapped[str] = mapped_column(String(300))
    rows: Mapped[int] = mapped_column(Integer)
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    source: Mapped[str] = mapped_column(String(64))  # api | inbound:<hook id>
    claimed_by: Mapped[str | None] = mapped_column(String(40), index=True)  # compaction job id
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)


# -- Phase 3 ML & serving (additive tables) ---------------------------------------------------------


class CanaryRollout(Base):
    """API-009: a progressive (canary) rollout of a model version on an endpoint, evaluated step by step."""

    __tablename__ = "canary_rollouts"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("can"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    endpoint_id: Mapped[str] = mapped_column(String(40), index=True)
    endpoint_name: Mapped[str] = mapped_column(String(100))
    candidate: Mapped[dict[str, Any]] = mapped_column(JSON)  # the route of the new model version
    baseline_routes: Mapped[list[Any]] = mapped_column(JSON)  # routes before the rollout (restored on rollback)
    steps: Mapped[list[Any]] = mapped_column(JSON)  # canary traffic percentages, e.g. [5, 25, 50, 100]
    step_index: Mapped[int] = mapped_column(Integer, default=0)
    step_minutes: Mapped[float] = mapped_column(Float)
    max_error_rate: Mapped[float] = mapped_column(Float)
    max_p95_ms_increase: Mapped[float] = mapped_column(Float)
    min_requests: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="running")  # running | completed | rolled_back | aborted
    reason: Mapped[str | None] = mapped_column(Text)
    history: Mapped[list[Any]] = mapped_column(JSON, default=list)
    step_started_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    next_eval_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(TS)


TENANT_TABLES = [t for t in Base.metadata.sorted_tables if "tenant_id" in t.columns and t.name != "tenants"]
