"""Streaming ingestion into append-only datasets (ING-008)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..auth.rbac import Permission
from ..auth.service import Principal
from ..jobs.core import JobOut, JobService
from ..storage.datasets import DatasetNotFound, DatasetRecord, QuotaExceeded
from ..streams import MAX_BATCH_BYTES, NotAStream, StreamError, StreamFull, append_records, create_stream, request_compaction, status
from .datasets import _target_project
from .deps import AppState, StateDep, guard_dataset, require

router = APIRouter(prefix="/v1/streams", tags=["datasets"])
Reader = require(Permission.READ_DATA)
Writer = require(Permission.WRITE_DATA)


class StreamCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    project_id: str | None = Field(default=None, max_length=40)
    columns: list[str] = Field(default_factory=list, max_length=1000, description="Optional initial columns")
    compact_rows: int | None = Field(default=None, ge=1, le=10_000_000)
    compact_bytes: int | None = Field(default=None, ge=1024, le=1024**3)


def _errors(exc: Exception) -> HTTPException:
    if isinstance(exc, (NotAStream, DatasetNotFound)):
        return HTTPException(status_code=404, detail="stream not found")
    if isinstance(exc, StreamFull):
        return HTTPException(status_code=413, detail={"code": "dataset_size_limit", "message": str(exc)})
    if isinstance(exc, QuotaExceeded):
        return HTTPException(status_code=507, detail=str(exc))
    return HTTPException(status_code=422, detail=str(exc))


@router.post("", response_model=DatasetRecord, status_code=201)
async def create(body: StreamCreate, state: AppState = StateDep, principal: Principal = Writer) -> DatasetRecord:
    project_id = _target_project(state, principal, body.project_id)
    if len(set(body.columns)) != len(body.columns) or any(not c or len(c) > 128 for c in body.columns):
        raise HTTPException(status_code=422, detail="columns must be unique 1-128 character names")
    try:
        record = await asyncio.to_thread(
            create_stream,
            state,
            principal.tenant_id,
            principal.user_id,
            body.name,
            project_id=project_id,
            columns=body.columns,
            compact_rows=body.compact_rows,
            compact_bytes=body.compact_bytes,
        )
    except QuotaExceeded as exc:
        raise _errors(exc) from exc
    state.audit.record(principal.tenant_id, principal.user_id, "stream.create", dataset_id=record.id, project_id=project_id)
    return record


@router.get("/{dataset_id}")
async def get_stream(dataset_id: str, state: AppState = StateDep, principal: Principal = Reader) -> dict[str, Any]:
    guard_dataset(state, principal, dataset_id)
    try:
        return await asyncio.to_thread(status, state, principal.tenant_id, dataset_id)
    except (NotAStream, DatasetNotFound) as exc:
        raise _errors(exc) from exc


@router.post("/{dataset_id}/records", status_code=202)
async def push_records(dataset_id: str, request: Request, state: AppState = StateDep, principal: Principal = Writer) -> dict[str, Any]:
    """Append a micro-batch: ``{"records": [{...}, ...]}`` or ``[{...}, ...]`` (flat JSON objects)."""
    guard_dataset(state, principal, dataset_id)
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BATCH_BYTES:
        raise HTTPException(status_code=413, detail=f"a batch may be at most {MAX_BATCH_BYTES // 1024**2} MB")
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > MAX_BATCH_BYTES:
            raise HTTPException(status_code=413, detail=f"a batch may be at most {MAX_BATCH_BYTES // 1024**2} MB")
    try:
        data = json.loads(raw or b"null")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="the body must be JSON") from exc
    records = data.get("records") if isinstance(data, dict) else data
    try:
        out = await asyncio.to_thread(append_records, state, principal.tenant_id, dataset_id, records, source=f"api:{principal.user_id}")
    except (NotAStream, DatasetNotFound, StreamError, StreamFull) as exc:
        raise _errors(exc) from exc
    state.metering.add(principal.tenant_id, "stream.records", dataset_id, out["accepted"])
    return out


@router.post("/{dataset_id}/compact", response_model=JobOut, status_code=202)
async def compact_now(dataset_id: str, state: AppState = StateDep, principal: Principal = Writer) -> JobOut:
    """Queue a compaction now (or return the one already queued or running)."""
    guard_dataset(state, principal, dataset_id)
    try:
        job_id = await asyncio.to_thread(request_compaction, state, principal.tenant_id, dataset_id, principal.user_id)
    except (NotAStream, DatasetNotFound) as exc:
        raise _errors(exc) from exc
    state.audit.record(principal.tenant_id, principal.user_id, "stream.compact.request", dataset_id=dataset_id, job_id=job_id)
    if job_id is None:
        raise HTTPException(status_code=409, detail="a compaction is already running")
    return JobService(state).get(principal.tenant_id, job_id)
