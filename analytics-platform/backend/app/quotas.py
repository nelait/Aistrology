"""Tenant quotas (MT-006): storage, concurrent heavy jobs, platform-LLM tokens per month."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select

from .db.models import Job, Tenant

if TYPE_CHECKING:  # pragma: no cover
    from .api.deps import AppState

# Job types that consume significant compute and count towards max_concurrent_jobs.
HEAVY_JOBS = {"training.run", "data.generate", "serving.batch_predict", "pipeline.apply", "tenant.export", "dataset.profile"}


class QuotaExceededError(Exception):
    def __init__(self, quota: str, limit: Any, message: str):
        self.quota = quota
        self.limit = limit
        super().__init__(message)


def quotas_for(state: AppState, tenant_id: str) -> dict[str, int]:
    defaults = {
        "storage_bytes": state.settings.tenant_storage_quota_bytes,
        "max_concurrent_jobs": state.settings.default_max_concurrent_jobs,
        "llm_tokens_per_month": state.settings.default_llm_tokens_per_month,
    }
    with state.db.session(tenant_id) as s:
        tenant = s.get(Tenant, tenant_id)
        overrides = dict(tenant.quotas or {}) if tenant else {}
    return {**defaults, **{k: int(v) for k, v in overrides.items() if k in defaults}}


def check_job_quota(state: AppState, tenant_id: str, job_type: str) -> None:
    if job_type not in HEAVY_JOBS:
        return
    limit = quotas_for(state, tenant_id)["max_concurrent_jobs"]
    with state.db.session(tenant_id) as s:
        active = s.execute(
            select(func.count())
            .select_from(Job)
            .where(Job.tenant_id == tenant_id, Job.type.in_(HEAVY_JOBS), Job.status.in_(("queued", "running")))
        ).scalar_one()
    if active >= limit:
        raise QuotaExceededError(
            "max_concurrent_jobs", limit, f"{active} jobs are already queued or running (limit {limit}); wait for one to finish"
        )


def platform_tokens_this_month(state: AppState, tenant_id: str) -> int:
    since = datetime.now(UTC).strftime("%Y-%m-01")
    totals = state.metering.totals(tenant_id, metric_prefix="llm.tokens.", since=since)
    return int(sum(v for metric in totals.values() for key, v in metric.items() if key.startswith("platform:")))


def check_platform_llm_quota(state: AppState, tenant_id: str) -> None:
    limit = quotas_for(state, tenant_id)["llm_tokens_per_month"]
    used = platform_tokens_this_month(state, tenant_id)
    if used >= limit:
        raise QuotaExceededError(
            "llm_tokens_per_month",
            limit,
            f"the monthly allowance of {limit:,} platform LLM tokens is used up; add your own provider key (BYOK)",
        )
