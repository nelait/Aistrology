"""Runtime settings, read from environment variables prefixed ``AP_``.

The cloud provider is a deployment choice (``AP_CLOUD_PROVIDER``): ``local``
(single machine, for development and tests), ``gcp`` or ``aws``. Every
cloud-specific setting below is only read when its provider is selected.
The Terraform outputs in ``infra/`` produce exactly these variables.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

GB = 1024**3


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


@dataclass(frozen=True)
class Settings:
    # --- limits ---------------------------------------------------------
    # D3: 1 GB per dataset, enforced at every entry point (MT-007).
    max_dataset_bytes: int = field(default_factory=lambda: int(_env("AP_MAX_DATASET_BYTES", str(GB))))
    # MT-006 default storage quota per tenant.
    tenant_storage_quota_bytes: int = field(default_factory=lambda: int(_env("AP_TENANT_STORAGE_QUOTA_BYTES", str(10 * GB))))
    # Above this many rows, generation runs as an async job (SCH-NFR-005).
    sync_generation_row_limit: int = field(default_factory=lambda: int(_env("AP_SYNC_GENERATION_ROW_LIMIT", "100000")))
    # ING-NFR-002: schema inference samples instead of scanning whole files.
    inference_head_rows: int = 10_000
    inference_reservoir_rows: int = 50_000
    query_row_limit: int = 10_000
    query_timeout_seconds: float = 30.0

    # --- local paths ----------------------------------------------------
    # Local mode stores everything here. In cloud mode this is only a scratch/cache
    # directory for decrypted working copies (an emptyDir volume in Kubernetes).
    data_dir: Path = field(default_factory=lambda: Path(_env("AP_DATA_DIR", "./.data")).resolve())

    # --- database -------------------------------------------------------
    database_url: str | None = field(default_factory=lambda: _env("AP_DATABASE_URL"))

    # --- cloud ----------------------------------------------------------
    cloud_provider: str = field(default_factory=lambda: _env("AP_CLOUD_PROVIDER", "local"))
    object_bucket: str | None = field(default_factory=lambda: _env("AP_OBJECT_BUCKET"))
    secret_prefix: str = field(default_factory=lambda: _env("AP_SECRET_PREFIX", "analytics"))
    jwt_secret_name: str = field(default_factory=lambda: _env("AP_JWT_SECRET_NAME", "platform-jwt-signing-key"))
    # GCP
    gcp_project: str | None = field(default_factory=lambda: _env("AP_GCP_PROJECT"))
    gcp_location: str = field(default_factory=lambda: _env("AP_GCP_LOCATION", "us-central1"))
    gcp_kms_key: str | None = field(default_factory=lambda: _env("AP_GCP_KMS_KEY"))
    gcp_pubsub_topic: str | None = field(default_factory=lambda: _env("AP_GCP_PUBSUB_TOPIC"))
    gcp_pubsub_subscription: str | None = field(default_factory=lambda: _env("AP_GCP_PUBSUB_SUBSCRIPTION"))
    # AWS
    aws_region: str = field(default_factory=lambda: _env("AP_AWS_REGION", "us-east-1"))
    aws_kms_key_id: str | None = field(default_factory=lambda: _env("AP_AWS_KMS_KEY_ID"))
    aws_sqs_queue_url: str | None = field(default_factory=lambda: _env("AP_AWS_SQS_QUEUE_URL"))

    # --- auth -----------------------------------------------------------
    access_token_ttl_seconds: int = field(default_factory=lambda: int(_env("AP_ACCESS_TOKEN_TTL", "900")))
    refresh_token_ttl_seconds: int = field(default_factory=lambda: int(_env("AP_REFRESH_TOKEN_TTL", str(14 * 24 * 3600))))
    # Development-only header auth (X-Tenant-ID / X-User-ID). Never enable in production.
    dev_auth: bool = field(default_factory=lambda: _env("AP_DEV_AUTH") == "1")

    # --- platform-provided LLM (LPA-011) --------------------------------
    # The key lives in the secret store as tenant "platform", name "platform-llm-key".
    platform_llm_kind: str = field(default_factory=lambda: _env("AP_PLATFORM_LLM_KIND", "mock"))
    platform_llm_model: str | None = field(default_factory=lambda: _env("AP_PLATFORM_LLM_MODEL"))
    platform_llm_base_url: str | None = field(default_factory=lambda: _env("AP_PLATFORM_LLM_BASE_URL"))

    # --- default tenant quotas (MT-006), overridable per tenant -----------
    default_max_concurrent_jobs: int = field(default_factory=lambda: int(_env("AP_DEFAULT_MAX_CONCURRENT_JOBS", "5")))
    default_llm_tokens_per_month: int = field(default_factory=lambda: int(_env("AP_DEFAULT_LLM_TOKENS_PER_MONTH", "2000000")))

    # --- jobs -----------------------------------------------------------
    # Run a job worker thread inside the API process (local/dev). In the cloud,
    # workers are a separate deployment: ``python -m app.jobs.worker``.
    inline_worker: bool = field(default_factory=lambda: _env("AP_INLINE_WORKER", "1") == "1")

    # --- Phase 2 platform features ---------------------------------------
    # Platform operators (by login email) who may use /v1/platform/* views.
    platform_admin_emails: tuple[str, ...] = field(
        default_factory=lambda: tuple(e.strip().lower() for e in (_env("AP_PLATFORM_ADMIN_EMAILS", "") or "").split(",") if e.strip())
    )
    # LPA-006 circuit breaker defaults (tenants may override); off by default.
    llm_breaker_enabled: bool = field(default_factory=lambda: _env("AP_LLM_BREAKER_ENABLED") == "1")
    llm_breaker_failures: int = field(default_factory=lambda: int(_env("AP_LLM_BREAKER_FAILURES", "5")))
    llm_breaker_open_seconds: float = field(default_factory=lambda: float(_env("AP_LLM_BREAKER_OPEN_SECONDS", "30")))
    llm_health_window_seconds: float = field(default_factory=lambda: float(_env("AP_LLM_HEALTH_WINDOW_SECONDS", "900")))
    # NTF-002 email: console | smtp | memory. The SMTP password is the platform secret ``smtp-password``.
    email_sender: str = field(default_factory=lambda: _env("AP_EMAIL_SENDER", "console"))
    smtp_host: str | None = field(default_factory=lambda: _env("AP_SMTP_HOST"))
    smtp_port: int = field(default_factory=lambda: int(_env("AP_SMTP_PORT", "587")))
    smtp_username: str | None = field(default_factory=lambda: _env("AP_SMTP_USERNAME"))
    smtp_from: str = field(default_factory=lambda: _env("AP_SMTP_FROM", "Analytics Platform <no-reply@localhost>"))
    # MGT-004a: lifetime of OAuth client-credentials access tokens.
    oauth_token_ttl_seconds: int = field(default_factory=lambda: int(_env("AP_OAUTH_TOKEN_TTL", "900")))
    # OBS-004 cost attribution rates (USD).
    cost_compute_usd_per_second: float = field(default_factory=lambda: float(_env("AP_COST_COMPUTE_USD_PER_SECOND", "0.0001")))
    cost_storage_usd_per_gb_month: float = field(default_factory=lambda: float(_env("AP_COST_STORAGE_USD_PER_GB_MONTH", "0.023")))
    cost_api_usd_per_1k_requests: float = field(default_factory=lambda: float(_env("AP_COST_API_USD_PER_1K_REQUESTS", "0.01")))
    # --- connectors (ING-007) ---------------------------------------------
    # Platform-level SSRF allowlist (hostnames, "*.suffix" or CIDRs). Unlike a tenant admin's
    # allowlist it may also permit loopback / link-local hosts. Keep empty in multi-tenant production.
    connector_host_allowlist: tuple[str, ...] = field(
        default_factory=lambda: tuple(h.strip() for h in (_env("AP_CONNECTOR_HOST_ALLOWLIST", "") or "").split(",") if h.strip())
    )
    # SQLite database URLs as a connector source: tests and local development only.
    connector_allow_sqlite: bool = field(default_factory=lambda: _env("AP_CONNECTOR_ALLOW_SQLITE") == "1")
    connector_max_rows: int = field(default_factory=lambda: int(_env("AP_CONNECTOR_MAX_ROWS", "10000000")))
    connector_query_timeout_seconds: int = field(default_factory=lambda: int(_env("AP_CONNECTOR_QUERY_TIMEOUT", "600")))

    # --- Phase 3: scheduling & collaboration ------------------------------
    # Shortest allowed gap between two runs of one schedule.
    schedule_min_interval_minutes: int = field(default_factory=lambda: int(_env("AP_SCHEDULE_MIN_INTERVAL_MINUTES", "5")))
    # How often the worker (or ``python -m app.jobs.scheduler``) looks for due schedules; 0 disables it in the worker.
    scheduler_tick_seconds: float = field(default_factory=lambda: float(_env("AP_SCHEDULER_TICK_SECONDS", "30")))
    # Links in scheduled deliveries: the web app (dashboards) and the public API (public dashboard links).
    app_base_url: str = field(default_factory=lambda: (_env("AP_APP_BASE_URL", "http://localhost:3000") or "").rstrip("/"))
    api_base_url: str = field(default_factory=lambda: (_env("AP_API_BASE_URL", "http://localhost:8000") or "").rstrip("/"))
    delivery_link_ttl_hours: int = field(default_factory=lambda: int(_env("AP_DELIVERY_LINK_TTL_HOURS", "72")))
    # ING-008: a stream buffer is compacted into a new dataset version once it holds this many rows or bytes.
    stream_compact_rows: int = field(default_factory=lambda: int(_env("AP_STREAM_COMPACT_ROWS", "10000")))
    stream_compact_bytes: int = field(default_factory=lambda: int(_env("AP_STREAM_COMPACT_BYTES", str(16 * 1024 * 1024))))
    # ING-NFR-001: resumable uploads. Each PATCH carries at most this many bytes; idle sessions expire.
    upload_part_max_bytes: int = field(default_factory=lambda: int(_env("AP_UPLOAD_PART_MAX_BYTES", str(32 * 1024 * 1024))))
    upload_session_ttl_hours: int = field(default_factory=lambda: int(_env("AP_UPLOAD_SESSION_TTL_HOURS", "24")))


def load_settings() -> Settings:
    return Settings()


settings = load_settings()
