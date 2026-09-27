"""Model serving endpoints and API gateway features (Module 7)."""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..auth.rbac import Permission
from ..auth.service import Principal
from ..jobs.core import JobOut, JobService, notify
from ..serving.service import EndpointCreate, EndpointOut, EndpointPatch, ServingError, ServingService
from ..training.service import NotFound
from .deps import AppState, StateDep, guard_dataset, require

router = APIRouter(prefix="/v1/endpoints", tags=["serving"])
Deployer = require(Permission.DEPLOY)
Predictor = require(Permission.PREDICT)
Reader = require(Permission.READ_DATA)
MAX_BATCH_UPLOAD = 1024**3


class PredictBody(BaseModel):
    instances: list[dict[str, Any]] = Field(min_length=1)
    explain: bool = False


class BatchBody(BaseModel):
    dataset_id: str


def _errors(exc: Exception) -> HTTPException:
    if isinstance(exc, NotFound):
        return HTTPException(status_code=404, detail=f"not found: {exc}")
    return HTTPException(status_code=422, detail=str(exc))


@router.post("", response_model=EndpointOut, status_code=201)
async def deploy(body: EndpointCreate, state: AppState = StateDep, principal: Principal = Deployer) -> EndpointOut:
    """API-001: one-click deployment of a registered model version (or an A/B split, API-008)."""
    try:
        out = await asyncio.to_thread(ServingService(state).create, principal.tenant_id, principal.user_id, body)
    except (NotFound, ServingError) as exc:
        raise _errors(exc) from exc
    notify(state, principal.tenant_id, None, "endpoint.deployed", f"endpoint {out.name} deployed", {"endpoint": out.name})
    return out


@router.get("", response_model=list[EndpointOut])
async def list_endpoints(state: AppState = StateDep, principal: Principal = Reader) -> list[EndpointOut]:
    return ServingService(state).list(principal.tenant_id)


@router.get("/{name}", response_model=EndpointOut)
async def get_endpoint(name: str, state: AppState = StateDep, principal: Principal = Reader) -> EndpointOut:
    try:
        return ServingService(state).get(principal.tenant_id, name)
    except NotFound as exc:
        raise _errors(exc) from exc


@router.patch("/{name}", response_model=EndpointOut)
async def patch_endpoint(name: str, body: EndpointPatch, state: AppState = StateDep, principal: Principal = Deployer) -> EndpointOut:
    try:
        return await asyncio.to_thread(ServingService(state).update, principal.tenant_id, principal.user_id, name, body)
    except (NotFound, ServingError) as exc:
        raise _errors(exc) from exc


@router.delete("/{name}", status_code=204)
async def delete_endpoint(name: str, state: AppState = StateDep, principal: Principal = Deployer) -> None:
    try:
        ServingService(state).delete(principal.tenant_id, principal.user_id, name)
    except NotFound as exc:
        raise _errors(exc) from exc


@router.post("/{name}/predict")
async def predict(name: str, body: PredictBody, state: AppState = StateDep, principal: Principal = Predictor) -> dict[str, Any]:
    """API-002: real-time inference. Authenticate with an API key (``X-API-Key``) or a user token."""
    try:
        return await asyncio.to_thread(
            ServingService(state).predict, principal.tenant_id, name, body.instances, explain=body.explain, caller=principal.user_id
        )
    except (NotFound, ServingError, ValueError) as exc:
        raise _errors(exc) from exc


@router.post("/{name}/batch", response_model=JobOut, status_code=202)
async def batch(
    name: str,
    request: Request,
    file: UploadFile | None = File(None),
    state: AppState = StateDep,
    principal: Principal = Predictor,
) -> JobOut:
    """API-005: batch prediction from an uploaded CSV (multipart ``file``) or a dataset (JSON ``{"dataset_id"}``)."""
    try:
        ServingService(state).get(principal.tenant_id, name)
    except NotFound as exc:
        raise _errors(exc) from exc
    params: dict[str, Any] = {"endpoint": name}
    if file is not None:
        data = await file.read(MAX_BATCH_UPLOAD + 1)
        if len(data) > MAX_BATCH_UPLOAD:
            raise HTTPException(status_code=413, detail="batch input exceeds 1 GB")
        key = f"batch/inputs/{uuid.uuid4().hex}.csv"
        state.objects.put_bytes(principal.tenant_id, key, data)
        params["input_key"] = key
    else:
        try:
            body = BatchBody.model_validate(await request.json())
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail="send a multipart file or JSON {dataset_id}") from exc
        guard_dataset(state, principal, body.dataset_id)
        params["dataset_id"] = body.dataset_id
    return JobService(state).submit(principal.tenant_id, "serving.batch_predict", params, principal.user_id)


@router.get("/{name}/batch/{job_id}")
async def batch_result(name: str, job_id: str, state: AppState = StateDep, principal: Principal = Predictor) -> Response:
    try:
        job = JobService(state).get(principal.tenant_id, job_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail="job not found") from exc
    if job.type != "serving.batch_predict" or job.params.get("endpoint") != name:
        raise HTTPException(status_code=404, detail="job not found")
    if job.status != "succeeded":
        raise HTTPException(status_code=409, detail=f"batch job is {job.status}")
    data = state.objects.get_bytes(principal.tenant_id, job.result["output_key"])
    return Response(data, media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{name}-{job_id}.csv"'})


@router.get("/{name}/openapi.json")
async def openapi(name: str, state: AppState = StateDep, principal: Principal = Reader) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(ServingService(state).openapi, principal.tenant_id, name)
    except NotFound as exc:
        raise _errors(exc) from exc


@router.get("/{name}/metrics")
async def metrics(name: str, hours: int = 24, state: AppState = StateDep, principal: Principal = Reader) -> dict[str, Any]:
    try:
        return ServingService(state).metrics(principal.tenant_id, name, max(1, min(hours, 24 * 90)))
    except NotFound as exc:
        raise _errors(exc) from exc
