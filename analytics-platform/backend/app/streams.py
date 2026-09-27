"""Streaming ingestion into append-only datasets (ING-008).

* A *stream* is a dataset with ``source = "stream"``. Clients push micro-batches of JSON rows
  (``POST /v1/streams/{id}/records`` with an API key holding ``data.write``, or through a tenant inbound hook
  whose target is the stream). Each batch is validated, written to the encrypted object store as JSON Lines and
  recorded in ``stream_batches``; nothing is rewritten on the request path.
* A ``stream.compact`` job folds the buffered batches into the next immutable dataset version. It is queued
  automatically once the buffer holds ``compact_rows`` rows or ``compact_bytes`` bytes, can be scheduled
  (job type ``stream.compact``) and can be requested on demand.
* Compaction is safe with several workers: the stream row is locked with a conditional UPDATE on
  ``compacting_job_id`` and each batch is claimed with ``claimed_by``.
* D3 / MT-007: the 1 GB dataset cap is enforced on the way in. Once the stored version plus the buffer would
  exceed it, new records are rejected (HTTP 413) with an explanation.
"""

from __future__ import annotations

import json
import math
import numbers
import uuid
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

import pandas as pd
from sqlalchemy import or_, select, update

from .db.models import StreamBatch, StreamState
from .jobs.core import JobContext, JobService, PermanentJobError, job_handler

if TYPE_CHECKING:  # pragma: no cover
    from .api.deps import AppState

MAX_RECORDS_PER_BATCH = 10_000
MAX_BATCH_BYTES = 10 * 1024 * 1024
MAX_COLUMNS = 1000
STALE_LOCK = timedelta(hours=1)
STREAM_SOURCE = "stream"


class StreamError(ValueError):
    """422: invalid records or configuration."""


class StreamFull(ValueError):
    """413: the stream reached the dataset size cap."""


class NotAStream(LookupError):
    """404: the dataset doesn't exist or isn't a stream."""


def _scalar(value: Any) -> bool:
    if isinstance(value, float):
        return math.isfinite(value)
    return value is None or isinstance(value, (str, int, bool))


def validate_records(records: Any) -> list[dict[str, Any]]:
    if not isinstance(records, list) or not records:
        raise StreamError("records must be a non-empty list of objects")
    if len(records) > MAX_RECORDS_PER_BATCH:
        raise StreamError(f"at most {MAX_RECORDS_PER_BATCH:,} records per batch")
    columns: set[str] = set()
    for i, rec in enumerate(records):
        if not isinstance(rec, dict) or not rec:
            raise StreamError(f"record {i} must be a non-empty JSON object")
        for key, value in rec.items():
            if not isinstance(key, str) or not key or len(key) > 128:
                raise StreamError(f"record {i}: column names must be 1-128 character strings")
            if not _scalar(value):
                raise StreamError(f"record {i}: {key!r} must be a string, number, boolean or null (nested values aren't supported)")
            columns.add(key)
    if len(columns) > MAX_COLUMNS:
        raise StreamError(f"at most {MAX_COLUMNS} columns")
    return records


def create_stream(
    state: AppState,
    tenant_id: str,
    actor: str,
    name: str,
    *,
    project_id: str,
    columns: list[str] | None = None,
    compact_rows: int | None = None,
    compact_bytes: int | None = None,
):
    """Create an empty stream dataset (version 1 holds the declared columns, if any)."""
    frame = pd.DataFrame({c: pd.Series([], dtype="object") for c in columns or []})
    record = state.store.save_frames(tenant_id, actor, name, {"records": frame}, None, source=STREAM_SOURCE, project_id=project_id)
    with state.db.session(tenant_id) as s:
        s.add(
            StreamState(
                dataset_id=record.id,
                tenant_id=tenant_id,
                compact_rows=compact_rows or state.settings.stream_compact_rows,
                compact_bytes=compact_bytes or state.settings.stream_compact_bytes,
                created_by=actor,
            )
        )
    return record


