"""Model serving endpoints and API gateway features (Module 7)."""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from fastapi import APIRouter, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field, model_validator

from ..auth.network import network_allows
from ..auth.rbac import Permission, has_permission
from ..auth.service import AuthError, Principal
from ..jobs.core import JobOut, JobService, notify
from ..serving import streaming
from ..serving.canary import CanaryConflict, CanaryError, CanaryService, CanaryStart
from ..serving.service import MAX_INSTANCES, EndpointCreate, EndpointOut, EndpointPatch, ServingError, ServingService
from ..training.service import NotFound
from .deps import SCOPED_METHODS, AppState, StateDep, guard_dataset, require

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


class StreamBody(PredictBody):
    """API-006: like ``predict``, but up to 10,000 instances, answered as Server-Sent Events in chunks."""

    instances: list[dict[str, Any]] | None = Field(default=None, max_length=streaming.STREAM_MAX_INSTANCES)
    chunk_size: int = Field(default=100, ge=1, le=MAX_INSTANCES)


class DriftCheckBody(BaseModel):
    hours: int = Field(default=24, ge=1, le=24 * 90)


class BatchBody(BaseModel):
    dataset_id: str


def _errors(exc: Exception) -> HTTPException:
    if isinstance(exc, NotFound):
        return HTTPException(status_code=404, detail=f"not found: {exc}")
    if isinstance(exc, CanaryConflict):
        return HTTPException(status_code=409, detail={"code": "canary_conflict", "message": str(exc)})
    return HTTPException(status_code=422, detail=str(exc))


@router.post("/drift-checks", response_model=JobOut, status_code=202)
async def drift_check_all(body: DriftCheckBody | None = None, state: AppState = StateDep, principal: Principal = Deployer) -> JobOut:
    """API-011: check drift on every active endpoint (point a scheduler at this); alerts raise ``endpoint.threshold``."""
    hours = body.hours if body else 24
    return JobService(state).submit(principal.tenant_id, "serving.drift_check", {"hours": hours}, principal.user_id)


@router.post("/canary-steps", response_model=JobOut, status_code=202)
async def canary_tick(state: AppState = StateDep, principal: Principal = Deployer) -> JobOut:
    """API-009: evaluate every due canary step of the organization (point a scheduler at this every minute)."""
    return JobService(state).submit(principal.tenant_id, "serving.canary_step", {}, principal.user_id)


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
    except (NotFound, ServingError, CanaryConflict) as exc:
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


# -- canary rollouts (API-009) ------------------------------------------------------------------------------------------


@router.post("/{name}/canary", status_code=201)
async def start_canary(name: str, body: CanaryStart, state: AppState = StateDep, principal: Principal = Deployer) -> dict[str, Any]:
    """API-009: route ``steps[0]`` % of traffic to ``model_version_id`` and ramp through ``steps`` every ``step_minutes``
    while the canary's error rate and p95 latency stay within limits; roll back automatically otherwise."""
    try:
        return await asyncio.to_thread(CanaryService(state).start, principal.tenant_id, principal.user_id, name, body)
    except (NotFound, CanaryError) as exc:
        raise _errors(exc) from exc


@router.get("/{name}/canary")
async def canary_status(name: str, state: AppState = StateDep, principal: Principal = Reader) -> dict[str, Any]:
    """The latest canary rollout of the endpoint, with live canary-vs-baseline metrics while it runs."""
    try:
        return await asyncio.to_thread(CanaryService(state).status, principal.tenant_id, name)
    except NotFound as exc:
        raise _errors(exc) from exc


@router.post("/{name}/canary/promote")
async def promote_canary(name: str, state: AppState = StateDep, principal: Principal = Deployer) -> dict[str, Any]:
    try:
        return CanaryService(state).promote(principal.tenant_id, principal.user_id, name)
    except (NotFound, CanaryError) as exc:
        raise _errors(exc) from exc


@router.post("/{name}/canary/abort")
async def abort_canary(name: str, state: AppState = StateDep, principal: Principal = Deployer) -> dict[str, Any]:
    try:
        return CanaryService(state).abort(principal.tenant_id, principal.user_id, name)
    except (NotFound, CanaryError) as exc:
        raise _errors(exc) from exc


# -- streaming inference (API-006) --------------------------------------------------------------------------------------


