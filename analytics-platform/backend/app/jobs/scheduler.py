"""Cron schedules that submit jobs (USR-007, SHR-004, API-011, ING-008).

* A schedule is a row in ``schedules``: a 5-field cron expression evaluated in an IANA time zone, an
  allowlisted job type and its parameters.
* :meth:`Scheduler.tick` finds due schedules and *claims* each run with a conditional UPDATE on
  ``next_run_at`` (``… WHERE id = ? AND next_run_at = <value we read>``). With several worker replicas
  ticking at once, exactly one UPDATE matches, so exactly one replica submits the job.
* Runs are submitted through :class:`JobService` as the schedule's owner, re-checking at every run that the
  owner still exists, is active and still holds the job type's permission. A run refused by a quota (MT-006)
  is skipped and recorded (``last_status = "skipped"``); the schedule moves on to its next run.
* The tick runs inside the job worker (every ``AP_SCHEDULER_TICK_SECONDS``) or standalone:
  ``python -m app.jobs.scheduler``.
"""

from __future__ import annotations

import logging
import signal
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import select, update

from ..auth.rbac import Permission, has_permission
from ..db.models import ApiKey, OAuthClient, Schedule, Tenant, User
from .core import JobService
from .cron import CronError, CronSchedule, parse_cron

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState
    from ..auth.service import Principal

log = logging.getLogger("app.scheduler")
SCOPED_METHODS = ("api_key", "oauth_client")
MAX_DUE_PER_TICK = 500


class ScheduleError(ValueError):
    """422: invalid cron expression, job type or parameters."""


Validator = Callable[["AppState", "Principal", dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True)
class Schedulable:
    job_type: str
    permission: Permission
    validate: Validator
    description: str


SCHEDULABLE: dict[str, Schedulable] = {}


def schedulable(job_type: str, permission: Permission, description: str) -> Callable[[Validator], Validator]:
    """Register a job type as schedulable. The validator checks (and normalizes) params for the caller."""

    def register(fn: Validator) -> Validator:
        SCHEDULABLE[job_type] = Schedulable(job_type, permission, fn, description)
        return fn

    return register


def load_schedulable_types() -> None:
    """Import the modules that register schedulable job types (and their handlers)."""
    from ..scheduling import builtin  # noqa: F401


def aware(ts: datetime | None) -> datetime | None:
    if ts is None:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=UTC)


def check_cron(state: AppState, expression: str, timezone: str) -> CronSchedule:
    try:
        cron = parse_cron(expression, timezone)
    except CronError as exc:
        raise ScheduleError(str(exc)) from exc
    minimum = state.settings.schedule_min_interval_minutes
    if cron.min_interval_minutes() < minimum:
        raise ScheduleError(f"schedules may run at most every {minimum} minutes")
    return cron


def owner_principal(state: AppState, schedule: Schedule) -> Principal | None:
    """The schedule's owner as a principal, as of now; None if the owner can no longer act."""
    from ..auth.service import Principal

    tid, owner = schedule.tenant_id, schedule.created_by
    now = datetime.now(UTC)
    with state.db.session(tid) as s:
        tenant = s.get(Tenant, tid)
        if tenant is None or tenant.status != "active":
            return None
        user = s.get(User, owner)
        if user is not None and user.tenant_id == tid:
            return None if user.disabled else Principal(tid, user.id, user.role, "jwt", email=user.email)
        key = s.get(ApiKey, owner)
        if key is not None and key.tenant_id == tid:
            if key.revoked_at is not None or (key.expires_at is not None and aware(key.expires_at) <= now):
                return None
            return Principal(tid, key.id, key.role, "api_key", scopes=list(key.scopes or []))
        client = s.get(OAuthClient, owner)
        if client is not None and client.tenant_id == tid:
            return (
                None if client.revoked_at is not None else Principal(tid, client.id, client.role, "oauth_client", list(client.scopes or []))
            )
    if state.settings.dev_auth:  # development header auth has no principal rows
        return Principal(tid, owner, schedule.owner_role, "dev")
    return None


def may_schedule(principal: Principal, job_type: str) -> bool:
    kind = SCHEDULABLE.get(job_type)
    if kind is None:
        return False
    return has_permission(principal.role, kind.permission, principal.scopes if principal.method in SCOPED_METHODS else None)


def schedule_out(sched: Schedule, *, upcoming: int = 0) -> dict[str, Any]:
    out = {
        "id": sched.id,
        "name": sched.name,
        "cron": sched.cron,
        "timezone": sched.timezone,
        "job_type": sched.job_type,
        "params": dict(sched.params or {}),
        "enabled": sched.enabled,
        "next_run_at": aware(sched.next_run_at),
        "last_run_at": aware(sched.last_run_at),
        "last_job_id": sched.last_job_id,
        "last_status": sched.last_status,
        "last_error": sched.last_error,
        "last_result": sched.last_result,
        "created_by": sched.created_by,
        "created_at": aware(sched.created_at),
        "updated_at": aware(sched.updated_at),
    }
    if upcoming and sched.enabled:
        try:
            out["upcoming"] = parse_cron(sched.cron, sched.timezone).upcoming(datetime.now(UTC), upcoming)
        except CronError:
            out["upcoming"] = []
    return out