def _state_row(s, tenant_id: str, dataset_id: str) -> StreamState:
    row = s.get(StreamState, dataset_id)
    if row is None or row.tenant_id != tenant_id:
        raise NotAStream(dataset_id)
    return row


def is_stream(state: AppState, tenant_id: str, dataset_id: str) -> bool:
    with state.db.session(tenant_id) as s:
        row = s.get(StreamState, dataset_id)
        return row is not None and row.tenant_id == tenant_id


def status(state: AppState, tenant_id: str, dataset_id: str) -> dict[str, Any]:
    record = state.store.get(tenant_id, dataset_id)
    with state.db.session(tenant_id) as s:
        row = _state_row(s, tenant_id, dataset_id)
        pending = s.execute(select(StreamBatch.id).where(StreamBatch.tenant_id == tenant_id, StreamBatch.dataset_id == dataset_id)).all()
        return {
            "dataset_id": dataset_id,
            "name": record.name,
            "version": record.latest_version,
            "stored_bytes": record.size_bytes,
            "stored_rows": sum(t.row_count or 0 for t in record.tables),
            "buffered_rows": row.buffered_rows,
            "buffered_bytes": row.buffered_bytes,
            "buffered_batches": len(pending),
            "compact_rows": row.compact_rows,
            "compact_bytes": row.compact_bytes,
            "max_dataset_bytes": state.store.max_dataset_bytes,
            "compacting_job_id": row.compacting_job_id,
            "last_compacted_at": row.last_compacted_at,
        }


def append_records(state: AppState, tenant_id: str, dataset_id: str, records: Any, *, source: str) -> dict[str, Any]:
    """Buffer one micro-batch. Raises NotAStream, StreamError (422) or StreamFull (413)."""
    record = state.store.get(tenant_id, dataset_id)
    if record.source != STREAM_SOURCE or not is_stream(state, tenant_id, dataset_id):
        raise NotAStream(dataset_id)
    rows = validate_records(records)
    payload = "".join(json.dumps(r, separators=(",", ":"), ensure_ascii=False) + "\n" for r in rows).encode()
    if len(payload) > MAX_BATCH_BYTES:
        raise StreamError(f"a batch may be at most {MAX_BATCH_BYTES // 1024**2} MB")
    limit = state.store.max_dataset_bytes
    with state.db.session(tenant_id) as s:
        buffered = _state_row(s, tenant_id, dataset_id).buffered_bytes
    if record.size_bytes + buffered + len(payload) > limit:
        state.audit.record(tenant_id, source, "stream.rejected", dataset_id=dataset_id, reason="size_cap")
        raise StreamFull(
            f"stream {dataset_id} has reached the {limit / 1024**3:g} GB dataset limit "
            f"({record.size_bytes + buffered:,} bytes stored or buffered); no more records are accepted. "
            "Create a new stream, or archive and delete old data."
        )
    key = f"streams/{dataset_id}/buffer/{datetime.now(UTC):%Y%m%dT%H%M%S%f}-{uuid.uuid4().hex[:8]}.jsonl"
    state.objects.put_bytes(tenant_id, key, payload)
    with state.db.session(tenant_id) as s:
        s.add(
            StreamBatch(tenant_id=tenant_id, dataset_id=dataset_id, object_key=key, rows=len(rows), size_bytes=len(payload), source=source)
        )
        s.execute(
            update(StreamState)
            .where(StreamState.dataset_id == dataset_id, StreamState.tenant_id == tenant_id)
            .values(buffered_rows=StreamState.buffered_rows + len(rows), buffered_bytes=StreamState.buffered_bytes + len(payload))
            .execution_options(synchronize_session=False)
        )
    with state.db.session(tenant_id) as s:
        row = _state_row(s, tenant_id, dataset_id)
        out = {"dataset_id": dataset_id, "accepted": len(rows), "buffered_rows": row.buffered_rows, "buffered_bytes": row.buffered_bytes}
        due = row.buffered_rows >= row.compact_rows or row.buffered_bytes >= row.compact_bytes
    if due:
        out["compaction_job_id"] = request_compaction(state, tenant_id, dataset_id, "system")
    return out


