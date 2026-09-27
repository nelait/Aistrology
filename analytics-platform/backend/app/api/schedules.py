"""Schedules (Phase 3): cron-scheduled jobs for analytics, dashboard deliveries, drift checks and stream compaction."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..auth.rbac import Permission, Role
from ..auth.service import Principal
from ..db.models import Schedule
from ..jobs.scheduler import (
    SCHEDULABLE,
    ScheduleError,
    Scheduler,
    check_cron,
    load_schedulable_types,
    may_schedule,
    owner_principal,
    schedule_out,
)
from .deps import AppState, PrincipalDep, StateDep, require

router = APIRouter(prefix="/v1/schedules", tags=["schedules"])
Viewer = require(Permission.VIEW)


class ScheduleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    cron: str = Field(min_length=9, max_length=200, description="5-field cron: minute hour day-of-month month day-of-week")
    timezone: str = Field(default="UTC", max_length=64, description="IANA time zone, e.g. Europe/Berlin")
    job_type: str = Field(max_length=64)
    params: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True


class ScheduleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    cron: str | None = Field(default=None, min_length=9, max_length=200)
    timezone: str | None = Field(default=None, max_length=64)
    params: dict[str, Any] | None = None
    enabled: bool | None = None


def _validate(state: AppState, principal: Principal, job_type: str, params: dict[str, Any]) -> dict[str, Any]:
    load_schedulable_types()
    kind = SCHEDULABLE.get(job_type)
    if kind is None:
        raise HTTPException(status_code=422, detail=f"job type {job_type!r} can't be scheduled; allowed: {sorted(SCHEDULABLE)}")
    if not may_schedule(principal, job_type):
        raise HTTPException(status_code=403, detail=f"missing permission {kind.permission.value}")
    try:
        return kind.validate(state, principal, params)
    except ScheduleError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _next_run(state: AppState, cron: str, timezone: str) -> datetime:
    try:
        return check_cron(state, cron, timezone).next_after(datetime.now(UTC))
    except ScheduleError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _load(state: AppState, principal: Principal, schedule_id: str, s) -> Schedule:
    sched = s.get(Schedule, schedule_id)
    if sched is None or sched.tenant_id != principal.tenant_id:
        raise HTTPException(status_code=404, detail="schedule not found")
    if principal.role != Role.ADMIN.value and sched.created_by != principal.user_id:
        raise HTTPException(status_code=404, detail="schedule not found")
    return sched


@router.get("/types")
async def schedulable_types(principal: Principal = Viewer) -> list[dict[str, Any]]:
    load_schedulable_types()
    return [
        {
            "job_type": k.job_type,
            "permission": k.permission.value,
            "description": k.description,
            "allowed": may_schedule(principal, k.job_type),
        }
        for k in SCHEDULABLE.values()
    ]


@router.post("", status_code=201)
async def create_schedule(body: ScheduleCreate, state: AppState = StateDep, principal: Principal = PrincipalDep) -> dict[str, Any]:
    params = await asyncio.to_thread(_validate, state, principal, body.job_type, body.params)
    next_run = _next_run(state, body.cron, body.timezone)
    with state.db.session(principal.tenant_id) as s:
        sched = Schedule(
            tenant_id=principal.tenant_id,
            name=body.name,
            cron=" ".join(body.cron.split()),
            timezone=body.timezone,
            job_type=body.job_type,
            params=params,
            enabled=body.enabled,
            next_run_at=next_run if body.enabled else None,
            owner_role=principal.role,
            created_by=principal.user_id,
        )
        s.add(sched)
        s.flush()
        out = schedule_out(sched, upcoming=5)
    state.audit.record(
        principal.tenant_id,
        principal.user_id,
        "schedule.create",
        schedule_id=out["id"],
        job_type=body.job_type,
        cron=out["cron"],
        timezone=body.timezone,
    )
    return out


@router.get("")
async def list_schedules(job_type: str | None = None, state: AppState = StateDep, principal: Principal = Viewer) -> list[dict[str, Any]]:
    """Admins see every schedule in the tenant; everyone else sees the schedules they own."""
    with state.db.session(principal.tenant_id) as s:
        q = select(Schedule).where(Schedule.tenant_id == principal.tenant_id).order_by(Schedule.created_at)
        if principal.role != Role.ADMIN.value:
            q = q.where(Schedule.created_by == principal.user_id)
        if job_type:
            q = q.where(Schedule.job_type == job_type)
        return [schedule_out(x) for x in s.execute(q).scalars()]


@router.get("/{schedule_id}")
async def get_schedule(schedule_id: str, state: AppState = StateDep, principal: Principal = Viewer) -> dict[str, Any]:
    with state.db.session(principal.tenant_id) as s:
        return schedule_out(_load(state, principal, schedule_id, s), upcoming=5)


@router.patch("/{schedule_id}")
async def update_schedule(
    schedule_id: str, body: ScheduleUpdate, state: AppState = StateDep, principal: Principal = PrincipalDep
) -> dict[str, Any]:
    with state.db.session(principal.tenant_id) as s:
        sched = _load(state, principal, schedule_id, s)
        s.expunge(sched)
    params = sched.params
    if body.params is not None or not may_schedule(principal, sched.job_type):
        params = await asyncio.to_thread(
            _validate, state, principal, sched.job_type, body.params if body.params is not None else sched.params
        )
        if sched.created_by != principal.user_id:
            # The schedule keeps running as its owner, so the new parameters must be valid for the owner too.
            owner = owner_principal(state, sched)
            if owner is None:
                raise HTTPException(status_code=409, detail="the schedule's owner can no longer run it; create a new schedule")
            params = await asyncio.to_thread(_validate, state, owner, sched.job_type, params)
    cron = " ".join(body.cron.split()) if body.cron is not None else sched.cron
    timezone = body.timezone if body.timezone is not None else sched.timezone
    enabled = body.enabled if body.enabled is not None else sched.enabled
    next_run = _next_run(state, cron, timezone)
    with state.db.session(principal.tenant_id) as s:
        row = _load(state, principal, schedule_id, s)
        row.name = body.name or row.name
        row.cron, row.timezone, row.params, row.enabled = cron, timezone, params, enabled
        row.next_run_at = next_run if enabled else None
        s.flush()
        out = schedule_out(row, upcoming=5)
    changed = sorted(k for k, v in body.model_dump().items() if v is not None)
    state.audit.record(principal.tenant_id, principal.user_id, "schedule.update", schedule_id=schedule_id, fields=changed)
    return out


@router.delete("/{schedule_id}", status_code=204)
async def delete_schedule(schedule_id: str, state: AppState = StateDep, principal: Principal = Viewer) -> None:
    with state.db.session(principal.tenant_id) as s:
        s.delete(_load(state, principal, schedule_id, s))
    state.audit.record(principal.tenant_id, principal.user_id, "schedule.delete", schedule_id=schedule_id)


@router.post("/{schedule_id}/run", status_code=202)
async def run_schedule_now(schedule_id: str, state: AppState = StateDep, principal: Principal = PrincipalDep) -> dict[str, Any]:
    """Run once now, as the schedule's owner (the regular timetable is unchanged)."""
    load_schedulable_types()
    with state.db.session(principal.tenant_id) as s:
        sched = _load(state, principal, schedule_id, s)
        job_type = sched.job_type
    if not may_schedule(principal, job_type):
        raise HTTPException(status_code=403, detail=f"missing permission {SCHEDULABLE[job_type].permission.value}")
    state.audit.record(principal.tenant_id, principal.user_id, "schedule.run_now", schedule_id=schedule_id)
    outcome = await asyncio.to_thread(Scheduler(state).submit, schedule_id, principal.tenant_id, trigger="manual")
    if outcome["status"] == "skipped":
        raise HTTPException(status_code=409 if "owner" in (outcome.get("error") or "") else 429, detail=outcome)
    if outcome["status"] == "failed":
        raise HTTPException(status_code=422, detail=outcome)
    return outcome
