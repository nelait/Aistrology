"""Public view-only dashboard links (SHR-001a) and the tenant sharing setting."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..auth.rbac import Permission
from ..auth.service import Principal
from ..dashboards.service import DashboardOut, NotFound
from ..public_links import SETTING_KEY, PublicLinksDisabled, PublicLinkService, SharingSettings, sharing_settings
from .dashboards import _HANDLED, _errors
from .deps import AppState, StateDep, require

router = APIRouter(prefix="/v1", tags=["sharing"])
Admin = require(Permission.MANAGE_TENANT)
DashEditor = require(Permission.EDIT_DASHBOARDS)


class PublicLinkCreate(BaseModel):
    ttl_hours: int = Field(default=168, ge=1, le=24 * 365)


class FiltersBody(BaseModel):
    filters: dict[str, Any] = Field(default_factory=dict)


async def _call(fn, *args):
    """Same error mapping as the dashboards API, plus the tenant switch."""
    try:
        return await asyncio.to_thread(fn, *args)
    except PublicLinksDisabled as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except NotFound as exc:
        raise HTTPException(status_code=404, detail="not found") from exc
    except _HANDLED as exc:
        raise _errors(exc) from exc


@router.get("/tenant/sharing", response_model=SharingSettings)
async def get_sharing(state: AppState = StateDep, principal: Principal = Admin) -> SharingSettings:
    return sharing_settings(state, principal.tenant_id)


@router.put("/tenant/sharing", response_model=SharingSettings)
async def put_sharing(body: SharingSettings, state: AppState = StateDep, principal: Principal = Admin) -> SharingSettings:
    """Disabling public links also stops every existing link immediately."""
    state.put_setting(principal.tenant_id, SETTING_KEY, body.model_dump())
    state.audit.record(principal.tenant_id, principal.user_id, "tenant.sharing.update", **body.model_dump())
    return body


@router.post("/dashboards/{dashboard_id}/public-links", status_code=201)
async def create_public_link(
    dashboard_id: str, body: PublicLinkCreate | None = None, state: AppState = StateDep, principal: Principal = DashEditor
) -> dict[str, Any]:
    """The token is shown once. Anyone with the link can view the dashboard until it expires or is revoked."""
    ttl = (body or PublicLinkCreate()).ttl_hours
    link, token = await _call(PublicLinkService(state).create, principal, dashboard_id, ttl)
    state.audit.record(
        principal.tenant_id, principal.user_id, "dashboard.public_link.create", dashboard_id=dashboard_id, link_id=link["id"], ttl_hours=ttl
    )
    return {**link, "token": token, "path": f"/v1/public/{token}"}


@router.get("/dashboards/{dashboard_id}/public-links")
async def list_public_links(dashboard_id: str, state: AppState = StateDep, principal: Principal = DashEditor) -> list[dict[str, Any]]:
    return await _call(PublicLinkService(state).list, principal, dashboard_id)


@router.delete("/dashboards/{dashboard_id}/public-links/{link_id}", status_code=204)
async def revoke_public_link(dashboard_id: str, link_id: str, state: AppState = StateDep, principal: Principal = DashEditor) -> None:
    await _call(PublicLinkService(state).revoke, principal, dashboard_id, link_id)
    state.audit.record(principal.tenant_id, principal.user_id, "dashboard.public_link.revoke", dashboard_id=dashboard_id, link_id=link_id)


# -- anonymous ----------------------------------------------------------------------------------------------


def _throttle(state: AppState, request: Request) -> None:
    ip = request.client.host if request.client else "-"
    if not state.rate_limiter.allow(f"public:{ip}", 300):
        raise HTTPException(status_code=429, detail="rate limit exceeded", headers={"Retry-After": "60"})


@router.get("/public/{token}", response_model=DashboardOut)
async def public_dashboard(token: str, request: Request, state: AppState = StateDep) -> DashboardOut:
    _throttle(state, request)
    _, _, dash = await _call(PublicLinkService(state).resolve, token)
    return dash


@router.post("/public/{token}/widgets/{widget_id}/data")
async def public_widget_data(
    token: str, widget_id: str, request: Request, body: FiltersBody | None = None, state: AppState = StateDep
) -> dict[str, Any]:
    _throttle(state, request)
    return await _call(PublicLinkService(state).widget_data, token, widget_id, (body or FiltersBody()).filters)
