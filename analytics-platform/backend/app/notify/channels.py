"""Notification channels beyond in-app (NTF-002 email, NTF-003 Slack / Teams).

``jobs.core.notify`` calls :func:`fan_out` after storing the in-app notification. Fan-out only *queues*
jobs (``notification.email`` / ``notification.chat``); the network calls happen in workers with retries,
so neither SMTP nor chat latency ever blocks a request. Notification jobs never notify about themselves.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from ..db.models import ChatDestination, NotificationPreference, User
from ..jobs.core import JobContext, JobService, PermanentJobError, job_handler
from ..webhooks import TIMEOUT, WebhookError, check_url
from .email import Email, email_sender

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState

log = logging.getLogger("app.notify")

# Kinds a user can subscribe to by email ("*" = everything).
EMAIL_KINDS = {
    "job.succeeded",
    "job.failed",
    "model.registered",
    "endpoint.deployed",
    "dataset.version_created",
    "endpoint.threshold",
    "comment.mention",
    "*",
}
CHAT_KINDS = EMAIL_KINDS
CHAT_KIND_VALUES = ("slack", "teams")
# Accepted incoming-webhook hosts per chat kind, so a destination can't be pointed at an arbitrary server.
CHAT_HOSTS = {"slack": ("hooks.slack.com",), "teams": (".webhook.office.com", ".logic.azure.com")}


class EmailPreferences(BaseModel):
    email: list[str] = Field(default_factory=list, max_length=50, description="Notification kinds delivered by email")

    @field_validator("email")
    @classmethod
    def _known(cls, v: list[str]) -> list[str]:
        unknown = set(v) - EMAIL_KINDS
        if unknown:
            raise ValueError(f"unknown notification kinds: {sorted(unknown)}")
        return sorted(set(v))


def _wants(kinds: list[str], kind: str) -> bool:
    return "*" in kinds or kind in kinds


def fan_out(state: AppState, tenant_id: str, user_id: str | None, kind: str, title: str, body: dict[str, Any]) -> None:
    """Queue email and chat deliveries for one notification. Never raises (notifications are best-effort)."""
    try:
        payload = json.loads(json.dumps(body, default=str))
        with state.db.session(tenant_id) as s:
            q = select(NotificationPreference).where(NotificationPreference.tenant_id == tenant_id)
            if user_id is not None:
                q = q.where(NotificationPreference.user_id == user_id)
            recipients = [p.user_id for p in s.execute(q).scalars() if _wants(list(p.email_kinds or []), kind)]
            destinations = [
                d.id
                for d in s.execute(
                    select(ChatDestination).where(ChatDestination.tenant_id == tenant_id, ChatDestination.active.is_(True))
                ).scalars()
                if _wants(list(d.events or []), kind)
            ]
        jobs = JobService(state)
        for uid in recipients:
            params = {"user_id": uid, "kind": kind, "title": title, "body": payload}
            jobs.submit(tenant_id, "notification.email", params, "system", max_attempts=5)
        for dest_id in destinations:
            params = {"destination_id": dest_id, "kind": kind, "title": title, "body": payload}
            jobs.submit(tenant_id, "notification.chat", params, "system", max_attempts=5)
    except Exception:  # noqa: BLE001 - a notification channel must never break the caller
        log.exception("notification fan-out failed for tenant %s kind %s", tenant_id, kind)


def _summary(kind: str, title: str, body: dict[str, Any]) -> str:
    details = "\n".join(f"{k}: {v}" for k, v in list(body.items())[:20] if k != "title")
    return f"{title}\n\nEvent: {kind}\n{details}".strip()


@job_handler("notification.email")
def email_job(ctx: JobContext) -> dict:
    """NTF-002: deliver one email. The address is looked up now, so address changes and disabling are honoured."""
    p = ctx.params
    with ctx.state.db.session(ctx.tenant_id) as s:
        user = s.get(User, p["user_id"])
        if user is None or user.tenant_id != ctx.tenant_id or user.disabled:
            return {"skipped": "no active recipient"}
        pref = s.get(NotificationPreference, user.id)
        if pref is None or not _wants(list(pref.email_kinds or []), p["kind"]):
            return {"skipped": "unsubscribed"}
        to = user.email
    email_sender(ctx.state).send(
        Email(to=to, subject=f"[Analytics Platform] {p['title']}"[:200], body=_summary(p["kind"], p["title"], p["body"]))
    )
    return {"sent": True, "kind": p["kind"]}


def check_chat_url(kind: str, url: str, *, allow_private: bool = False) -> None:
    """HTTPS, a known chat host for the kind, and the webhook SSRF guard."""
    host = (urlparse(url).hostname or "").lower()
    allowed = CHAT_HOSTS[kind]
    if not allow_private and not any(host == h or (h.startswith(".") and host.endswith(h)) for h in allowed):
        raise WebhookError(f"{kind} destinations must be incoming-webhook URLs on {', '.join(allowed)}")
    check_url(url, allow_private=allow_private)


def chat_payload(kind: str, event: str, title: str, body: dict[str, Any]) -> dict[str, Any]:
    text = _summary(event, title, body)
    if kind == "slack":
        return {"text": f"*{title}*", "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": text[:2900]}}]}
    return {  # Microsoft Teams MessageCard
        "@type": "MessageCard",
        "@context": "https://schema.org/extensions",
        "summary": title[:200],
        "title": title[:200],
        "text": text[:10000].replace("\n", "  \n"),
    }


@job_handler("notification.chat")
def chat_job(ctx: JobContext) -> dict:
    """NTF-003: post to a Slack / Teams incoming webhook. Raises on failure so the job retries."""
    p = ctx.params
    dispatcher = ctx.state.extras.get("webhooks")
    allow_private = bool(dispatcher and dispatcher.allow_private)
    with ctx.state.db.session(ctx.tenant_id) as s:
        dest = s.get(ChatDestination, p["destination_id"])
        if dest is None or dest.tenant_id != ctx.tenant_id or not dest.active:
            return {"skipped": "destination removed"}
        kind, secret_name = dest.kind, dest.secret_name
    url = ctx.state.secrets.get(ctx.tenant_id, secret_name)
    if not url:
        raise PermanentJobError("destination URL is missing")
    try:
        check_chat_url(kind, url, allow_private=allow_private)  # re-check: DNS may have changed since creation
    except WebhookError as exc:
        raise PermanentJobError(str(exc)) from exc
    transport = dispatcher.transport if dispatcher else None
    with httpx.Client(timeout=TIMEOUT, follow_redirects=False, transport=transport) as client:
        response = client.post(url, json=chat_payload(kind, p["kind"], p["title"], p["body"]))
    if not 200 <= response.status_code < 300:
        raise RuntimeError(f"{kind} delivery failed with HTTP {response.status_code}")
    return {"delivered": True, "status_code": response.status_code}
