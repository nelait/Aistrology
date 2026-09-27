"""Per-tenant retention policies (SOC-PRV-002; defaults from REQUIREMENTS Appendix B).

| Data | Default | What happens when it expires |
|------|---------|------------------------------|
| LLM prompt/response bodies | 30 days | ``prompt_excerpt``/``error`` in ``llm.call`` audit entries are replaced by their hash commitment |
| LLM metadata and usage counters | 13 months | Usage counter rows are deleted |
| Audit log | 13 months | The oldest entries are deleted; the chain continues from a stored anchor |
| Inference request logs | 30 days | Prediction log rows are deleted |
| Raw uploads and dataset versions | until deleted | Files are removed when the user deletes the dataset |
| Backups | 30 days | Set by the database backup configuration (Terraform), not here |

Redacting LLM bodies keeps the audit chain verifiable, because the chain hashes commitments of those fields
(see ``app.audit.REDACTABLE``). Deleting a prefix of the chain stores the last deleted entry as the anchor that
verification starts from. The periodic WORM export is what preserves entries past their retention.

Run for every tenant with ``python -m app.retention`` (the Helm chart schedules it daily), or for one
organization through ``POST /v1/tenant/retention/apply``.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field
from sqlalchemy import delete, select

if TYPE_CHECKING:  # pragma: no cover
    from .api.deps import AppState

log = logging.getLogger("app.retention")

SETTING = "retention"
BATCH = 1000


class RetentionPolicy(BaseModel):
    llm_bodies_days: int = Field(default=30, ge=1, le=400)
    llm_metadata_days: int = Field(default=395, ge=90, le=3650)
    # At least a year: the SOC 2 Type II observation window must stay covered.
    audit_days: int = Field(default=395, ge=365, le=3650)
    inference_logs_days: int = Field(default=30, ge=1, le=400)


def get_policy(state: AppState, tenant_id: str) -> RetentionPolicy:
    return RetentionPolicy.model_validate(state.get_setting(tenant_id, SETTING) or {})


def put_policy(state: AppState, tenant_id: str, policy: RetentionPolicy) -> None:
    state.put_setting(tenant_id, SETTING, policy.model_dump())


def _iso(ts: datetime) -> str:
    return ts.astimezone(UTC).isoformat()


def _redact_llm_bodies(state: AppState, tenant_id: str, cutoff: datetime) -> int:
    from .audit import redacted
    from .db.models import AuditRecord

    count = 0
    with state.db.session(tenant_id) as s:
        rows = s.scalars(
            select(AuditRecord).where(AuditRecord.tenant_id == tenant_id, AuditRecord.action == "llm.call", AuditRecord.at < _iso(cutoff))
        ).all()
        for row in rows:
            keys = [k for k in (row.detail or {}).get("_redactable", []) if k in row.detail]
            if not keys or all(isinstance(row.detail[k], dict) and row.detail[k].get("redacted") for k in keys):
                continue
            row.detail = {**row.detail, **{k: redacted(row.detail[k]) for k in keys}}
            count += 1
    return count


def _expire_audit(state: AppState, tenant_id: str, cutoff: datetime) -> int:
    from .db.models import AuditRecord, TenantSetting

    with state.db.session(tenant_id) as s:
        last = s.execute(
            select(AuditRecord.seq, AuditRecord.hash)
            .where(AuditRecord.tenant_id == tenant_id, AuditRecord.at < _iso(cutoff))
            .order_by(AuditRecord.seq.desc())
            .limit(1)
        ).first()
        if last is None:
            return 0
        deleted = s.execute(delete(AuditRecord).where(AuditRecord.tenant_id == tenant_id, AuditRecord.seq <= last.seq)).rowcount
        anchor = {"seq": last.seq, "hash": last.hash, "at": _iso(datetime.now(UTC))}
        row = s.get(TenantSetting, (tenant_id, "audit_anchor"))
        if row is None:
            s.add(TenantSetting(tenant_id=tenant_id, key="audit_anchor", value=anchor))
        else:
            row.value = anchor
    return deleted


def _delete_usage(state: AppState, tenant_id: str, cutoff: datetime) -> int:
    from .db.models import UsageCounter

    with state.db.session(tenant_id) as s:
        return s.execute(
            delete(UsageCounter).where(UsageCounter.tenant_id == tenant_id, UsageCounter.day < cutoff.strftime("%Y-%m-%d"))
        ).rowcount


def _delete_prediction_logs(state: AppState, tenant_id: str, cutoff: datetime) -> int:
    from .db.models import PredictionLog

    with state.db.session(tenant_id) as s:
        return s.execute(delete(PredictionLog).where(PredictionLog.tenant_id == tenant_id, PredictionLog.at < cutoff)).rowcount


def apply_retention(state: AppState, tenant_id: str, now: datetime | None = None) -> dict[str, Any]:
    """Apply the tenant's policy once. Idempotent; returns what was removed or redacted."""
    now = now or datetime.now(UTC)
    policy = get_policy(state, tenant_id)
    result = {
        "llm_bodies_redacted": _redact_llm_bodies(state, tenant_id, now - timedelta(days=policy.llm_bodies_days)),
        "usage_rows_deleted": _delete_usage(state, tenant_id, now - timedelta(days=policy.llm_metadata_days)),
        "prediction_logs_deleted": _delete_prediction_logs(state, tenant_id, now - timedelta(days=policy.inference_logs_days)),
        "audit_entries_deleted": _expire_audit(state, tenant_id, now - timedelta(days=policy.audit_days)),
    }
    if any(result.values()):
        state.audit.record(tenant_id, "system", "retention.applied", policy=policy.model_dump(), **result)
    return result


def sweep(state: AppState, now: datetime | None = None) -> dict[str, dict[str, Any]]:
    """Apply retention for every active tenant; one failing tenant does not stop the others."""
    from .db.models import Tenant

    with state.db.session() as s:
        tenants = s.scalars(select(Tenant.id)).all()
    results: dict[str, dict[str, Any]] = {}
    for tenant_id in tenants:
        try:
            results[tenant_id] = apply_retention(state, tenant_id, now)
        except Exception:  # noqa: BLE001
            log.exception("retention failed for tenant %s", tenant_id)
    return results


def main() -> None:  # pragma: no cover - thin CLI wrapper
    import json

    from .api.deps import build_state

    logging.basicConfig(level=logging.INFO)
    results = sweep(build_state())
    changed = {t: r for t, r in results.items() if any(r.values())}
    print(json.dumps({"tenants": len(results), "changed": changed}))


if __name__ == "__main__":  # pragma: no cover
    main()
