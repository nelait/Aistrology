"""``connector.import`` job handler (ING-007). Registered on import (see ``app.jobs.handlers``)."""

from __future__ import annotations

from ..ingestion.formats import UnsupportedFormatError
from ..jobs.core import JobContext, PermanentJobError, job_handler
from ..quotas import HEAVY_JOBS
from ..storage.datasets import DatasetNotFound, DatasetTooLarge, QuotaExceeded
from .service import ConnectorError, ConnectorService

HEAVY_JOBS.add("connector.import")  # counts against max_concurrent_jobs (MT-006)

_PERMANENT = (ConnectorError, DatasetTooLarge, QuotaExceeded, DatasetNotFound, UnsupportedFormatError, LookupError, ValueError)


@job_handler("connector.import")
def connector_import_job(ctx: JobContext) -> dict:
    """Pull data from an external source into a new dataset, then infer its schema."""
    from ..api.datasets import infer_record

    service = ConnectorService(ctx.state)
    ctx.progress(0.02, "connecting")
    try:
        record = service.run_import(ctx.tenant_id, ctx.actor, ctx.params["connector_id"], ctx.params, progress=ctx.progress)
    except _PERMANENT as exc:
        raise PermanentJobError(str(exc)) from exc
    warnings = list(service.notes)
    try:
        inference = infer_record(ctx.state, record)
        record = ctx.state.store.update_schema(record, inference.schema_)
        warnings += inference.warnings
    except UnsupportedFormatError as exc:
        warnings.append(f"schema inference failed: {exc}")
    ctx.state.audit.record(
        ctx.tenant_id,
        ctx.actor,
        "connector.import",
        connector_id=ctx.params["connector_id"],
        dataset_id=record.id,
        size_bytes=record.size_bytes,
    )
    return {
        "dataset_id": record.id,
        "version": record.version,
        "tables": [{"name": t.name, "row_count": t.row_count, "size_bytes": t.size_bytes} for t in record.tables],
        "warnings": warnings[:50],
    }
