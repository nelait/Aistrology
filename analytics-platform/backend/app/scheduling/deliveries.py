"""Scheduled deliveries: saved analytics (USR-007) and dashboard snapshots (SHR-004).

* Recipients are **users of the tenant** (by id), never free-form addresses, and each recipient must be able to
  see the data being sent: the analytic's dataset project (AUTH-003) or the dashboard (SHR-002). This is checked
  when the schedule is saved and again at every delivery; recipients who lost access are skipped.
* Chat destinations are the tenant's Slack / Teams destinations (NTF-003); posts go through the existing
  ``notification.chat`` job (SSRF-checked, retried).
* Each email is its own ``delivery.email`` job (per-recipient retries). Attachments are stored encrypted in the
  tenant's object store and read by the delivery job, so no data travels through the queue.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import pandas as pd
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select

from ..db.models import ChatDestination, Dashboard, User
from ..jobs.core import JobContext, JobService, PermanentJobError, job_handler
from ..jobs.scheduler import ScheduleError, owner_principal, record_result
from ..notify.email import Attachment, Email, email_sender

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState
    from ..auth.service import Principal

MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
SNAPSHOT_ROWS = 50
CHAT_PREVIEW_ROWS = 5


class DeliveryTargets(BaseModel):
    recipients: list[str] = Field(default_factory=list, max_length=50, description="User ids in the tenant")
    chat_destinations: list[str] = Field(default_factory=list, max_length=10, description="Slack / Teams destination ids")


class AnalyticRunParams(DeliveryTargets):
    analytic_id: str = Field(min_length=1, max_length=40)
    params: dict[str, Any] = Field(default_factory=dict)
    filters: dict[str, Any] = Field(default_factory=dict)
    row_limit: int = Field(default=1000, ge=1, le=10_000)


class DashboardDeliveryParams(DeliveryTargets):
    dashboard_id: str = Field(min_length=1, max_length=40)
    filters: dict[str, Any] = Field(default_factory=dict)
    public_link: bool = Field(default=True, description="Chat posts get a short-lived public link when public links are enabled")


def _parse(model: type[BaseModel], params: dict[str, Any]) -> BaseModel:
    try:
        return model.model_validate(params)
    except ValidationError as exc:
        raise ScheduleError(exc.errors(include_url=False, include_context=False)[0]["msg"]) from exc


def _user_principal(state: AppState, tenant_id: str, user_id: str) -> Principal | None:
    from ..auth.service import Principal

    with state.db.session(tenant_id) as s:
        user = s.get(User, user_id)
        if user is None or user.tenant_id != tenant_id or user.disabled:
            return None
        return Principal(tenant_id, user.id, user.role, "jwt", email=user.email)


def _check_destinations(state: AppState, tenant_id: str, ids: list[str]) -> None:
    with state.db.session(tenant_id) as s:
        for dest_id in ids:
            d = s.get(ChatDestination, dest_id)
            if d is None or d.tenant_id != tenant_id or not d.active:
                raise ScheduleError(f"unknown chat destination {dest_id!r}")


def _can_see_dataset(state: AppState, principal: Principal, dataset_id: str) -> bool:
    from ..projects import ProjectAccessDenied, check_dataset
    from ..storage.datasets import DatasetNotFound

    try:
        check_dataset(state, principal, dataset_id)
        return True
    except (DatasetNotFound, ProjectAccessDenied):
        return False


def _can_see_dashboard(state: AppState, principal: Principal, dashboard_id: str) -> bool:
    from ..dashboards.service import DashboardService

    with state.db.session(principal.tenant_id) as s:
        d = s.get(Dashboard, dashboard_id)
        return d is not None and d.tenant_id == principal.tenant_id and DashboardService.role_for(d, principal) is not None


def _check_recipients(state: AppState, tenant_id: str, ids: list[str], can_see) -> None:
    for uid in dict.fromkeys(ids):
        p = _user_principal(state, tenant_id, uid)
        if p is None:
            raise ScheduleError(f"unknown or disabled recipient {uid!r}")
        if not can_see(p):
            raise ScheduleError(f"recipient {uid!r} can't see this content")


# -- validators (registered in builtin.py) --------------------------------------------------------------------


def validate_analytic_run(state: AppState, principal: Principal, params: dict[str, Any]) -> dict[str, Any]:
    from ..analytics.saved import AnalyticsService, NotFound, bind_params
    from ..analytics.sql_sandbox import UnsafeQueryError

    body = _parse(AnalyticRunParams, params)
    try:
        analytic = AnalyticsService(state).get(principal.tenant_id, body.analytic_id)
    except NotFound as exc:
        raise ScheduleError("analytic not found") from exc
    if not _can_see_dataset(state, principal, analytic.dataset_id):
        raise ScheduleError("analytic not found")
    try:
        bind_params(analytic.sql, analytic.parameters, body.params)
    except UnsafeQueryError as exc:
        raise ScheduleError(str(exc)) from exc
    _check_recipients(state, principal.tenant_id, body.recipients, lambda p: _can_see_dataset(state, p, analytic.dataset_id))
    _check_destinations(state, principal.tenant_id, body.chat_destinations)
    return body.model_dump()


def validate_dashboard_delivery(state: AppState, principal: Principal, params: dict[str, Any]) -> dict[str, Any]:
    body = _parse(DashboardDeliveryParams, params)
    if not _can_see_dashboard(state, principal, body.dashboard_id):
        raise ScheduleError("dashboard not found")
    _check_recipients(state, principal.tenant_id, body.recipients, lambda p: _can_see_dashboard(state, p, body.dashboard_id))
    _check_destinations(state, principal.tenant_id, body.chat_destinations)
    return body.model_dump()


# -- job helpers -------------------------------------------------------------------------------------------------


def run_principal(ctx: JobContext) -> Principal:
    """The scheduled job's owner, re-validated now. Scheduled jobs always carry ``schedule_id``."""
    from ..db.models import Schedule

    schedule_id = ctx.params.get("schedule_id")
    if not schedule_id:
        raise PermanentJobError("this job type only runs from a schedule")
    with ctx.state.db.session(ctx.tenant_id) as s:
        sched = s.get(Schedule, schedule_id)
        if sched is None or sched.tenant_id != ctx.tenant_id:
            raise PermanentJobError("schedule not found")
    principal = owner_principal(ctx.state, sched)
    if principal is None:
        raise PermanentJobError("the schedule's owner can no longer run it")
    return principal


