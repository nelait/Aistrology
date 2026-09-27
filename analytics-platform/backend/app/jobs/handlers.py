"""Job handlers for data work. Importing this module registers them.

Model training and batch prediction handlers live next to their modules and
are registered through the imports at the bottom.
"""

from __future__ import annotations

import io
import json
import zipfile
from datetime import UTC, datetime

from sqlalchemy import select

from ..cleaning.service import PipelineService
from ..cleaning.steps import StepError
from ..db.models import AuditRecord, Dataset, User
from ..generation.generator import GenerationError, GenerationOptions, GenerationTooLarge, check_size, generate
from ..profiling.profile import profile_frame
from ..schema.model import Schema, SchemaValidationError
from ..storage.datasets import DatasetNotFound, DatasetTooLarge, QuotaExceeded
from .core import JobContext, PermanentJobError, job_handler

_PERMANENT = (
    StepError,
    DatasetNotFound,
    DatasetTooLarge,
    QuotaExceeded,
    SchemaValidationError,
    GenerationError,
    GenerationTooLarge,
    KeyError,
)


@job_handler("data.generate")
def generate_job(ctx: JobContext) -> dict:
    """SCH-NFR-005: large sample-data generation runs asynchronously."""
    try:
        schema = Schema.model_validate(ctx.params["schema"])
        options = GenerationOptions.model_validate(ctx.params.get("options", {}))
        ctx.progress(0.05, "estimating size")
        estimate = check_size(schema, options)
        ctx.progress(0.1, "generating")
        frames = generate(schema, options)
        ctx.check_cancelled()
        ctx.progress(0.8, "saving")
        record = ctx.state.store.save_frames(ctx.tenant_id, ctx.actor, ctx.params.get("name") or schema.name, frames, schema)
    except _PERMANENT as exc:
        raise PermanentJobError(str(exc)) from exc
    return {"dataset_id": record.id, "rows": {k: len(v) for k, v in frames.items()}, "estimated_bytes": estimate}


@job_handler("dataset.profile")
def profile_job(ctx: JobContext) -> dict:
    from ..datasets_io import load_table

    try:
        record = ctx.state.store.get(ctx.tenant_id, ctx.params["dataset_id"], ctx.params.get("version"))
        profile = profile_frame(load_table(ctx.state.store, record), record.schema_)
    except _PERMANENT as exc:
        raise PermanentJobError(str(exc)) from exc
    ctx.state.store.set_profile(record, profile.model_dump(mode="json"))
    return {"dataset_id": record.id, "version": record.version, "quality_score": profile.quality.score}


@job_handler("pipeline.apply")
def apply_pipeline_job(ctx: JobContext) -> dict:
    try:
        return PipelineService(ctx.state).apply(ctx.tenant_id, ctx.actor, ctx.params["pipeline_id"], progress=ctx.progress)
    except _PERMANENT as exc:
        raise PermanentJobError(str(exc)) from exc


@job_handler("tenant.export")
def export_tenant_job(ctx: JobContext) -> dict:
    """SOC-PRV-003 / GDPR: export the tenant's data (metadata, users, audit log, dataset files) as a zip."""
    state = ctx.state
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf, state.db.session(ctx.tenant_id) as s:
        users = s.execute(select(User).where(User.tenant_id == ctx.tenant_id)).scalars()
        zf.writestr(
            "users.json",
            json.dumps(
                [{"id": u.id, "email": u.email, "name": u.name, "role": u.role, "created_at": u.created_at} for u in users], default=str
            ),
        )
        audit = s.execute(select(AuditRecord).where(AuditRecord.tenant_id == ctx.tenant_id).order_by(AuditRecord.seq)).scalars()
        zf.writestr(
            "audit_log.jsonl",
            "".join(json.dumps({"seq": a.seq, "at": a.at, "actor": a.actor, "action": a.action, "detail": a.detail}) + "\n" for a in audit),
        )
        datasets = s.execute(select(Dataset).where(Dataset.tenant_id == ctx.tenant_id, Dataset.deleted_at.is_(None))).scalars().all()
        ids = [d.id for d in datasets]
    records = []
    for i, dataset_id in enumerate(ids):
        for record in state.store.versions(ctx.tenant_id, dataset_id):
            records.append(record.model_dump(mode="json"))
            for table in record.tables:
                path = state.store.table_path(record, table)
                with zipfile.ZipFile(buf, "a") as zf:
                    zf.write(path, f"datasets/{dataset_id}/v{record.version}/{path.name}")
        ctx.progress((i + 1) / max(1, len(ids)) * 0.9, f"exported {i + 1}/{len(ids)} datasets")
    with zipfile.ZipFile(buf, "a") as zf:
        zf.writestr("datasets.json", json.dumps(records))
        zf.writestr("README.txt", f"Data export for tenant {ctx.tenant_id}, generated {datetime.now(UTC).isoformat()}.\n")
    key = f"exports/{ctx.job_id}.zip"
    state.objects.put_bytes(ctx.tenant_id, key, buf.getvalue())
    return {"export_key": key, "size_bytes": len(buf.getvalue()), "datasets": len(ids)}


# Register handlers that live with their modules.
from ..connectors import jobs as _connector_jobs  # noqa: E402,F401
from ..serving import jobs as _serving_jobs  # noqa: E402,F401
from ..training import jobs as _training_jobs  # noqa: E402,F401
