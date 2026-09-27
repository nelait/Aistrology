"""Modules 2–4 endpoints: upload, versions, inference, profiling, sandboxed SQL, LLM suggestions."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, File, Header, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field

from ..analytics.sql_sandbox import QueryResult, QueryTimeout, UnsafeQueryError, open_sandbox, run_query
from ..analytics.suggestions import Suggestion, suggest_analytics
from ..auth.rbac import Permission
from ..auth.service import Principal
from ..datasets_io import MultiTableError, load_table, main_table, renames, sandbox_tables
from ..ingestion.formats import UnsupportedFormatError, load_sample
from ..ingestion.inference import InferenceResult, infer_schema
from ..llm.router import LLMOutputError, LLMUnavailableError
from ..profiling.profile import DatasetProfile, profile_frame
from ..schema.model import Schema, SchemaValidationError, ensure_valid
from ..storage.datasets import DatasetNotFound, DatasetRecord, DatasetTooLarge, QuotaExceeded
from .deps import AppState, StateDep, require

router = APIRouter(prefix="/v1/datasets", tags=["datasets"])

CHUNK = 1024 * 1024
MULTIPART_OVERHEAD = 64 * 1024

Reader = require(Permission.READ_DATA)
Writer = require(Permission.WRITE_DATA)


class UploadResponse(BaseModel):
    dataset: DatasetRecord
    inference: InferenceResult | None = None


class QueryRequest(BaseModel):
    sql: str = Field(min_length=1, max_length=20_000)
    row_limit: int = Field(default=1000, ge=1, le=10_000)


class SuggestRequest(BaseModel):
    question: str | None = Field(default=None, max_length=2000)


def get_record(state: AppState, principal: Principal, dataset_id: str, version: int | None = None) -> DatasetRecord:
    try:
        return state.store.get(principal.tenant_id, dataset_id, version)
    except DatasetNotFound as exc:
        raise HTTPException(status_code=404, detail="dataset not found") from exc


def _single(record: DatasetRecord):
    try:
        return main_table(record)
    except MultiTableError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _infer(state: AppState, record: DatasetRecord) -> InferenceResult:
    table = main_table(record)
    sample = load_sample(state.store.table_path(record, table), table.format, table.encoding)
    return infer_schema(sample, entity_name=table.name)


def compute_profile(state: AppState, record: DatasetRecord) -> DatasetProfile:
    cached = state.store.get_profile(record)
    if cached:
        return DatasetProfile.model_validate(cached)
    profile = profile_frame(load_table(state.store, record), record.schema_)
    state.store.set_profile(record, profile.model_dump(mode="json"))
    return profile


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
    principal: Principal = Writer,
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
    principal: Principal = Writer,
) -> UploadResponse:
    """Raw-body streaming upload. The size limit is enforced before the transfer (Content-Length) and during it (ING-NFR-004)."""
    length = request.headers.get("content-length")
    declared = int(length) if length and length.isdigit() else None
    return await _store_upload(state, principal, filename, request.stream(), declared_size=declared, expected_sha256=x_content_sha256)


@router.get("", response_model=list[DatasetRecord])
async def list_datasets(state: AppState = StateDep, principal: Principal = Reader) -> list[DatasetRecord]:
    return state.store.list(principal.tenant_id)


@router.get("/{dataset_id}", response_model=DatasetRecord)
async def get_dataset(
    dataset_id: str, version: int | None = None, state: AppState = StateDep, principal: Principal = Reader
) -> DatasetRecord:
    return get_record(state, principal, dataset_id, version)


@router.get("/{dataset_id}/versions", response_model=list[DatasetRecord])
async def list_versions(dataset_id: str, state: AppState = StateDep, principal: Principal = Reader) -> list[DatasetRecord]:
    """PIP-007: every upload and applied pipeline is an immutable version with lineage."""
    try:
        return state.store.versions(principal.tenant_id, dataset_id)
    except DatasetNotFound as exc:
        raise HTTPException(status_code=404, detail="dataset not found") from exc


@router.delete("/{dataset_id}", status_code=204)
async def delete_dataset(dataset_id: str, state: AppState = StateDep, principal: Principal = Writer) -> None:
    get_record(state, principal, dataset_id)
    state.store.delete(principal.tenant_id, dataset_id)
    state.audit.record(principal.tenant_id, principal.user_id, "dataset.delete", dataset_id=dataset_id)


@router.put("/{dataset_id}/schema", response_model=DatasetRecord)
async def confirm_schema(
    dataset_id: str, schema: Schema, state: AppState = StateDep, principal: Principal = require(Permission.EDIT_PIPELINES)
) -> DatasetRecord:
    """INF-006: the user reviews and edits the inferred schema, then confirms it."""
    record = get_record(state, principal, dataset_id)
    try:
        ensure_valid(schema)
    except SchemaValidationError as exc:
        raise HTTPException(status_code=422, detail=[i.model_dump() for i in exc.issues]) from exc
    state.audit.record(principal.tenant_id, principal.user_id, "dataset.schema.confirm", dataset_id=dataset_id, version=record.version)
    return state.store.update_schema(record, schema)


@router.get("/{dataset_id}/profile", response_model=DatasetProfile)
async def get_profile(
    dataset_id: str, version: int | None = None, state: AppState = StateDep, principal: Principal = Reader
) -> DatasetProfile:
    record = get_record(state, principal, dataset_id, version)
    _single(record)
    try:
        return await asyncio.to_thread(compute_profile, state, record)
    except UnsupportedFormatError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def execute_sql(state: AppState, record: DatasetRecord, sql: str, row_limit: int) -> QueryResult:
    con = open_sandbox(sandbox_tables(state.store, record), renames=renames(record))
    try:
        return run_query(con, sql, row_limit=row_limit)
    finally:
        con.close()


@router.post("/{dataset_id}/query", response_model=QueryResult)
async def query_dataset(
    dataset_id: str, body: QueryRequest, version: int | None = None, state: AppState = StateDep, principal: Principal = Reader
) -> QueryResult:
    record = get_record(state, principal, dataset_id, version)
    try:
        result = await asyncio.to_thread(execute_sql, state, record, body.sql, body.row_limit)
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
    principal: Principal = require(Permission.CREATE_ANALYTICS),
) -> list[Suggestion]:
    record = get_record(state, principal, dataset_id)
    if record.schema_ is None or not record.schema_.entities:
        raise HTTPException(status_code=409, detail="confirm the dataset schema before requesting suggestions")
    _single(record)
    profile = await asyncio.to_thread(compute_profile, state, record)
    llm = state.router(principal.tenant_id)
    level = state.llm_config(principal.tenant_id).data_minimization
    sample = await asyncio.to_thread(load_table, state.store, record, None, 20)
    con = await asyncio.to_thread(open_sandbox, sandbox_tables(state.store, record), renames=renames(record))
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