def _safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-")[:80] or "report"


def _deliver(
    ctx: JobContext,
    targets: DeliveryTargets,
    *,
    can_see,
    subject: str,
    body: str,
    chat_title: str,
    chat_body: dict[str, Any],
    attachment: tuple[str, bytes, str] | None,
) -> dict[str, Any]:
    """Queue per-recipient email jobs and chat posts. Returns counts for the job result."""
    jobs = JobService(ctx.state)
    key = None
    note = ""
    if attachment is not None:
        filename, content, content_type = attachment
        if len(content) <= MAX_ATTACHMENT_BYTES:
            key = f"deliveries/{ctx.job_id}/{filename}"
            ctx.state.objects.put_bytes(ctx.tenant_id, key, content)
        else:
            note = f"\n\nThe attachment ({len(content) / 1024**2:.1f} MB) exceeds the email limit and was not attached."
    emailed, skipped = 0, []
    for uid in dict.fromkeys(targets.recipients):
        p = _user_principal(ctx.state, ctx.tenant_id, uid)
        if p is None or not can_see(p):
            skipped.append(uid)
            continue
        params = {"user_id": uid, "subject": subject[:200], "body": body + note}
        if key is not None:
            params.update(attachment_key=key, filename=attachment[0], content_type=attachment[2])
        jobs.submit(ctx.tenant_id, "delivery.email", params, "system", max_attempts=5)
        emailed += 1
    posted = 0
    with ctx.state.db.session(ctx.tenant_id) as s:
        active = {
            d.id
            for d in s.execute(
                select(ChatDestination).where(ChatDestination.tenant_id == ctx.tenant_id, ChatDestination.active.is_(True))
            ).scalars()
        }
    for dest_id in dict.fromkeys(targets.chat_destinations):
        if dest_id not in active:
            skipped.append(dest_id)
            continue
        params = {"destination_id": dest_id, "kind": "schedule.delivery", "title": chat_title[:200], "body": chat_body}
        jobs.submit(ctx.tenant_id, "notification.chat", params, "system", max_attempts=5)
        posted += 1
    return {"emails_queued": emailed, "chat_posts_queued": posted, "skipped_targets": skipped}


