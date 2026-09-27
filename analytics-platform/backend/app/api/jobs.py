"""Job queue dashboard (MT-004), notifications (NTF-001) and data exports (SOC-PRV-003)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import or_, select

from ..auth.rbac import Permission, has_permission
from ..auth.service import Principal
from ..db.models import Notification
from ..jobs.core import JobOut, JobService
from .deps import AppState, PrincipalDep, StateDep, require

router = APIRouter(prefix="/v1", tags=["jobs"])


class NotificationOut(BaseModel):
    id: str
    kind: str
    title: str
    body: dict
    read: bool


@router.get("/jobs", response_model=list[JobOut])
async def list_jobs(
    status: str | None = None, state: AppState = StateDep, principal: Principal = require(Permission.READ_DATA)
) -> list[JobOut]:
    return JobService(state).list(principal.tenant_id, status)


@router.get("/jobs/{job_id}", response_model=JobOut)
async def get_job(job_id: str, state: AppState = StateDep, principal: Principal = PrincipalDep) -> JobOut:
    """Readable with data.read, or by whoever submitted the job (e.g. a predict-only key polling its batch job)."""
    try:
        job = JobService(state).get(principal.tenant_id, job_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail="job not found") from exc
    scopes = principal.scopes if principal.method == "api_key" else None
    if job.created_by != principal.user_id and not has_permission(principal.role, Permission.READ_DATA, scopes):
        raise HTTPException(status_code=404, detail="job not found")
    return job


@router.post("/jobs/{job_id}/cancel", response_model=JobOut)
async def cancel_job(job_id: str, state: AppState = StateDep, principal: Principal = require(Permission.WRITE_DATA)) -> JobOut:
    try:
        return JobService(state).cancel(principal.tenant_id, job_id, principal.user_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail="job not found") from exc


@router.get("/notifications", response_model=list[NotificationOut])
async def notifications(
    unread_only: bool = False, state: AppState = StateDep, principal: Principal = PrincipalDep
) -> list[NotificationOut]:
    with state.db.session(principal.tenant_id) as s:
        q = (
            select(Notification)
            .where(
                Notification.tenant_id == principal.tenant_id,
                or_(Notification.user_id == principal.user_id, Notification.user_id.is_(None)),
            )
            .order_by(Notification.created_at.desc())
            .limit(200)
        )
        if unread_only:
            q = q.where(Notification.read.is_(False))
        return [NotificationOut(id=n.id, kind=n.kind, title=n.title, body=n.body, read=n.read) for n in s.execute(q).scalars()]


@router.post("/notifications/{notification_id}/read", status_code=204)
async def mark_read(notification_id: str, state: AppState = StateDep, principal: Principal = PrincipalDep) -> None:
    with state.db.session(principal.tenant_id) as s:
        n = s.get(Notification, notification_id)
        if n is None or n.tenant_id != principal.tenant_id or n.user_id not in (None, principal.user_id):
            raise HTTPException(status_code=404, detail="notification not found")
        n.read = True


@router.post("/tenant/exports", response_model=JobOut, status_code=202)
async def request_export(state: AppState = StateDep, principal: Principal = require(Permission.MANAGE_TENANT)) -> JobOut:
    """SOC-PRV-003: start a full data export (DSAR)."""
    return JobService(state).submit(principal.tenant_id, "tenant.export", {}, principal.user_id)


@router.get("/tenant/exports/{job_id}")
async def download_export(job_id: str, state: AppState = StateDep, principal: Principal = require(Permission.MANAGE_TENANT)) -> Response:
    try:
        job = JobService(state).get(principal.tenant_id, job_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail="export not found") from exc
    if job.type != "tenant.export" or job.status != "succeeded":
        raise HTTPException(status_code=409, detail=f"export is {job.status}")
    data = state.objects.get_bytes(principal.tenant_id, job.result["export_key"])
    state.audit.record(principal.tenant_id, principal.user_id, "tenant.export.download", job_id=job_id)
    return Response(data, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="export-{job_id}.zip"'})
