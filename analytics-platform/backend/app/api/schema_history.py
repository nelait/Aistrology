"""Versioned schema history per project, and schema diffs (SCH-010)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..auth.rbac import Permission
from ..auth.service import Principal
from ..projects import ProjectAccessDenied, check_project, visible_projects
from ..schema.diff import SchemaDiff, diff_schemas
from ..schema.history import SavedSchemaOut, SchemaHistory, SchemaNotFound, SchemaVersionOut
from ..schema.model import Schema, SchemaValidationError
from .datasets import _target_project
from .deps import AppState, StateDep, require

router = APIRouter(prefix="/v1/schemas", tags=["schema-history"])
Reader = require(Permission.READ_DATA)
Editor = require(Permission.EDIT_PIPELINES)


class SaveSchemaRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    schema_: Schema = Field(alias="schema")
    project_id: str | None = Field(default=None, max_length=40)
    message: str | None = Field(default=None, max_length=2000)
    source_format: str | None = Field(default=None, max_length=32)

    model_config = {"populate_by_name": True}


class SaveSchemaResponse(BaseModel):
    schema_record: SavedSchemaOut
    version: int
    created: bool
    diff: SchemaDiff | None = None


class DiffRequest(BaseModel):
    a: Schema
    b: Schema


def _history(state: AppState) -> SchemaHistory:
    return SchemaHistory(state.db)


def _visible(state: AppState, principal: Principal, schema_id: str) -> SavedSchemaOut:
    """Load a saved schema the caller may see; 404 otherwise (AUTH-003)."""
    try:
        record = _history(state).get(principal.tenant_id, schema_id)
        check_project(state, principal, record.project_id)
    except (SchemaNotFound, ProjectAccessDenied) as exc:
        raise HTTPException(status_code=404, detail="schema not found") from exc
    return record


@router.post("", response_model=SaveSchemaResponse)
async def save_schema(body: SaveSchemaRequest, state: AppState = StateDep, principal: Principal = Editor) -> JSONResponse:
    """Save a named schema in a project. A new version is created only when the content changed."""
    project_id = _target_project(state, principal, body.project_id)
    history = _history(state)
    try:
        record, created = history.save(
            principal.tenant_id,
            principal.user_id,
            project_id,
            body.name,
            body.schema_,
            message=body.message,
            source_format=body.source_format,
        )
    except SchemaValidationError as exc:
        raise HTTPException(
            status_code=422, detail={"message": "schema is invalid", "issues": [i.model_dump() for i in exc.issues]}
        ) from exc
    diff = history.diff(principal.tenant_id, record.id) if created and record.current_version > 1 else None
    if created:
        state.audit.record(
            principal.tenant_id,
            principal.user_id,
            "schema.save",
            schema_id=record.id,
            version=record.current_version,
            project_id=project_id,
        )
    out = SaveSchemaResponse(schema_record=record, version=record.current_version, created=created, diff=diff)
    return JSONResponse(out.model_dump(mode="json"), status_code=201 if created else 200)


@router.get("", response_model=list[SavedSchemaOut])
async def list_schemas(
    project_id: str | None = Query(None, max_length=40), state: AppState = StateDep, principal: Principal = Reader
) -> list[SavedSchemaOut]:
    allowed = visible_projects(state, principal)
    if project_id is not None:
        allowed = {project_id} if allowed is None or project_id in allowed else set()
    return _history(state).list(principal.tenant_id, allowed)


@router.post("/diff", response_model=SchemaDiff)
async def diff_two(body: DiffRequest, principal: Principal = Reader) -> SchemaDiff:
    """Diff two arbitrary schemas (``a`` → ``b``)."""
    return diff_schemas(body.a, body.b)


@router.get("/{schema_id}", response_model=SavedSchemaOut)
async def get_schema(schema_id: str, state: AppState = StateDep, principal: Principal = Reader) -> SavedSchemaOut:
    return _visible(state, principal, schema_id)


@router.get("/{schema_id}/versions", response_model=list[SchemaVersionOut])
async def list_versions(schema_id: str, state: AppState = StateDep, principal: Principal = Reader) -> list[SchemaVersionOut]:
    return _visible(state, principal, schema_id).versions or []


@router.get("/{schema_id}/versions/{version}", response_model=SchemaVersionOut)
async def get_version(schema_id: str, version: int, state: AppState = StateDep, principal: Principal = Reader) -> SchemaVersionOut:
    _visible(state, principal, schema_id)
    try:
        return _history(state).version(principal.tenant_id, schema_id, version)
    except SchemaNotFound as exc:
        raise HTTPException(status_code=404, detail="schema version not found") from exc


@router.get("/{schema_id}/diff", response_model=SchemaDiff)
async def diff_versions(
    schema_id: str,
    from_version: int | None = Query(None, ge=1),
    to_version: int | None = Query(None, ge=1),
    state: AppState = StateDep,
    principal: Principal = Reader,
) -> SchemaDiff:
    """Diff two versions; defaults to the previous version against the latest."""
    _visible(state, principal, schema_id)
    try:
        return _history(state).diff(principal.tenant_id, schema_id, from_version, to_version)
    except SchemaNotFound as exc:
        raise HTTPException(status_code=404, detail="schema version not found") from exc
