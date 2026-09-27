"""Saved analytics, dashboards, embedding and webhooks (Modules 4, 6, 7)."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..analytics.saved import AnalyticCreate, AnalyticOut, AnalyticsService
from ..analytics.saved import NotFound as AnalyticNotFound
from ..analytics.sql_sandbox import QueryResult, QueryTimeout, UnsafeQueryError
from ..auth.rbac import Permission
from ..auth.service import Principal
from ..dashboards.service import TEMPLATES, DashboardOut, DashboardService, DashboardSpec, Forbidden
from ..dashboards.service import NotFound as DashboardNotFound
from ..db.models import Webhook, WebhookDelivery
from ..jobs.core import JobService
from ..storage.datasets import DatasetNotFound
from ..webhooks import WebhookDispatcher, WebhookError
from .deps import AppState, StateDep, require

router = APIRouter(prefix="/v1", tags=["analytics", "dashboards", "webhooks"])
Viewer = require(Permission.VIEW)
Creator = require(Permission.CREATE_ANALYTICS)
DashEditor = require(Permission.EDIT_DASHBOARDS)


def _errors(exc: Exception) -> HTTPException:
    if isinstance(exc, (DashboardNotFound, AnalyticNotFound, DatasetNotFound, LookupError)):
        return HTTPException(status_code=404, detail=f"not found: {exc}")
    if isinstance(exc, Forbidden):
        return HTTPException(status_code=403, detail=str(exc))
    if isinstance(exc, QueryTimeout):
        return HTTPException(status_code=408, detail=str(exc))
    return HTTPException(status_code=422, detail=str(exc))


_HANDLED = (DashboardNotFound, AnalyticNotFound, DatasetNotFound, Forbidden, UnsafeQueryError, QueryTimeout, LookupError, ValueError)


async def _call(fn, *args, **kwargs):
    try:
        return await asyncio.to_thread(fn, *args, **kwargs)
    except _HANDLED as exc:
        raise _errors(exc) from exc


# -- saved analytics (USR-005/006) ----------------------------------------------------------------------


class RunBody(BaseModel):
    params: dict[str, Any] = Field(default_factory=dict)
    filters: dict[str, Any] = Field(default_factory=dict)
    row_limit: int = Field(default=5000, ge=1, le=10_000)


@router.post("/analytics", response_model=AnalyticOut, status_code=201)
async def create_analytic(body: AnalyticCreate, state: AppState = StateDep, principal: Principal = Creator) -> AnalyticOut:
    return await _call(AnalyticsService(state).create, principal.tenant_id, principal.user_id, body)


@router.get("/analytics", response_model=list[AnalyticOut])
async def list_analytics(dataset_id: str | None = None, state: AppState = StateDep, principal: Principal = Viewer) -> list[AnalyticOut]:
    return AnalyticsService(state).list(principal.tenant_id, dataset_id)


@router.get("/analytics/{analytic_id}", response_model=AnalyticOut)
async def get_analytic(analytic_id: str, state: AppState = StateDep, principal: Principal = Viewer) -> AnalyticOut:
    return await _call(AnalyticsService(state).get, principal.tenant_id, analytic_id)


@router.delete("/analytics/{analytic_id}", status_code=204)
async def delete_analytic(analytic_id: str, state: AppState = StateDep, principal: Principal = Creator) -> None:
    await _call(AnalyticsService(state).delete, principal.tenant_id, principal.user_id, analytic_id)


@router.post("/analytics/{analytic_id}/run", response_model=QueryResult)
async def run_analytic(
    analytic_id: str, body: RunBody | None = None, state: AppState = StateDep, principal: Principal = Viewer
) -> QueryResult:
    body = body or RunBody()
    return await _call(AnalyticsService(state).run, principal.tenant_id, analytic_id, body.params, body.filters, body.row_limit)


# -- dashboards (DSH/WDG/SHR) -----------------------------------------------------------------------------


class DashboardCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    spec: DashboardSpec = Field(default_factory=DashboardSpec)


class DashboardUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    spec: DashboardSpec | None = None


class FromTemplate(BaseModel):
    template: str
    name: str = Field(min_length=1, max_length=200)
    values: dict[str, str] = Field(default_factory=dict, description="Placeholders, e.g. dataset_id, measure, dimension")


class ShareBody(BaseModel):
    user_id: str = Field(min_length=1, max_length=64, description="User id, or * for everyone in the organization")
    role: str | None = Field(default="viewer", pattern="^(editor|viewer)$")


class FiltersBody(BaseModel):
    filters: dict[str, Any] = Field(default_factory=dict)


class EmbedBody(BaseModel):
    ttl_minutes: int = Field(default=60, ge=1, le=60 * 24 * 30)


@router.get("/dashboards/templates")
async def dashboard_templates(principal: Principal = Viewer) -> list[dict[str, Any]]:
    return [{"id": k, "name": v["name"], "description": v["description"]} for k, v in TEMPLATES.items()]


@router.post("/dashboards/from-template", response_model=DashboardOut, status_code=201)
async def create_from_template(body: FromTemplate, state: AppState = StateDep, principal: Principal = DashEditor) -> DashboardOut:
    return await _call(DashboardService(state).from_template, principal, body.template, body.name, body.values)


@router.post("/dashboards", response_model=DashboardOut, status_code=201)
async def create_dashboard(body: DashboardCreate, state: AppState = StateDep, principal: Principal = DashEditor) -> DashboardOut:
    return DashboardService(state).create(principal, body.name, body.spec)


@router.get("/dashboards", response_model=list[DashboardOut])
async def list_dashboards(archived: bool = False, state: AppState = StateDep, principal: Principal = Viewer) -> list[DashboardOut]:
    return DashboardService(state).list(principal, archived)


@router.get("/dashboards/{dashboard_id}", response_model=DashboardOut)
async def get_dashboard(dashboard_id: str, state: AppState = StateDep, principal: Principal = Viewer) -> DashboardOut:
    return await _call(DashboardService(state).get, principal, dashboard_id)


@router.put("/dashboards/{dashboard_id}", response_model=DashboardOut)
async def update_dashboard(
    dashboard_id: str, body: DashboardUpdate, state: AppState = StateDep, principal: Principal = Viewer
) -> DashboardOut:
    return await _call(DashboardService(state).update, principal, dashboard_id, body.name, body.spec)


@router.delete("/dashboards/{dashboard_id}", status_code=204)
async def delete_dashboard(dashboard_id: str, state: AppState = StateDep, principal: Principal = Viewer) -> None:
    await _call(DashboardService(state).delete, principal, dashboard_id)


@router.post("/dashboards/{dashboard_id}/clone", response_model=DashboardOut, status_code=201)
async def clone_dashboard(dashboard_id: str, state: AppState = StateDep, principal: Principal = DashEditor) -> DashboardOut:
    return await _call(DashboardService(state).clone, principal, dashboard_id)


@router.post("/dashboards/{dashboard_id}/archive", response_model=DashboardOut)
async def archive_dashboard(
    dashboard_id: str, archived: bool = True, state: AppState = StateDep, principal: Principal = Viewer
) -> DashboardOut:
    return await _call(DashboardService(state).set_archived, principal, dashboard_id, archived)


@router.post("/dashboards/{dashboard_id}/share", response_model=DashboardOut)
async def share_dashboard(dashboard_id: str, body: ShareBody, state: AppState = StateDep, principal: Principal = Viewer) -> DashboardOut:
    return await _call(DashboardService(state).share, principal, dashboard_id, body.user_id, body.role)


@router.post("/dashboards/{dashboard_id}/widgets/{widget_id}/data")
async def widget_data(
    dashboard_id: str, widget_id: str, body: FiltersBody | None = None, state: AppState = StateDep, principal: Principal = Viewer
) -> dict:
    return await _call(DashboardService(state).widget_data, principal, dashboard_id, widget_id, (body or FiltersBody()).filters)


@router.post("/dashboards/{dashboard_id}/export", response_class=HTMLResponse)
async def export_dashboard(dashboard_id: str, body: FiltersBody | None = None, state: AppState = StateDep, principal: Principal = Viewer):
    """DSH-009a: interactive HTML snapshot. JSON export = GET /dashboards/{id}; PNG/PDF are rendered client-side."""
    html = await _call(DashboardService(state).export_html, principal, dashboard_id, (body or FiltersBody()).filters)
    return HTMLResponse(html, headers={"Content-Disposition": f'attachment; filename="dashboard-{dashboard_id}.html"'})


@router.post("/dashboards/{dashboard_id}/embed-token")
async def embed_token(
    dashboard_id: str, body: EmbedBody | None = None, state: AppState = StateDep, principal: Principal = DashEditor
) -> dict[str, Any]:
    """SHR-003: a signed, expiring token for embedding a read-only dashboard in another site."""
    ttl = (body or EmbedBody()).ttl_minutes
    token = await _call(DashboardService(state).embed_token, principal, dashboard_id, ttl)
    state.audit.record(principal.tenant_id, principal.user_id, "dashboard.embed_token", dashboard_id=dashboard_id, ttl_minutes=ttl)
    return {"token": token, "expires_in_minutes": ttl, "embed_path": f"/v1/embed/{token}"}


@router.get("/embed/{token}", response_model=DashboardOut)
async def embed_get(token: str, state: AppState = StateDep) -> DashboardOut:
    _, dash = await _call(DashboardService(state).resolve_embed, token)
    return dash


@router.post("/embed/{token}/widgets/{widget_id}/data")
async def embed_widget_data(token: str, widget_id: str, body: FiltersBody | None = None, state: AppState = StateDep) -> dict:
    return await _call(DashboardService(state).embed_widget_data, token, widget_id, (body or FiltersBody()).filters)


# -- webhooks (WHK-001/003) ----------------------------------------------------------------------------------


class WebhookCreate(BaseModel):
    url: str = Field(max_length=2000)
    events: list[str] = Field(min_length=1, max_length=20)


Admin = require(Permission.MANAGE_TENANT)


def _dispatcher(state: AppState) -> WebhookDispatcher:
    return state.extras.setdefault("webhooks", WebhookDispatcher(state))


@router.post("/webhooks", status_code=201)
async def create_webhook(body: WebhookCreate, state: AppState = StateDep, principal: Principal = Admin) -> dict[str, Any]:
    try:
        hook, secret = await asyncio.to_thread(_dispatcher(state).create, principal.tenant_id, principal.user_id, body.url, body.events)
    except WebhookError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"id": hook.id, "url": hook.url, "events": hook.events, "secret": secret}


@router.get("/webhooks")
async def list_webhooks(state: AppState = StateDep, principal: Principal = Admin) -> list[dict[str, Any]]:
    with state.db.session(principal.tenant_id) as s:
        return [
            {"id": h.id, "url": h.url, "events": h.events, "active": h.active, "created_at": h.created_at}
            for h in s.execute(select(Webhook).where(Webhook.tenant_id == principal.tenant_id)).scalars()
        ]


@router.delete("/webhooks/{webhook_id}", status_code=204)
async def delete_webhook(webhook_id: str, state: AppState = StateDep, principal: Principal = Admin) -> None:
    with state.db.session(principal.tenant_id) as s:
        hook = s.get(Webhook, webhook_id)
        if hook is None or hook.tenant_id != principal.tenant_id:
            raise HTTPException(status_code=404, detail="webhook not found")
        hook.active = False
        secret_name = hook.secret_name
    state.secrets.delete(principal.tenant_id, secret_name)
    state.audit.record(principal.tenant_id, principal.user_id, "webhook.delete", webhook_id=webhook_id)


@router.get("/webhooks/{webhook_id}/deliveries")
async def deliveries(webhook_id: str, state: AppState = StateDep, principal: Principal = Admin) -> list[dict[str, Any]]:
    with state.db.session(principal.tenant_id) as s:
        rows = s.execute(
            select(WebhookDelivery)
            .where(WebhookDelivery.tenant_id == principal.tenant_id, WebhookDelivery.webhook_id == webhook_id)
            .order_by(WebhookDelivery.created_at.desc())
            .limit(200)
        ).scalars()
        return [
            {
                "id": d.id,
                "event": d.event,
                "status": d.status,
                "attempts": d.attempts,
                "response_code": d.response_code,
                "created_at": d.created_at,
                "delivered_at": d.delivered_at,
            }
            for d in rows
        ]


@router.post("/webhooks/deliveries/{delivery_id}/retry", status_code=202)
async def retry_delivery(delivery_id: str, state: AppState = StateDep, principal: Principal = Admin) -> dict[str, Any]:
    with state.db.session(principal.tenant_id) as s:
        d = s.get(WebhookDelivery, delivery_id)
        if d is None or d.tenant_id != principal.tenant_id:
            raise HTTPException(status_code=404, detail="delivery not found")
        d.status = "pending"
    job = JobService(state).submit(principal.tenant_id, "webhook.deliver", {"delivery_id": delivery_id}, principal.user_id, max_attempts=5)
    return {"job_id": job.id}
