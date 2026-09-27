"""Incoming webhooks (WHK-002): signed POSTs that trigger batch prediction or dataset ingestion.

* Each hook has its own secret (secret store, shown once). Senders sign exactly like our outgoing
  webhooks: ``X-AP-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>``; timestamps older than
  five minutes and replayed signatures are rejected.
* Bodies are CSV (``text/csv``) or JSON (``[{...}]`` or ``{"rows": [{...}]}``), up to ``MAX_BODY_BYTES``.
* The request only validates, stores the rows (encrypted object store) and queues a job:
  ``predict`` → the existing ``serving.batch_predict`` job; ``ingest`` → ``inbound.ingest``, which appends
  the rows to (or replaces) the target dataset as a new immutable version.
"""

from __future__ import annotations

import io
import json
import secrets
import threading
import time
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import pandas as pd

from .db.models import InboundHook
from .jobs.core import JobContext, JobOut, JobService, PermanentJobError, job_handler
from .webhooks import verify_signature

if TYPE_CHECKING:  # pragma: no cover
    from .api.deps import AppState

MAX_BODY_BYTES = 50 * 1024 * 1024
MAX_ROWS = 1_000_000
TOLERANCE_SECONDS = 300
ACTIONS = ("predict", "ingest")


class InboundHookError(ValueError):
    """422: the payload or configuration is invalid."""


class SignatureError(PermissionError):
    """401: missing, invalid, stale or replayed signature."""


