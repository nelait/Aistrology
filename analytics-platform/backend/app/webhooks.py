"""Outgoing webhooks (WHK-001, WHK-003, NTF-004): HMAC-signed, retried through the job system, SSRF-guarded."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import secrets
import socket
import time
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

import httpx
from sqlalchemy import select

from .db.models import Webhook, WebhookDelivery

if TYPE_CHECKING:  # pragma: no cover
    from .api.deps import AppState

EVENTS = {
    "job.succeeded",
    "job.failed",
    "model.registered",
    "endpoint.deployed",
    "dataset.version_created",
    "endpoint.threshold",
    "*",
}
TIMEOUT = 10.0


class WebhookError(ValueError):
    pass


def sign(secret: str, body: bytes, timestamp: int | None = None) -> str:
    ts = timestamp or int(time.time())
    mac = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    return f"t={ts},v1={mac}"


def verify_signature(secret: str, body: bytes, header: str, tolerance_seconds: int = 300) -> bool:
    """Reference verification for receivers (also used in tests)."""
    try:
        parts = dict(p.split("=", 1) for p in header.split(","))
        ts = int(parts["t"])
    except (ValueError, KeyError):
        return False
    if abs(time.time() - ts) > tolerance_seconds:
        return False
    return hmac.compare_digest(sign(secret, body, ts), header)


def check_url(url: str, *, allow_private: bool = False) -> None:
    """Reject non-HTTPS URLs and hosts resolving to private, loopback or link-local addresses (SSRF)."""
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise WebhookError("webhook URLs must be https://")
    if allow_private:
        return
    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise WebhookError(f"cannot resolve {parsed.hostname}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise WebhookError("webhook URL resolves to a private or reserved address")


class WebhookDispatcher:
    def __init__(self, state: AppState, *, allow_private: bool = False, transport: httpx.BaseTransport | None = None):
        self.state = state
        self.allow_private = allow_private
        self.transport = transport

    def create(self, tenant_id: str, actor: str, url: str, events: list[str]) -> tuple[Webhook, str]:
        unknown = set(events) - EVENTS
        if unknown:
            raise WebhookError(f"unknown events: {sorted(unknown)}")
        check_url(url, allow_private=self.allow_private)
        secret = "whsec_" + secrets.token_urlsafe(32)
        with self.state.db.session(tenant_id) as s:
            hook = Webhook(tenant_id=tenant_id, url=url, events=events, secret_name="")
            s.add(hook)
            s.flush()
            hook.secret_name = f"webhook-{hook.id}"
            s.flush()  # persist secret_name before detaching the object
            s.expunge(hook)
        self.state.secrets.put(tenant_id, hook.secret_name, secret)
        self.state.audit.record(tenant_id, actor, "webhook.create", webhook_id=hook.id, url=url, events=events)
        return hook, secret

    def emit(self, tenant_id: str, event: str, payload: dict[str, Any]) -> list[str]:
        """Queue a delivery to every active webhook subscribed to ``event``."""
        from .jobs.core import JobService

        with self.state.db.session(tenant_id) as s:
            hooks = s.execute(select(Webhook).where(Webhook.tenant_id == tenant_id, Webhook.active.is_(True))).scalars().all()
            targets = [h.id for h in hooks if event in h.events or "*" in h.events]
            deliveries = []
            for hook_id in targets:
                d = WebhookDelivery(
                    tenant_id=tenant_id, webhook_id=hook_id, event=event, payload=json.loads(json.dumps(payload, default=str))
                )
                s.add(d)
                s.flush()
                deliveries.append(d.id)
        for delivery_id in deliveries:
            JobService(self.state).submit(tenant_id, "webhook.deliver", {"delivery_id": delivery_id}, "system", max_attempts=5)
        return deliveries


def deliver(state: AppState, tenant_id: str, delivery_id: str) -> dict[str, Any]:
    """Send one delivery. Raises on failure so the job system retries it (up to 5 attempts)."""
    from .jobs.core import PermanentJobError

    dispatcher: WebhookDispatcher | None = state.extras.get("webhooks")
    with state.db.session(tenant_id) as s:
        d = s.get(WebhookDelivery, delivery_id)
        if d is None:
            raise PermanentJobError("delivery not found")
        hook = s.get(Webhook, d.webhook_id)
        if hook is None or not hook.active:
            d.status = "failed"
            return {"skipped": True}
        url, secret_name = hook.url, hook.secret_name
        body = json.dumps(
            {"id": d.id, "event": d.event, "created_at": d.created_at.isoformat(), "tenant_id": tenant_id, "data": d.payload}
        ).encode()
        d.attempts += 1
    secret = state.secrets.get(tenant_id, secret_name) or ""
    try:
        check_url(url, allow_private=bool(dispatcher and dispatcher.allow_private))
    except WebhookError as exc:
        with state.db.session(tenant_id) as s:
            s.get(WebhookDelivery, delivery_id).status = "failed"
        raise PermanentJobError(str(exc)) from exc
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "AnalyticsPlatform-Webhooks/1",
        "X-AP-Signature": sign(secret, body),
        "X-AP-Delivery": delivery_id,
    }
    with httpx.Client(timeout=TIMEOUT, follow_redirects=False, transport=dispatcher.transport if dispatcher else None) as client:
        try:
            response = client.post(url, content=body, headers=headers)
            code = response.status_code
        except httpx.HTTPError as exc:
            code = None
            error = str(exc)
    ok = code is not None and 200 <= code < 300
    with state.db.session(tenant_id) as s:
        d = s.get(WebhookDelivery, delivery_id)
        d.response_code = code
        d.status = "delivered" if ok else "pending"
        if ok:
            d.delivered_at = datetime.now(UTC)
    if not ok:
        raise RuntimeError(f"webhook delivery failed: {code if code is not None else error}")
    return {"delivered": True, "status_code": code}
