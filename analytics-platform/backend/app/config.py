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

    # --- jobs -----------------------------------------------------------
    # Run a job worker thread inside the API process (local/dev). In the cloud,
    # workers are a separate deployment: ``python -m app.jobs.worker``.
    inline_worker: bool = field(default_factory=lambda: _env("AP_INLINE_WORKER", "1") == "1")


def load_settings() -> Settings:
    return Settings()


settings = load_settings()