class _ReplayGuard:
    """Remembers signatures seen within the tolerance window (per process)."""

    def __init__(self) -> None:
        self._seen: dict[str, float] = {}
        self._lock = threading.Lock()

    def check_and_add(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            if len(self._seen) > 10_000:
                self._seen = {k: t for k, t in self._seen.items() if now - t < TOLERANCE_SECONDS * 2}
            if key in self._seen and now - self._seen[key] < TOLERANCE_SECONDS * 2:
                return False
            self._seen[key] = now
            return True


def secret_name(hook_id: str) -> str:
    return f"inbound-hook-{hook_id}"


def create_hook(state: AppState, tenant_id: str, actor: str, name: str, action: str, config: dict[str, Any]) -> tuple[InboundHook, str]:
    if action not in ACTIONS:
        raise InboundHookError(f"action must be one of {ACTIONS}")
    if action == "predict":
        from .serving.service import ServingService
        from .training.service import NotFound

        endpoint = config.get("endpoint")
        if not endpoint:
            raise InboundHookError("predict hooks need an endpoint name")
        try:
            ServingService(state).get(tenant_id, endpoint)
        except NotFound as exc:
            raise InboundHookError(f"unknown endpoint {endpoint!r}") from exc
        config = {"endpoint": endpoint}
    else:
        from .storage.datasets import DatasetNotFound

        dataset_id = config.get("dataset_id")
        mode = config.get("mode", "append")
        if mode not in ("append", "replace"):
            raise InboundHookError("mode must be append or replace")
        try:
            record = state.store.get(tenant_id, dataset_id or "")
        except DatasetNotFound as exc:
            raise InboundHookError("unknown dataset_id") from exc
        if len(record.tables) != 1:
            raise InboundHookError("ingest hooks need a single-table dataset")
        config = {"dataset_id": dataset_id, "mode": mode}
    secret = "whin_" + secrets.token_urlsafe(32)
    with state.db.session(tenant_id) as s:
        hook = InboundHook(tenant_id=tenant_id, name=name, action=action, config=config, secret_name="", created_by=actor)
        s.add(hook)
        s.flush()
        hook.secret_name = secret_name(hook.id)
        s.flush()
        s.expunge(hook)
    state.secrets.put(tenant_id, hook.secret_name, secret)
    return hook, secret


def parse_rows(body: bytes, content_type: str) -> pd.DataFrame:
    """CSV or JSON rows → DataFrame (validated, bounded)."""
    if not body:
        raise InboundHookError("empty body")
    ctype = (content_type or "").split(";", 1)[0].strip().lower()
    try:
        if ctype in ("text/csv", "application/csv"):
            frame = pd.read_csv(io.BytesIO(body))
        elif ctype in ("application/json", ""):
            data = json.loads(body)
            rows = data.get("rows") if isinstance(data, dict) else data
            if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
                raise InboundHookError('JSON bodies must be [{...}] or {"rows": [{...}]}')
            frame = pd.DataFrame.from_records(rows)
        else:
            raise InboundHookError("Content-Type must be text/csv or application/json")
    except (ValueError, pd.errors.ParserError) as exc:
        if isinstance(exc, InboundHookError):
            raise
        raise InboundHookError(f"could not parse the body: {exc}") from exc
    if frame.empty or len(frame.columns) == 0:
        raise InboundHookError("no rows")
    if len(frame) > MAX_ROWS:
        raise InboundHookError(f"at most {MAX_ROWS:,} rows per call")
    return frame


def trigger(state: AppState, tenant_id: str, hook_id: str, body: bytes, signature: str | None, content_type: str) -> JobOut:
    """Verify, store and queue. Raises LookupError (404), SignatureError (401) or InboundHookError (422)."""
    with state.db.session(tenant_id) as s:
        hook = s.get(InboundHook, hook_id)
        if hook is None or hook.tenant_id != tenant_id or not hook.active:
            raise LookupError(hook_id)
        action, config, name = hook.action, dict(hook.config), hook.secret_name
    secret = state.secrets.get(tenant_id, name)
    if not secret or not signature or not verify_signature(secret, body, signature, TOLERANCE_SECONDS):
        raise SignatureError("invalid or missing X-AP-Signature")
    guard = state.extras.setdefault("inbound_replay_guard", _ReplayGuard())
    if not guard.check_and_add(f"{hook_id}:{signature}"):
        raise SignatureError("replayed request")
    frame = parse_rows(body, content_type)
    key = f"inbound/{hook_id}/{uuid.uuid4().hex}.csv"
    state.objects.put_bytes(tenant_id, key, frame.to_csv(index=False).encode())
    actor = f"inbound:{hook_id}"
    jobs = JobService(state)
    if action == "predict":
        job = jobs.submit(tenant_id, "serving.batch_predict", {"endpoint": config["endpoint"], "input_key": key}, actor)
    else:
        job = jobs.submit(tenant_id, "inbound.ingest", {**config, "input_key": key, "hook_id": hook_id}, actor)
    with state.db.session(tenant_id) as s:
        s.get(InboundHook, hook_id).last_triggered_at = datetime.now(UTC)
    state.audit.record(tenant_id, actor, "inbound_hook.triggered", hook_id=hook_id, hook_action=action, rows=len(frame), job_id=job.id)
    return job


@job_handler("inbound.ingest")
def ingest_job(ctx: JobContext) -> dict:
    """WHK-002: append the posted rows to the dataset (or replace its contents) as a new immutable version."""
    from .datasets_io import MultiTableError, load_table
    from .storage.datasets import DatasetNotFound, DatasetTooLarge, QuotaExceeded

    p = ctx.params
    from .streams import STREAM_SOURCE, NotAStream, StreamError, StreamFull, append_records

    try:
        incoming = pd.read_csv(io.BytesIO(ctx.state.objects.get_bytes(ctx.tenant_id, p["input_key"])))
        record = ctx.state.store.get(ctx.tenant_id, p["dataset_id"])
        if record.source == STREAM_SOURCE:  # ING-008: stream targets buffer the rows as a micro-batch
            rows = incoming.astype(object).where(incoming.notna(), None).to_dict(orient="records")
            try:
                out = {}
                for start in range(0, len(rows), 10_000):
                    out = append_records(ctx.state, ctx.tenant_id, record.id, rows[start : start + 10_000], source=ctx.actor)
            except (NotAStream, StreamError, StreamFull) as exc:
                raise PermanentJobError(str(exc)) from exc
            return {**out, "dataset_id": record.id, "rows_added": len(rows), "buffered": True}
        table = record.tables[0].name
        if p.get("mode") == "replace":
            frame = incoming
        else:
            current = load_table(ctx.state.store, record)
            frame = pd.concat([current, incoming], ignore_index=True, sort=False)
        ctx.progress(0.5, f"{len(incoming):,} incoming rows")
        # Keep the confirmed schema only while the columns still match it exactly.
        schema = record.schema_
        if schema is not None and (not schema.entities or {f.name for f in schema.entities[0].fields} != set(frame.columns)):
            schema = None
        new = ctx.state.store.save_frames(ctx.tenant_id, ctx.actor, record.name, {table: frame}, schema, dataset_id=record.id)
    except (DatasetNotFound, DatasetTooLarge, QuotaExceeded, MultiTableError, KeyError) as exc:
        raise PermanentJobError(str(exc)) from exc
    return {"dataset_id": new.id, "version": new.version, "rows_added": len(incoming), "rows": len(frame)}
