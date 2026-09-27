"""Notification preferences (NTF-002) and Slack / Teams destinations (NTF-003)."""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..auth.rbac import Permission
from ..auth.service import Principal
from ..db.models import ChatDestination, NotificationPreference, User
from ..notify.channels import CHAT_KINDS, EmailPreferences, check_chat_url
from ..webhooks import WebhookError
from .deps import AppState, PrincipalDep, StateDep, require

router = APIRouter(prefix="/v1", tags=["notifications"])
Admin = require(Permission.MANAGE_TENANT)


def _user(state: AppState, principal: Principal) -> None:
    if principal.method not in ("jwt", "dev"):
        raise HTTPException(status_code=400, detail="notification preferences belong to users, not API clients")
    with state.db.session(principal.tenant_id) as s:
        user = s.get(User, principal.user_id)
        if user is None or user.tenant_id != principal.tenant_id:
            raise HTTPException(status_code=404, detail="user not found")


@router.get("/notifications/preferences", response_model=EmailPreferences)
async def get_preferences(state: AppState = StateDep, principal: Principal = PrincipalDep) -> EmailPreferences:
    _user(state, principal)
    with state.db.session(principal.tenant_id) as s:
        pref = s.get(NotificationPreference, principal.user_id)
        return EmailPreferences(email=list(pref.email_kinds) if pref else [])


@router.put("/notifications/preferences", response_model=EmailPreferences)
async def put_preferences(body: EmailPreferences, state: AppState = StateDep, principal: Principal = PrincipalDep) -> EmailPreferences:
    """NTF-002: choose which notification kinds are emailed to you (``["*"]`` = all, ``[]`` = none)."""
    _user(state, principal)
    with state.db.session(principal.tenant_id) as s:
        pref = s.get(NotificationPreference, principal.user_id)
        if pref is None:
            s.add(NotificationPreference(user_id=principal.user_id, tenant_id=principal.tenant_id, email_kinds=body.email))
        else:
            pref.email_kinds = body.email
    state.audit.record(principal.tenant_id, principal.user_id, "notification.preferences.update", email=body.email)
    return body


# -- NTF-003 chat destinations ------------------------------------------------------------------------------


class ChatDestinationCreate(BaseModel):
    kind: Literal["slack", "teams"]
    name: str = Field(min_length=1, max_length=200)
    url: str = Field(max_length=2000, description="The incoming-webhook URL (stored in the secret manager, never returned)")
    events: list[str] = Field(min_length=1, max_length=20)


def _dest_out(d: ChatDestination) -> dict[str, Any]:
    return {
        "id": d.id,
        "kind": d.kind,
        "name": d.name,
        "host": d.host,
        "events": list(d.events),
        "active": d.active,
        "created_at": d.created_at,
    }


@router.post("/tenant/chat-destinations", status_code=201)
async def create_chat_destination(body: ChatDestinationCreate, state: AppState = StateDep, principal: Principal = Admin) -> dict[str, Any]:
    unknown = set(body.events) - CHAT_KINDS
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown events: {sorted(unknown)}")
    dispatcher = state.extras.get("webhooks")
    try:
        await asyncio.to_thread(check_chat_url, body.kind, body.url, allow_private=bool(dispatcher and dispatcher.allow_private))
    except WebhookError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    from urllib.parse import urlparse

    with state.db.session(principal.tenant_id) as s:
        dest = ChatDestination(
            tenant_id=principal.tenant_id,
            kind=body.kind,
            name=body.name,
            host=urlparse(body.url).hostname or "",
            secret_name="",
            events=sorted(set(body.events)),
            created_by=principal.user_id,
        )
        s.add(dest)
        s.flush()
        dest.secret_name = f"chat-{dest.id}"
        s.flush()
        out = _dest_out(dest)
        secret_name = dest.secret_name
    state.secrets.put(principal.tenant_id, secret_name, body.url)
    state.audit.record(principal.tenant_id, principal.user_id, "chat_destination.create", destination_id=out["id"], kind=body.kind)
    return out


@router.get("/tenant/chat-destinations")
async def list_chat_destinations(state: AppState = StateDep, principal: Principal = Admin) -> list[dict[str, Any]]:
    with state.db.session(principal.tenant_id) as s:
        rows = s.execute(select(ChatDestination).where(ChatDestination.tenant_id == principal.tenant_id, ChatDestination.active.is_(True)))
        return [_dest_out(d) for d in rows.scalars()]


@router.delete("/tenant/chat-destinations/{destination_id}", status_code=204)
async def delete_chat_destination(destination_id: str, state: AppState = StateDep, principal: Principal = Admin) -> None:
    with state.db.session(principal.tenant_id) as s:
        dest = s.get(ChatDestination, destination_id)
        if dest is None or dest.tenant_id != principal.tenant_id or not dest.active:
            raise HTTPException(status_code=404, detail="destination not found")
        dest.active = False
        secret_name = dest.secret_name
    state.secrets.delete(principal.tenant_id, secret_name)
    state.audit.record(principal.tenant_id, principal.user_id, "chat_destination.delete", destination_id=destination_id)
