"""Phase 2 dataset endpoints: new versions with schema evolution (INF-007/008), column annotations (ANA-010)
and opt-in profiling analyses (ANA-004a, ANA-005a, ANA-008)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Literal

from fastapi import APIRouter, File, Header, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field

from ..auth.rbac import Permission
from ..auth.service import Principal
from ..datasets_io import MultiTableError, load_table
from ..ingestion.evolution import evolution_diff, make_transform, merge_confirmed
from ..ingestion.formats import UnsupportedFormatError
from ..ingestion.inference import InferenceResult
from ..profiling.advanced import AdvancedProfile, AdvancedProfileRequest, advanced_profile
from ..schema.diff import SchemaDiff
from ..schema.model import ColumnAnnotation, SchemaValidationError, ensure_valid
from ..storage.datasets import DatasetRecord, DatasetTooLarge, QuotaExceeded
from .datasets import CHUNK, MULTIPART_OVERHEAD, get_record, infer_record
from .deps import AppState, StateDep, require

router = APIRouter(prefix="/v1/datasets", tags=["datasets"])

Reader = require(Permission.READ_DATA)
Writer = require(Permission.WRITE_DATA)
Editor = require(Permission.EDIT_PIPELINES)


class EvolutionResponse(BaseModel):
    dataset: DatasetRecord
    previous_version: int
    mode: Literal["append", "replace"]
    inference: InferenceResult
    # INF-007/INF-008: added, removed and retyped columns (and nullability) versus the previous version.
    diff: SchemaDiff


@router.post("/{dataset_id}/versions", response_model=EvolutionResponse, status_code=201)
async def upload_version(
    dataset_id: str,
    request: Request,
    file: UploadFile = File(...),
    mode: Literal["append", "replace"] = Query("append"),
    x_content_sha256: str | None = Header(None),
    state: AppState = StateDep,
    principal: Principal = Writer,
) -> EvolutionResponse:
    """Upload a new file for an existing dataset as its next version and report how the schema evolved."""
    previous = get_record(state, principal, dataset_id)
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > state.store.max_dataset_bytes + MULTIPART_OVERHEAD:
        raise HTTPException(status_code=413, detail=str(DatasetTooLarge(state.store.max_dataset_bytes)))

    async def chunks() -> AsyncIterator[bytes]:
        while chunk := await file.read(CHUNK):
            yield chunk

    try:
        record = await state.store.save_upload(
            principal.tenant_id,
            principal.user_id,
            file.filename or "upload.csv",
            chunks(),
            expected_sha256=x_content_sha256,
            dataset_id=dataset_id,
            transform=make_transform(state.store, previous, mode),
        )
    except DatasetTooLarge as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except QuotaExceeded as exc:
        raise HTTPException(status_code=507, detail=str(exc)) from exc
    except (UnsupportedFormatError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        inference = await asyncio.to_thread(infer_record, state, record)
    except UnsupportedFormatError as exc:
        raise HTTPException(
            status_code=422, detail=f"version {record.version} was stored, but its schema could not be inferred: {exc}"
        ) from exc
    diff = evolution_diff(previous.schema_, inference.schema_)
    schema = merge_confirmed(previous.schema_, inference.schema_)
    try:
        ensure_valid(schema)
    except SchemaValidationError:
        schema = inference.schema_
    record = state.store.update_schema(record, schema)
    state.audit.record(
        principal.tenant_id,
        principal.user_id,
        "dataset.version.upload",
        dataset_id=dataset_id,
        version=record.version,
        parent_version=previous.version,
        mode=mode,
        breaking=diff.breaking,
    )
    return EvolutionResponse(dataset=record, previous_version=previous.version, mode=mode, inference=inference, diff=diff)


# -- ANA-010 column annotations ------------------------------------------------------------------


class AnnotationsBody(BaseModel):
    columns: dict[str, list[ColumnAnnotation]] = Field(max_length=2000)
    entity: str | None = Field(default=None, max_length=128)
    version: int | None = Field(default=None, ge=1)
    # False: add to the existing annotations instead of replacing them.
    replace: bool = True


class AnnotationsOut(BaseModel):
    dataset_id: str
    version: int
    annotations: dict[str, dict[str, list[ColumnAnnotation]]]


def _annotations(record: DatasetRecord) -> AnnotationsOut:
    entities = record.schema_.entities if record.schema_ else []
    return AnnotationsOut(
        dataset_id=record.id,
        version=record.version,
        annotations={e.name: {f.name: list(f.annotations) for f in e.fields if f.annotations} for e in entities},
    )


@router.get("/{dataset_id}/annotations", response_model=AnnotationsOut)
async def get_annotations(
    dataset_id: str, version: int | None = None, state: AppState = StateDep, principal: Principal = Reader
) -> AnnotationsOut:
    return _annotations(get_record(state, principal, dataset_id, version))


@router.put("/{dataset_id}/annotations", response_model=AnnotationsOut)
async def set_annotations(
    dataset_id: str, body: AnnotationsBody, state: AppState = StateDep, principal: Principal = Editor
) -> AnnotationsOut:
    """Annotate columns as PII / sensitive / derived / target / id. Stored on the version's schema (ANA-010).

    ``pii`` and ``sensitive`` also mark the field as PII, so it is masked before reaching an LLM (LLM-NFR-004).
    """
    record = get_record(state, principal, dataset_id, body.version)
    if record.schema_ is None or not record.schema_.entities:
        raise HTTPException(status_code=409, detail="the dataset has no schema yet")
    schema = record.schema_.model_copy(deep=True)
    if body.entity is None and len(schema.entities) > 1:
        raise HTTPException(status_code=422, detail="the dataset has several entities; pass entity")
    entity = schema.entity(body.entity) if body.entity else schema.entities[0]
    if entity is None:
        raise HTTPException(status_code=422, detail=f"unknown entity {body.entity!r}")
    unknown = []
    for column, labels in body.columns.items():
        idx = next((i for i, f in enumerate(entity.fields) if column in (f.name, f.source_name)), None)
        if idx is None:
            unknown.append(column)
            continue
        f = entity.fields[idx]
        new = list(dict.fromkeys(labels if body.replace else [*f.annotations, *labels]))
        data = f.model_dump()
        data["annotations"] = new
        # Re-validate so a pii/sensitive annotation sets pii=True. Annotations never clear an existing PII flag
        # (privacy by default); un-flagging is an explicit schema edit (PUT /schema).
        entity.fields[idx] = type(f).model_validate(data)
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown column(s): {unknown}")
    record = state.store.update_schema(record, schema)
    state.audit.record(
        principal.tenant_id,
        principal.user_id,
        "dataset.annotations",
        dataset_id=dataset_id,
        version=record.version,
        columns=sorted(body.columns),
    )
    return _annotations(record)


# -- ANA-004a / ANA-005a / ANA-008 ---------------------------------------------------------------


@router.post("/{dataset_id}/profile/advanced", response_model=AdvancedProfile)
async def profile_advanced(
    dataset_id: str,
    body: AdvancedProfileRequest | None = None,
    version: int | None = None,
    table: str | None = Query(None, max_length=128),
    state: AppState = StateDep,
    principal: Principal = Reader,
) -> AdvancedProfile:
    """Isolation Forest outliers, near-duplicate rows and missing-value patterns (each can be disabled)."""
    record = get_record(state, principal, dataset_id, version)
    try:
        frame = await asyncio.to_thread(load_table, state.store, record, table)
        return await asyncio.to_thread(advanced_profile, frame, body)
    except MultiTableError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"table {table!r} not found") from exc
    except (UnsupportedFormatError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