def request_compaction(state: AppState, tenant_id: str, dataset_id: str, actor: str) -> str | None:
    """Queue a compaction unless one is already queued or running. Returns the job id (new or in flight)."""
    now = datetime.now(UTC)
    with state.db.session(tenant_id) as s:
        row = _state_row(s, tenant_id, dataset_id)
        since = (
            row.compacting_since.replace(tzinfo=UTC) if row.compacting_since and not row.compacting_since.tzinfo else row.compacting_since
        )
        if row.compacting_job_id and since and now - since < STALE_LOCK:
            return row.compacting_job_id
    job = JobService(state).submit(tenant_id, "stream.compact", {"dataset_id": dataset_id}, actor)
    with state.db.session(tenant_id) as s:
        taken = s.execute(
            update(StreamState)
            .where(
                StreamState.dataset_id == dataset_id,
                StreamState.tenant_id == tenant_id,
                or_(StreamState.compacting_job_id.is_(None), StreamState.compacting_since < now - STALE_LOCK),
            )
            .values(compacting_job_id=job.id, compacting_since=now)
            .execution_options(synchronize_session=False)
        ).rowcount
    return job.id if taken else None


def _lock(state: AppState, tenant_id: str, dataset_id: str, job_id: str) -> bool:
    now = datetime.now(UTC)
    with state.db.session(tenant_id) as s:
        return (
            s.execute(
                update(StreamState)
                .where(
                    StreamState.dataset_id == dataset_id,
                    StreamState.tenant_id == tenant_id,
                    or_(
                        StreamState.compacting_job_id.is_(None),
                        StreamState.compacting_job_id == job_id,
                        StreamState.compacting_since < now - STALE_LOCK,
                    ),
                )
                .values(compacting_job_id=job_id, compacting_since=now)
                .execution_options(synchronize_session=False)
            ).rowcount
            == 1
        )


def _unlock(state: AppState, tenant_id: str, dataset_id: str, job_id: str, **values: Any) -> None:
    with state.db.session(tenant_id) as s:
        s.execute(
            update(StreamState)
            .where(StreamState.dataset_id == dataset_id, StreamState.tenant_id == tenant_id, StreamState.compacting_job_id == job_id)
            .values(compacting_job_id=None, compacting_since=None, **values)
            .execution_options(synchronize_session=False)
        )


def _kind(value: Any) -> str:
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, numbers.Number):
        return "number"
    return type(value).__name__


def _harmonize(frame: pd.DataFrame) -> pd.DataFrame:
    """Columns whose values mix kinds (e.g. 1 and "1" across batches) are stored as strings."""
    for col in frame.columns:
        if frame[col].dtype == object:
            kinds = {_kind(v) for v in frame[col] if v is not None}
            if len(kinds) > 1:
                frame[col] = frame[col].map(lambda v: None if v is None else str(v))
    return frame