class Scheduler:
    def __init__(self, state: AppState):
        self.state = state
        load_schedulable_types()

    def tick(self, now: datetime | None = None) -> list[dict[str, Any]]:
        """Submit every due schedule once. Returns what happened to each claimed schedule."""
        now = aware(now) or datetime.now(UTC)
        with self.state.db.session() as s:  # platform scope: due schedules of every tenant
            due = s.execute(
                select(Schedule.id, Schedule.tenant_id, Schedule.next_run_at)
                .where(Schedule.enabled.is_(True), Schedule.next_run_at.is_not(None), Schedule.next_run_at <= now)
                .order_by(Schedule.next_run_at)
                .limit(MAX_DUE_PER_TICK)
            ).all()
        results = []
        for schedule_id, tenant_id, due_at in due:
            try:
                outcome = self._run_due(schedule_id, tenant_id, due_at, now)
            except Exception:  # noqa: BLE001 - one bad schedule must not stop the others
                log.exception("schedule %s failed", schedule_id)
                continue
            if outcome is not None:
                results.append(outcome)
        return results

    def _claim(self, schedule_id: str, tenant_id: str, due_at: datetime, next_at: datetime, now: datetime) -> bool:
        with self.state.db.session(tenant_id) as s:
            claimed = s.execute(
                update(Schedule)
                .where(
                    Schedule.id == schedule_id,
                    Schedule.tenant_id == tenant_id,
                    Schedule.enabled.is_(True),
                    Schedule.next_run_at == due_at,
                )
                .values(next_run_at=next_at, last_run_at=now)
                .execution_options(synchronize_session=False)
            )
            return claimed.rowcount == 1

    def _run_due(self, schedule_id: str, tenant_id: str, due_at: datetime, now: datetime) -> dict[str, Any] | None:
        with self.state.db.session(tenant_id) as s:
            sched = s.get(Schedule, schedule_id)
            if sched is None:
                return None
            cron_text, tz = sched.cron, sched.timezone
        try:
            next_at = parse_cron(cron_text, tz).next_after(now)
        except CronError as exc:
            self._record(tenant_id, schedule_id, "failed", error=f"invalid schedule: {exc}", disable=True)
            return {"schedule_id": schedule_id, "status": "failed", "error": str(exc)}
        if not self._claim(schedule_id, tenant_id, due_at, next_at, now):
            return None  # another replica won this run
        return self.submit(schedule_id, tenant_id, trigger="schedule")

    def submit(self, schedule_id: str, tenant_id: str, *, trigger: str) -> dict[str, Any]:
        """Submit one run of a schedule as its owner (used by the tick and by "run now")."""
        from ..quotas import QuotaExceededError

        with self.state.db.session(tenant_id) as s:
            sched = s.get(Schedule, schedule_id)
            job_type, params = sched.job_type, dict(sched.params or {})
        principal = owner_principal(self.state, sched)
        if principal is None or not may_schedule(principal, job_type):
            error = "the schedule's owner can no longer run this job type"
            self._record(tenant_id, schedule_id, "skipped", error=error)
            self.state.audit.record(tenant_id, "system", "schedule.skipped", schedule_id=schedule_id, reason="owner_unauthorized")
            return {"schedule_id": schedule_id, "status": "skipped", "error": error}
        params = {**params, "schedule_id": schedule_id, "trigger": trigger}
        try:
            job = JobService(self.state).submit(tenant_id, job_type, params, principal.user_id)
        except QuotaExceededError as exc:
            self._record(tenant_id, schedule_id, "skipped", error=str(exc))
            self.state.audit.record(tenant_id, "system", "schedule.skipped", schedule_id=schedule_id, reason="quota", quota=exc.quota)
            return {"schedule_id": schedule_id, "status": "skipped", "error": str(exc)}
        except ValueError as exc:  # unknown job type (e.g. handler module not loaded)
            self._record(tenant_id, schedule_id, "failed", error=str(exc))
            return {"schedule_id": schedule_id, "status": "failed", "error": str(exc)}
        self._record(tenant_id, schedule_id, "submitted", job_id=job.id)
        self.state.audit.record(tenant_id, "system", "schedule.run", schedule_id=schedule_id, job_id=job.id, trigger=trigger)
        return {"schedule_id": schedule_id, "status": "submitted", "job_id": job.id}

    def _record(self, tenant_id: str, schedule_id: str, status: str, *, job_id: str | None = None, error: str | None = None, disable=False):
        with self.state.db.session(tenant_id) as s:
            sched = s.get(Schedule, schedule_id)
            if sched is None:
                return
            sched.last_status, sched.last_error = status, (error or None) and error[:2000]
            if job_id:
                sched.last_job_id = job_id
            if disable:
                sched.enabled = False


def record_result(state: AppState, tenant_id: str, schedule_id: str | None, snapshot: dict[str, Any]) -> None:
    """Store a job's bounded result snapshot on its schedule, for the UI (USR-007)."""
    if not schedule_id:
        return
    with state.db.session(tenant_id) as s:
        sched = s.get(Schedule, schedule_id)
        if sched is not None and sched.tenant_id == tenant_id:
            sched.last_result = {**snapshot, "at": datetime.now(UTC).isoformat()}


def main() -> None:  # pragma: no cover - process entry point
    """Standalone scheduler: ``python -m app.jobs.scheduler`` (safe to run with several replicas)."""
    from ..api.deps import build_state
    from . import handlers  # noqa: F401 - registers job handlers

    logging.basicConfig(level=logging.INFO, format='{"level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}')
    state = build_state()
    scheduler = Scheduler(state)
    interval = max(1.0, state.settings.scheduler_tick_seconds or 30.0)
    running = True

    def stop(*_):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log.info("scheduler started (tick every %.0fs)", interval)
    while running:
        try:
            for outcome in scheduler.tick():
                log.info("schedule %s: %s", outcome["schedule_id"], outcome["status"])
        except Exception:  # noqa: BLE001 - keep the loop alive
            log.exception("scheduler tick failed")
        deadline = time.monotonic() + interval
        while running and time.monotonic() < deadline:
            time.sleep(0.5)


if __name__ == "__main__":  # pragma: no cover
    main()
