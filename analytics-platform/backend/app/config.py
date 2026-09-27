"""Runtime settings, read from environment variables prefixed ``AP_``."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

GB = 1024**3


@dataclass(frozen=True)
class Settings:
    # D3: 1 GB per dataset, enforced at every entry point (MT-007).
    max_dataset_bytes: int = int(os.environ.get("AP_MAX_DATASET_BYTES", GB))
    # MT-006 default storage quota per tenant.
    tenant_storage_quota_bytes: int = int(os.environ.get("AP_TENANT_STORAGE_QUOTA_BYTES", 10 * GB))
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("AP_DATA_DIR", "./.data")).resolve())
    # Above this many rows, generation should run as an async job (SCH-NFR-005).
    sync_generation_row_limit: int = int(os.environ.get("AP_SYNC_GENERATION_ROW_LIMIT", 100_000))
    # ING-NFR-002: schema inference samples instead of scanning whole files.
    inference_head_rows: int = 10_000
    inference_reservoir_rows: int = 50_000
    query_row_limit: int = 10_000
    query_timeout_seconds: float = 30.0


settings = Settings()
