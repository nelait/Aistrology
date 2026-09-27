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


TENANT_TABLES = [t for t in Base.metadata.sorted_tables if "tenant_id" in t.columns and t.name != "tenants"]
