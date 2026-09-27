"""Modules 2–4 endpoints: upload, inference, profiling, sandboxed SQL, LLM suggestions."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, File, Header, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field

from ..analytics.sql_sandbox import QueryResult, QueryTimeout, UnsafeQueryError, open_sandbox, run_query
from ..analytics.suggestions import Suggestion, suggest_analytics
from ..ingestion.formats import UnsupportedFormatError, load_frame, load_sample
from ..ingestion.inference import InferenceResult, infer_schema
from ..llm.router import LLMOutputError, LLMUnavailableError
from ..profiling.profile import DatasetProfile, profile_frame
from ..schema.model import Schema, SchemaValidationError, column_renames, ensure_valid
from ..storage.datasets import DatasetNotFound, DatasetRecord, DatasetTooLarge, QuotaExceeded
from .deps import AppState, Principal, PrincipalDep, StateDep

router = APIRouter(prefix="/v1/datasets", tags=["datasets"])

CHUNK = 1024 * 1024
MULTIPART_OVERHEAD = 64 * 1024


class UploadResponse(BaseModel):
    dataset: DatasetRecord
    inference: InferenceResult | None = None


class QueryRequest(BaseModel):
    sql: str = Field(min_length=1, max_length=20_000)
    row_limit: int = Field(default=1000, ge=1, le=10_000)


class SuggestRequest(BaseModel):
    question: str | None = Field(default=None, max_length=2000)


def _record(state: AppState, principal: Principal, dataset_id: str) -> DatasetRecord:
    try:
        return state.store.get(principal.tenant_id, dataset_id)
    except DatasetNotFound as exc:
        raise HTTPException(status_code=404, detail="dataset not found") from exc


def _single_table(state: AppState, record: DatasetRecord):
    if len(record.tables) != 1:
        raise HTTPException(status_code=422, detail="this operation needs a single-table dataset; multi-table support is P1")
    table = record.tables[0]
    return state.store.table_path(record, table), table


def _renames(record: DatasetRecord) -> dict[str, dict[str, str]]:
    if record.schema_ is None or len(record.tables) != 1 or not record.schema_.entities:
        return {}
    return {record.tables[0].name: column_renames(record.schema_.entities[0])}


def _load(state: AppState, record: DatasetRecord, limit: int | None = None):
    """Load the single table with columns renamed to the confirmed schema's field names."""
    path, table = _single_table(state, record)
    frame = load_frame(path, table.format, table.encoding, limit)
    return frame.rename(columns=_renames(record).get(table.name, {}))


def _infer(state: AppState, record: DatasetRecord) -> InferenceResult:
    path, table = _single_table(state, record)
    sample = load_sample(path, table.format, table.encoding)
    return infer_schema(sample, entity_name=record.tables[0].name)


