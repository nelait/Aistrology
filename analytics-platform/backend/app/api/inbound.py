"""Incoming webhooks (WHK-002): admin management and the public, signature-authenticated receiver."""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..auth.rbac import Permission
from ..auth.service import Principal
from ..db.models import InboundHook
from ..inbound_hooks import MAX_BODY_BYTES, InboundHookError, SignatureError, create_hook, trigger
from ..jobs.core import JobOut
from ..storage.datasets import TENANT_ID_RE
from .deps import AppState, StateDep, require

router = APIRouter(tags=["webhooks"])
Admin = require(Permission.MANAGE_TENANT)


class InboundHookCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    action: Literal["predict", "ingest"]
    endpoint: str | None = Field(default=None, max_length=100, description="predict: the endpoint to score the rows with")
    dataset_id: str | None = Field(default=None, max_length=40, description="ingest: the single-table dataset to update")
    mode: Literal["append", "replace"] = "append"


def _path(tenant_id: str, hook_id: str) -> str:
    return f"/hooks/in/{tenant_id}/{hook_id}"


def _out(h: InboundHook) -> dict[str, Any]:
    return {
        "id": h.id,
        "name": h.name,
        "action": h.action,
        "config": dict(h.config),
        "active": h.active,
        "path": _path(h.tenant_id, h.id),
        "created_by": h.created_by,
        "created_at": h.created_at,
        "last_triggered_at": h.last_triggered_at,
    }


@router.post("/v1/inbound-hooks", status_code=201)
async def create_inbound_hook(body: InboundHookCreate, state: AppState = StateDep, principal: Principal = Admin) -> dict[str, Any]:
    """The signing ``secret`` is shown once."""
    config = {"endpoint": body.endpoint} if body.action == "predict" else {"dataset_id": body.dataset_id, "mode": body.mode}
    if body.action == "ingest" and body.dataset_id:
        from .deps import guard_dataset

        guard_dataset(state, principal, body.dataset_id)
    try:
        hook, secret = await asyncio.to_thread(create_hook, state, principal.tenant_id, principal.user_id, body.name, body.action, config)
    except InboundHookError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    state.audit.record(principal.tenant_id, principal.user_id, "inbound_hook.create", hook_id=hook.id, hook_action=body.action, **config)
    return {**_out(hook), "secret": secret, "signature_header": "X-AP-Signature"}


@router.get("/v1/inbound-hooks")
async def list_inbound_hooks(state: AppState = StateDep, principal: Principal = Admin) -> list[dict[str, Any]]:
    with state.db.session(principal.tenant_id) as s:
        rows = s.execute(select(InboundHook).where(InboundHook.tenant_id == principal.tenant_id).order_by(InboundHook.created_at))
        return [_out(h) for h in rows.scalars()]


@router.delete("/v1/inbound-hooks/{hook_id}", status_code=204)
async def delete_inbound_hook(hook_id: str, state: AppState = StateDep, principal: Principal = Admin) -> None:
    with state.db.session(principal.tenant_id) as s:
        hook = s.get(InboundHook, hook_id)
        if hook is None or hook.tenant_id != principal.tenant_id:
            raise HTTPException(status_code=404, detail="inbound hook not found")
        hook.active = False
        secret_name = hook.secret_name
    state.secrets.delete(principal.tenant_id, secret_name)
    state.audit.record(principal.tenant_id, principal.user_id, "inbound_hook.delete", hook_id=hook_id)


@router.post("/hooks/in/{tenant_id}/{hook_id}", status_code=202, response_model=JobOut)
async def receive(
    tenant_id: str,
    hook_id: str,
    request: Request,
    x_ap_signature: str | None = Header(None, max_length=200),
    content_type: str | None = Header(None),
    state: AppState = StateDep,
) -> JobOut:
    """Unauthenticated except for the HMAC signature; queues the hook's action and returns the job."""
    if not TENANT_ID_RE.match(tenant_id):
        raise HTTPException(status_code=404, detail="inbound hook not found")
    ip = request.client.host if request.client else "-"
    if not state.rate_limiter.allow(f"inbound:{hook_id}:{ip}", 120):
        raise HTTPException(status_code=429, detail="rate limit exceeded", headers={"Retry-After": "60"})
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="payload too large")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail="payload too large")
    try:
        return await asyncio.to_thread(trigger, state, tenant_id, hook_id, bytes(body), x_ap_signature, content_type or "")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail="inbound hook not found") from exc
    except SignatureError as exc:
        state.audit.record(tenant_id, f"inbound:{hook_id}", "inbound_hook.rejected", reason=str(exc), ip=ip)
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except InboundHookError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
