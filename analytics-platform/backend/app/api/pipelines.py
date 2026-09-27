"""Cleaning pipeline endpoints (CLN-*, PIP-*)."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..auth.rbac import Permission
from ..auth.service import Principal
from ..cleaning.service import PipelineNotFound, PipelineOut, PipelineService, PreviewOut
from ..cleaning.steps import Step, StepError
from ..datasets_io import MultiTableError
from ..jobs.core import JobOut, JobService
from ..storage.datasets import DatasetNotFound
from .deps import AppState, StateDep, require

router = APIRouter(prefix="/v1/pipelines", tags=["pipelines"])
Editor = require(Permission.EDIT_PIPELINES)
Reader = require(Permission.READ_DATA)


class PipelineCreate(BaseModel):
    dataset_id: str
    name: str = Field(min_length=1, max_length=200)
    steps: list[Step] = Field(default_factory=list, max_length=500)


class StepBody(BaseModel):
    step: Step


class PreviewBody(BaseModel):
    step: Step | None = None
    rows: int = Field(default=50, ge=1, le=500)


class TemplateBody(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class InstantiateBody(BaseModel):
    template_id: str
    dataset_id: str
    name: str | None = Field(default=None, max_length=200)


def _errors(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except (PipelineNotFound, DatasetNotFound) as exc:
        raise HTTPException(status_code=404, detail=f"not found: {exc}") from exc
    except (StepError, MultiTableError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("", response_model=PipelineOut, status_code=201)
async def create_pipeline(body: PipelineCreate, state: AppState = StateDep, principal: Principal = Editor) -> PipelineOut:
    return _errors(
        PipelineService(state).create, principal.tenant_id, principal.user_id, name=body.name, dataset_id=body.dataset_id, steps=body.steps
    )


@router.get("", response_model=list[PipelineOut])
async def list_pipelines(dataset_id: str | None = None, state: AppState = StateDep, principal: Principal = Reader) -> list[PipelineOut]:
    return PipelineService(state).list(principal.tenant_id, dataset_id=dataset_id)


@router.get("/templates", response_model=list[PipelineOut])
async def list_templates(state: AppState = StateDep, principal: Principal = Reader) -> list[PipelineOut]:
    return PipelineService(state).list(principal.tenant_id, templates=True)


@router.post("/from-template", response_model=PipelineOut, status_code=201)
async def from_template(body: InstantiateBody, state: AppState = StateDep, principal: Principal = Editor) -> PipelineOut:
    return await asyncio.to_thread(
        _errors, PipelineService(state).instantiate, principal.tenant_id, principal.user_id, body.template_id, body.dataset_id, body.name
    )


@router.get("/{pipeline_id}", response_model=PipelineOut)
async def get_pipeline(pipeline_id: str, state: AppState = StateDep, principal: Principal = Reader) -> PipelineOut:
    return _errors(PipelineService(state).get, principal.tenant_id, pipeline_id)


@router.post("/{pipeline_id}/steps", response_model=PipelineOut)
async def add_step(pipeline_id: str, body: StepBody, state: AppState = StateDep, principal: Principal = Editor) -> PipelineOut:
    return await asyncio.to_thread(_errors, PipelineService(state).add_step, principal.tenant_id, principal.user_id, pipeline_id, body.step)


@router.post("/{pipeline_id}/undo", response_model=PipelineOut)
async def undo(pipeline_id: str, state: AppState = StateDep, principal: Principal = Editor) -> PipelineOut:
    return _errors(PipelineService(state).undo, principal.tenant_id, principal.user_id, pipeline_id)


@router.post("/{pipeline_id}/redo", response_model=PipelineOut)
async def redo(pipeline_id: str, state: AppState = StateDep, principal: Principal = Editor) -> PipelineOut:
    return _errors(PipelineService(state).redo, principal.tenant_id, principal.user_id, pipeline_id)


@router.post("/{pipeline_id}/preview", response_model=PreviewOut)
async def preview(
    pipeline_id: str, body: PreviewBody | None = None, state: AppState = StateDep, principal: Principal = Reader
) -> PreviewOut:
    body = body or PreviewBody()
    return await asyncio.to_thread(_errors, PipelineService(state).preview, principal.tenant_id, pipeline_id, body.step, body.rows)


@router.post("/{pipeline_id}/template", response_model=PipelineOut, status_code=201)
async def save_template(pipeline_id: str, body: TemplateBody, state: AppState = StateDep, principal: Principal = Editor) -> PipelineOut:
    return _errors(PipelineService(state).save_as_template, principal.tenant_id, principal.user_id, pipeline_id, body.name)


@router.post("/{pipeline_id}/apply", response_model=JobOut, status_code=202)
async def apply(pipeline_id: str, state: AppState = StateDep, principal: Principal = Editor) -> JobOut:
    pipeline = _errors(PipelineService(state).get, principal.tenant_id, pipeline_id)
    if pipeline.is_template:
        raise HTTPException(status_code=422, detail="templates can't be applied directly")
    return JobService(state).submit(principal.tenant_id, "pipeline.apply", {"pipeline_id": pipeline_id}, principal.user_id)