@router.post("/{name}/predict/stream")
async def predict_stream(name: str, body: StreamBody, state: AppState = StateDep, principal: Principal = Predictor) -> StreamingResponse:
    """API-006: Server-Sent Events. Instances are predicted in chunks of ``chunk_size`` (one ``prediction`` event per
    chunk); forecasting endpoints stream one ``forecast`` event per horizon step. Ends with ``done`` (or ``error``)."""
    svc = ServingService(state)
    try:
        ep = svc.get(principal.tenant_id, name)
        bundle = await asyncio.to_thread(svc.bundle_for, principal.tenant_id, max(ep.routes, key=lambda r: r["weight"]))
    except NotFound as exc:
        raise _errors(exc) from exc
    forecasting = bundle.problem_type == "forecasting"
    if not forecasting and not body.instances:
        raise HTTPException(status_code=422, detail="instances must not be empty")
    if not streaming.slots(state).available(principal.tenant_id):
        raise HTTPException(status_code=429, detail="too many concurrent streams", headers={"Retry-After": "5"})

    async def events():
        try:
            slot = streaming.slots(state).hold(principal.tenant_id)
            slot.__enter__()
        except streaming.StreamLimitExceeded as exc:
            yield streaming.sse("error", {"status": 429, "detail": str(exc)})
            return
        try:
            if forecasting:
                out = await asyncio.to_thread(
                    svc.predict, principal.tenant_id, name, None, caller=principal.user_id, horizon=body.horizon, history=body.history
                )
                yield streaming.sse("start", {"endpoint": name, "horizon": out["horizon"], "model_version": out.get("model_version")})
                for step in streaming.forecast_steps(out):
                    yield streaming.sse("forecast", step)
                    await asyncio.sleep(0)
                yield streaming.sse("done", {"steps": out["horizon"], "interval_level": out.get("interval_level")})
                return
            instances = body.instances or []
            yield streaming.sse("start", {"endpoint": name, "total": len(instances), "chunk_size": body.chunk_size})
            for offset in range(0, len(instances), body.chunk_size):
                if offset and not streaming.allow(state, principal):  # the first chunk was paid for by the request
                    yield streaming.sse("error", {"status": 429, "detail": "rate limit exceeded", "offset": offset})
                    return
                chunk = instances[offset : offset + body.chunk_size]
                out = await asyncio.to_thread(svc.predict, principal.tenant_id, name, chunk, explain=body.explain, caller=principal.user_id)
                yield streaming.sse("prediction", {"offset": offset, "count": len(chunk), **out})
            yield streaming.sse("done", {"total": len(instances)})
        except (NotFound, ServingError, ValueError) as exc:
            yield streaming.sse("error", {"status": 404 if isinstance(exc, NotFound) else 422, "detail": str(exc)})
        finally:
            slot.__exit__(None, None, None)

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/{name}/stream-token")
async def stream_token(name: str, state: AppState = StateDep, principal: Principal = Predictor) -> dict[str, Any]:
    """API-006: a single-use token (valid 60 s) to open ``/v1/endpoints/{name}/ws?token=…`` from a browser."""
    try:
        ServingService(state).get(principal.tenant_id, name)
    except NotFound as exc:
        raise _errors(exc) from exc
    return streaming.issue_stream_token(state, principal, name)


@router.websocket("/{name}/ws")
async def predict_ws(websocket: WebSocket, name: str, token: str | None = None) -> None:
    """API-006: WebSocket inference. Auth: ``?token=`` (stream token) or a first ``{"type": "auth", ...}`` message."""
    state: AppState = websocket.app.state.ap
    client_ip = websocket.client.host if websocket.client else None
    await websocket.accept()
    try:
        if token:
            principal = streaming.verify_stream_token(state, token, name)
        else:
            first = await asyncio.wait_for(websocket.receive_text(), timeout=10)
            principal = await asyncio.to_thread(streaming.authenticate_message, state, json.loads(first), client_ip)
    except (AuthError, ValueError, TimeoutError) as exc:
        await websocket.send_json({"error": {"status": 401, "detail": str(exc) or "authentication failed"}})
        await websocket.close(code=4401)
        return
    except WebSocketDisconnect:
        return
    if not has_permission(principal.role, Permission.PREDICT, principal.scopes if principal.method in SCOPED_METHODS else None):
        await websocket.send_json({"error": {"status": 403, "detail": "missing permission endpoints.predict"}})
        await websocket.close(code=4403)
        return
    if not network_allows(state, principal.tenant_id, client_ip):
        await websocket.send_json({"error": {"status": 403, "detail": "access from this IP address is not allowed"}})
        await websocket.close(code=4403)
        return
    svc = ServingService(state)
    try:
        svc.get(principal.tenant_id, name)
    except NotFound:
        await websocket.send_json({"error": {"status": 404, "detail": f"endpoint {name} not found"}})
        await websocket.close(code=4404)
        return
    try:
        slot = streaming.slots(state).hold(principal.tenant_id)
        slot.__enter__()
    except streaming.StreamLimitExceeded as exc:
        await websocket.send_json({"error": {"status": 429, "detail": str(exc)}})
        await websocket.close(code=4429)
        return
    state.audit.record(principal.tenant_id, principal.user_id, "endpoint.stream_open", endpoint=name, transport="websocket")
    await websocket.send_json({"type": "ready", "endpoint": name})
    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw) > streaming.WS_MAX_MESSAGE_BYTES:
                await websocket.send_json({"error": {"status": 413, "detail": "message too large"}})
                await websocket.close(code=1009)
                return
            try:
                msg = PredictBody.model_validate_json(raw)
                msg_id = json.loads(raw).get("id")
            except ValueError as exc:
                await websocket.send_json({"error": {"status": 422, "detail": str(exc)[:500]}})
                continue
            if not streaming.allow(state, principal):
                await websocket.send_json({"id": msg_id, "error": {"status": 429, "detail": "rate limit exceeded"}})
                continue
            try:
                out = await asyncio.to_thread(
                    svc.predict,
                    principal.tenant_id,
                    name,
                    msg.instances,
                    explain=msg.explain,
                    caller=principal.user_id,
                    horizon=msg.horizon,
                    history=msg.history,
                )
                from ..export_utils import jsonable

                await websocket.send_json(jsonable({"id": msg_id, **out}))
            except (NotFound, ServingError, ValueError) as exc:
                await websocket.send_json(
                    {"id": msg_id, "error": {"status": 404 if isinstance(exc, NotFound) else 422, "detail": str(exc)}}
                )
    except WebSocketDisconnect:
        return
    finally:
        slot.__exit__(None, None, None)


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