async def _store_upload(state: AppState, principal: Principal, filename: str, chunks: AsyncIterator[bytes], **kw: Any) -> UploadResponse:
    try:
        record = await state.store.save_upload(principal.tenant_id, principal.user_id, filename, chunks, **kw)
    except DatasetTooLarge as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except QuotaExceeded as exc:
        raise HTTPException(status_code=507, detail=str(exc)) from exc
    except (UnsupportedFormatError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    state.audit.record(
        principal.tenant_id,
        principal.user_id,
        "dataset.upload",
        dataset_id=record.id,
        sha256=record.tables[0].sha256,
        size_bytes=record.size_bytes,
        format=record.tables[0].format.value,
    )
    try:
        inference = await asyncio.to_thread(_infer, state, record)
        record = state.store.update_schema(record, inference.schema_)
    except UnsupportedFormatError as exc:
        # The raw file is kept (ING-010); the user can fix format options and re-run inference.
        return UploadResponse(
            dataset=record, inference=InferenceResult(schema=Schema(entities=[]), columns=[], sampled_rows=0, warnings=[str(exc)])
        )
    return UploadResponse(dataset=record, inference=inference)


@router.post("", response_model=UploadResponse, status_code=201)
async def upload_multipart(
    request: Request,
    file: UploadFile = File(...),
    x_content_sha256: str | None = Header(None),
    state: AppState = StateDep,
    principal: Principal = PrincipalDep,
) -> UploadResponse:
    """Multipart upload (ING-001/002). Oversized requests are rejected from Content-Length before the body is read."""
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > state.store.max_dataset_bytes + MULTIPART_OVERHEAD:
        raise HTTPException(status_code=413, detail=str(DatasetTooLarge(state.store.max_dataset_bytes)))

    async def chunks() -> AsyncIterator[bytes]:
        while chunk := await file.read(CHUNK):
            yield chunk

    return await _store_upload(state, principal, file.filename or "upload.csv", chunks(), expected_sha256=x_content_sha256)


@router.put("/upload", response_model=UploadResponse, status_code=201)
async def upload_stream(
    request: Request,
    filename: str = Query(..., min_length=1, max_length=255),
    x_content_sha256: str | None = Header(None),
    state: AppState = StateDep,
    principal: Principal = PrincipalDep,
) -> UploadResponse:
    """Raw-body streaming upload. The size limit is enforced before the transfer (Content-Length) and during it (ING-NFR-004)."""
    length = request.headers.get("content-length")
    declared = int(length) if length and length.isdigit() else None
    return await _store_upload(state, principal, filename, request.stream(), declared_size=declared, expected_sha256=x_content_sha256)


@router.get("", response_model=list[DatasetRecord])
async def list_datasets(state: AppState = StateDep, principal: Principal = PrincipalDep) -> list[DatasetRecord]:
    return state.store.list(principal.tenant_id)


@router.get("/{dataset_id}", response_model=DatasetRecord)
async def get_dataset(dataset_id: str, state: AppState = StateDep, principal: Principal = PrincipalDep) -> DatasetRecord:
    return _record(state, principal, dataset_id)


@router.put("/{dataset_id}/schema", response_model=DatasetRecord)
async def confirm_schema(dataset_id: str, schema: Schema, state: AppState = StateDep, principal: Principal = PrincipalDep) -> DatasetRecord:
    """INF-006: the user reviews and edits the inferred schema, then confirms it."""
    record = _record(state, principal, dataset_id)
    try:
        ensure_valid(schema)
    except SchemaValidationError as exc:
        raise HTTPException(status_code=422, detail=[i.model_dump() for i in exc.issues]) from exc
    state.audit.record(principal.tenant_id, principal.user_id, "dataset.schema.confirm", dataset_id=dataset_id)
    if len(record.tables) == 1:
        # Column names or types may have changed, so the cached profile is stale.
        (state.store.table_path(record, record.tables[0]).parent.parent / "profile.json").unlink(missing_ok=True)
    return state.store.update_schema(record, schema)


@router.get("/{dataset_id}/profile", response_model=DatasetProfile)
async def get_profile(dataset_id: str, state: AppState = StateDep, principal: Principal = PrincipalDep) -> DatasetProfile:
    record = _record(state, principal, dataset_id)
    path, _ = _single_table(state, record)
    cache = path.parent.parent / "profile.json"
    if cache.exists():
        return DatasetProfile.model_validate_json(cache.read_text())

    def compute() -> DatasetProfile:
        return profile_frame(_load(state, record), record.schema_)

    try:
        profile = await asyncio.to_thread(compute)
    except UnsupportedFormatError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    cache.write_text(profile.model_dump_json())
    return profile


@router.post("/{dataset_id}/query", response_model=QueryResult)
async def query_dataset(
    dataset_id: str, body: QueryRequest, state: AppState = StateDep, principal: Principal = PrincipalDep
) -> QueryResult:
    record = _record(state, principal, dataset_id)
    tables = {t.name: (state.store.table_path(record, t), t.format, t.encoding) for t in record.tables}

    def execute() -> QueryResult:
        con = open_sandbox(tables, renames=_renames(record))
        try:
            return run_query(con, body.sql, row_limit=body.row_limit)
        finally:
            con.close()

    try:
        result = await asyncio.to_thread(execute)
    except UnsafeQueryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except QueryTimeout as exc:
        raise HTTPException(status_code=408, detail=str(exc)) from exc
    state.audit.record(principal.tenant_id, principal.user_id, "dataset.query", dataset_id=dataset_id, rows=result.row_count)
    return result


@router.post("/{dataset_id}/suggestions", response_model=list[Suggestion])
async def suggestions(
    dataset_id: str,
    body: SuggestRequest | None = None,
    state: AppState = StateDep,
    principal: Principal = PrincipalDep,
) -> list[Suggestion]:
    record = _record(state, principal, dataset_id)
    if record.schema_ is None or not record.schema_.entities:
        raise HTTPException(status_code=409, detail="confirm the dataset schema before requesting suggestions")
    path, table = _single_table(state, record)
    profile = await get_profile(dataset_id, state, principal)
    llm = state.router(principal.tenant_id)
    level = state.llm_config(principal.tenant_id).data_minimization
    sample = await asyncio.to_thread(_load, state, record, 20)
    con = await asyncio.to_thread(open_sandbox, {table.name: (path, table.format, table.encoding)}, renames=_renames(record))
    try:
        return await suggest_analytics(
            llm, con, record.schema_, profile, sample, level, actor=principal.user_id, question=body.question if body else None
        )
    except LLMUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except LLMOutputError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    finally:
        con.close()