def compact(state: AppState, tenant_id: str, dataset_id: str, job_id: str, actor: str) -> dict[str, Any]:
    from .datasets_io import load_table
    from .ingestion.formats import UnsupportedFormatError
    from .storage.datasets import DatasetTooLarge, QuotaExceeded

    if not is_stream(state, tenant_id, dataset_id):
        raise NotAStream(dataset_id)
    if not _lock(state, tenant_id, dataset_id, job_id):
        return {"dataset_id": dataset_id, "skipped": "another compaction is running"}
    try:
        with state.db.session(tenant_id) as s:
            # The stream lock makes this job the only compactor, so it also takes over batches left claimed by a
            # compaction that crashed.
            s.execute(
                update(StreamBatch)
                .where(StreamBatch.tenant_id == tenant_id, StreamBatch.dataset_id == dataset_id)
                .values(claimed_by=job_id)
                .execution_options(synchronize_session=False)
            )
            batches = [
                (b.id, b.object_key, b.rows, b.size_bytes)
                for b in s.execute(
                    select(StreamBatch)
                    .where(StreamBatch.tenant_id == tenant_id, StreamBatch.dataset_id == dataset_id, StreamBatch.claimed_by == job_id)
                    .order_by(StreamBatch.created_at, StreamBatch.id)
                ).scalars()
            ]
        if not batches:
            _unlock(state, tenant_id, dataset_id, job_id)
            return {"dataset_id": dataset_id, "rows_added": 0}
        record = state.store.get(tenant_id, dataset_id)
        incoming = []
        for _, key, _, _ in batches:
            lines = state.objects.get_bytes(tenant_id, key).decode().splitlines()
            incoming.append(pd.DataFrame.from_records([json.loads(line) for line in lines if line]))
        new_rows = pd.concat(incoming, ignore_index=True, sort=False)
        if record.tables[0].row_count == 0:
            try:
                current = load_table(state.store, record)
            except UnsupportedFormatError:  # a stream created without columns has a column-less first version
                current = pd.DataFrame()
        else:
            current = load_table(state.store, record)
        frame = new_rows if current.empty and len(current.columns) == 0 else pd.concat([current, new_rows], ignore_index=True, sort=False)
        frame = _harmonize(frame.astype(object).where(frame.notna(), None) if len(frame) else frame)
        schema = record.schema_
        if schema is not None and (not schema.entities or {f.name for f in schema.entities[0].fields} != set(frame.columns)):
            schema = None
        new = state.store.save_frames(tenant_id, actor, record.name, {record.tables[0].name: frame}, schema, dataset_id=dataset_id)
    except Exception as exc:
        with state.db.session(tenant_id) as s:  # give the batches back; they stay buffered for the next compaction
            s.execute(
                update(StreamBatch)
                .where(StreamBatch.tenant_id == tenant_id, StreamBatch.claimed_by == job_id)
                .values(claimed_by=None)
                .execution_options(synchronize_session=False)
            )
        _unlock(state, tenant_id, dataset_id, job_id)
        if isinstance(exc, (DatasetTooLarge, QuotaExceeded)):
            raise StreamFull(f"compaction would exceed a limit: {exc}") from exc
        raise
    rows = sum(b[2] for b in batches)
    size = sum(b[3] for b in batches)
    with state.db.session(tenant_id) as s:
        for batch_id, _, _, _ in batches:
            batch = s.get(StreamBatch, batch_id)
            if batch is not None:
                s.delete(batch)
        s.execute(
            update(StreamState)
            .where(StreamState.dataset_id == dataset_id, StreamState.tenant_id == tenant_id)
            .values(buffered_rows=StreamState.buffered_rows - rows, buffered_bytes=StreamState.buffered_bytes - size)
            .execution_options(synchronize_session=False)
        )
    _unlock(state, tenant_id, dataset_id, job_id, last_compacted_at=datetime.now(UTC), total_rows=len(frame))
    for _, key, _, _ in batches:
        try:
            state.objects.delete(tenant_id, key)
        except LookupError:
            pass
    state.audit.record(
        tenant_id, actor, "stream.compacted", dataset_id=dataset_id, version=new.version, rows_added=rows, batches=len(batches)
    )
    return {"dataset_id": dataset_id, "version": new.version, "rows_added": rows, "rows": len(frame), "batches": len(batches)}


@job_handler("stream.compact")
def compact_job(ctx: JobContext) -> dict:
    """ING-008: fold buffered micro-batches into the stream's next dataset version."""
    from .storage.datasets import DatasetNotFound

    try:
        return compact(ctx.state, ctx.tenant_id, ctx.params["dataset_id"], ctx.job_id, ctx.actor)
    except (NotAStream, DatasetNotFound, StreamFull, KeyError) as exc:
        raise PermanentJobError(str(exc)) from exc
