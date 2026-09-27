"""Model serving endpoints and API gateway features (Module 7)."""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, model_validator

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
    """Classification / regression / clustering endpoints take ``instances``; forecasting endpoints (TRN-007) take
    ``horizon`` and optionally recent ``history`` rows."""

    instances: list[dict[str, Any]] | None = None
    explain: bool = False
    horizon: int | None = Field(default=None, ge=1, le=1000)
    history: list[dict[str, Any]] | None = Field(default=None, max_length=5000)

    @model_validator(mode="after")
    def _check(self) -> PredictBody:
        if not self.instances and self.horizon is None and not self.history:
            raise ValueError("send instances (or horizon for forecasting endpoints)")
        return self


class DriftCheckBody(BaseModel):
    hours: int = Field(default=24, ge=1, le=24 * 90)


class BatchBody(BaseModel):
    dataset_id: str


def _errors(exc: Exception) -> HTTPException:
    if isinstance(exc, NotFound):
        return HTTPException(status_code=404, detail=f"not found: {exc}")
    return HTTPException(status_code=422, detail=str(exc))


@router.post("/drift-checks", response_model=JobOut, status_code=202)
async def drift_check_all(body: DriftCheckBody | None = None, state: AppState = StateDep, principal: Principal = Deployer) -> JobOut:
    """API-011: check drift on every active endpoint (point a scheduler at this); alerts raise ``endpoint.threshold``."""
    hours = body.hours if body else 24
    return JobService(state).submit(principal.tenant_id, "serving.drift_check", {"hours": hours}, principal.user_id)


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
            ServingService(state).predict,
            principal.tenant_id,
            name,
            body.instances,
            explain=body.explain,
            caller=principal.user_id,
            horizon=body.horizon,
            history=body.history,
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


@router.get("/{name}/drift")
async def drift(name: str, hours: int = 24, state: AppState = StateDep, principal: Principal = Reader) -> dict[str, Any]:
    """API-011: input drift (per-feature PSI) and prediction drift against the training reference profile.

    PSI < 0.1 is ``ok``, ≥ 0.1 ``warn``, ≥ 0.25 ``alert``; fewer than ``min_samples`` samples is ``insufficient_data``.
    """
    try:
        return await asyncio.to_thread(ServingService(state).drift, principal.tenant_id, name, max(1, min(hours, 24 * 90)))
    except NotFound as exc:
        raise _errors(exc) from exc


@router.post("/{name}/drift/check", response_model=JobOut, status_code=202)
async def drift_check(name: str, body: DriftCheckBody | None = None, state: AppState = StateDep, principal: Principal = Deployer) -> JobOut:
    """API-011: run a drift check job for one endpoint now; an alert emits ``endpoint.threshold`` (notification + webhook)."""
    try:
        ServingService(state).get(principal.tenant_id, name)
    except NotFound as exc:
        raise _errors(exc) from exc
    params = {"endpoint": name, "hours": body.hours if body else 24}
    return JobService(state).submit(principal.tenant_id, "serving.drift_check", params, principal.user_id)