# -- USR-007: scheduled analytics ------------------------------------------------------------------------------


@job_handler("analytics.scheduled_run")
def scheduled_analytic_job(ctx: JobContext) -> dict:
    from ..analytics.saved import AnalyticsService, NotFound
    from ..analytics.sql_sandbox import QueryTimeout, UnsafeQueryError
    from ..storage.datasets import DatasetNotFound

    principal = run_principal(ctx)
    p = AnalyticRunParams.model_validate({k: v for k, v in ctx.params.items() if k not in ("schedule_id", "trigger")})
    svc = AnalyticsService(ctx.state)
    try:
        analytic = svc.get(ctx.tenant_id, p.analytic_id)
        if not _can_see_dataset(ctx.state, principal, analytic.dataset_id):
            raise PermanentJobError("the schedule's owner can no longer see this analytic's dataset")
        result = svc.run(ctx.tenant_id, p.analytic_id, p.params, p.filters or None, p.row_limit)
    except (NotFound, DatasetNotFound, UnsafeQueryError, QueryTimeout) as exc:
        raise PermanentJobError(str(exc)) from exc
    ctx.progress(0.6, f"{result.row_count} rows")
    frame = pd.DataFrame(result.rows, columns=result.columns)
    csv = frame.to_csv(index=False).encode()
    now = datetime.now(UTC)
    snapshot = {
        "kind": "analytic",
        "analytic_id": analytic.id,
        "name": analytic.name,
        "job_id": ctx.job_id,
        "columns": result.columns,
        "rows": result.rows[:SNAPSHOT_ROWS],
        "row_count": result.row_count,
        "truncated": result.truncated,
    }
    record_result(ctx.state, ctx.tenant_id, ctx.params.get("schedule_id"), snapshot)
    preview = frame.head(CHAT_PREVIEW_ROWS).to_string(index=False, max_colwidth=40) if len(frame) else "(no rows)"
    summary = f"{analytic.name}: {result.row_count} row(s){' (truncated)' if result.truncated else ''} as of {now:%Y-%m-%d %H:%M} UTC."
    delivered = _deliver(
        ctx,
        p,
        can_see=lambda u: _can_see_dataset(ctx.state, u, analytic.dataset_id),
        subject=f"[Analytics Platform] Scheduled analytic: {analytic.name}",
        body=f"{summary}\n\nThe full result is attached as CSV.\n\nFirst rows:\n{preview}",
        chat_title=f"Scheduled analytic: {analytic.name}",
        chat_body={"rows": result.row_count, "columns": ", ".join(result.columns)[:500], "preview": preview[:1500]},
        attachment=(f"{_safe_name(analytic.name)}-{now:%Y%m%d-%H%M}.csv", csv, "text/csv"),
    )
    return {"analytic_id": analytic.id, "rows": result.row_count, "truncated": result.truncated, **delivered}


# -- SHR-004: scheduled dashboard snapshots --------------------------------------------------------------------


@job_handler("dashboard.deliver")
def dashboard_delivery_job(ctx: JobContext) -> dict:
    from ..dashboards.service import DashboardService, Forbidden, NotFound

    principal = run_principal(ctx)
    p = DashboardDeliveryParams.model_validate({k: v for k, v in ctx.params.items() if k not in ("schedule_id", "trigger")})
    dashboards = DashboardService(ctx.state)
    try:
        dash = dashboards.get(principal, p.dashboard_id)
        html = dashboards.export_html(principal, p.dashboard_id, p.filters)
    except (NotFound, Forbidden) as exc:
        raise PermanentJobError(f"dashboard not available: {exc}") from exc
    ctx.progress(0.6, "rendered")
    settings = ctx.state.settings
    link, link_kind = f"{settings.app_base_url}/dashboards/{dash.id}", "app"
    if p.chat_destinations and p.public_link and dash.your_role in ("owner", "editor"):
        from ..public_links import PublicLinksDisabled, PublicLinkService

        try:
            created, token = PublicLinkService(ctx.state).create(principal, dash.id, settings.delivery_link_ttl_hours)
            link, link_kind = f"{settings.api_base_url}/v1/public/{token}", "public"
            ctx.state.audit.record(
                ctx.tenant_id,
                principal.user_id,
                "dashboard.public_link.create",
                dashboard_id=dash.id,
                link_id=created["id"],
                via="schedule",
            )
        except PublicLinksDisabled:
            pass
    now = datetime.now(UTC)
    record_result(
        ctx.state,
        ctx.tenant_id,
        ctx.params.get("schedule_id"),
        {
            "kind": "dashboard",
            "dashboard_id": dash.id,
            "name": dash.name,
            "job_id": ctx.job_id,
            "size_bytes": len(html),
            "link_kind": link_kind,
        },
    )
    expiry = f" (expires in {settings.delivery_link_ttl_hours} h)" if link_kind == "public" else ""
    delivered = _deliver(
        ctx,
        p,
        can_see=lambda u: _can_see_dashboard(ctx.state, u, dash.id),
        subject=f"[Analytics Platform] Dashboard snapshot: {dash.name}",
        body=f'A snapshot of the dashboard "{dash.name}" as of {now:%Y-%m-%d %H:%M} UTC is attached (open it in a browser).\n\n'
        f"Live dashboard: {settings.app_base_url}/dashboards/{dash.id}",
        chat_title=f"Dashboard snapshot: {dash.name}",
        chat_body={"dashboard": dash.name, "link": link + expiry},
        attachment=(f"{_safe_name(dash.name)}-{now:%Y%m%d-%H%M}.html", html.encode(), "text/html"),
    )
    return {"dashboard_id": dash.id, "link_kind": link_kind, **delivered}


# -- per-recipient email delivery -------------------------------------------------------------------------------


@job_handler("delivery.email")
def delivery_email_job(ctx: JobContext) -> dict:
    """Send one scheduled-delivery email (with its attachment) to a tenant user, looked up now."""
    p = ctx.params
    with ctx.state.db.session(ctx.tenant_id) as s:
        user = s.get(User, p["user_id"])
        if user is None or user.tenant_id != ctx.tenant_id or user.disabled:
            return {"skipped": "no active recipient"}
        to = user.email
    attachments: tuple[Attachment, ...] = ()
    if p.get("attachment_key"):
        from ..cloud.base import ObjectNotFound

        try:
            content = ctx.state.objects.get_bytes(ctx.tenant_id, p["attachment_key"])
        except ObjectNotFound as exc:
            raise PermanentJobError("attachment is no longer available") from exc
        attachments = (Attachment(p["filename"], content, p.get("content_type") or "application/octet-stream"),)
    email_sender(ctx.state).send(Email(to=to, subject=p["subject"], body=p["body"], attachments=attachments))
    return {"sent": True, "attachments": len(attachments)}
