"""Dashboard and widget comments (SHR-005)."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..auth.rbac import Permission
from ..auth.service import Principal
from ..comments import MAX_BODY, CommentError, CommentService
from ..dashboards.service import Forbidden, NotFound
from .deps import AppState, StateDep, require

router = APIRouter(prefix="/v1/dashboards", tags=["dashboards"])
Viewer = require(Permission.VIEW)


class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=MAX_BODY)
    widget_id: str | None = Field(default=None, max_length=40)
    parent_id: str | None = Field(default=None, max_length=40)


class CommentUpdate(BaseModel):
    body: str | None = Field(default=None, min_length=1, max_length=MAX_BODY)
    resolved: bool | None = None


async def _call(fn, *args):
    try:
        return await asyncio.to_thread(fn, *args)
    except NotFound as exc:
        raise HTTPException(status_code=404, detail="not found") from exc
    except Forbidden as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except CommentError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/{dashboard_id}/comments")
async def list_comments(
    dashboard_id: str,
    widget_id: str | None = None,
    include_resolved: bool = True,
    state: AppState = StateDep,
    principal: Principal = Viewer,
) -> list[dict[str, Any]]:
    """Threads (root comments with ``replies``), oldest first."""
    return await _call(CommentService(state).list, principal, dashboard_id, widget_id, include_resolved)


@router.post("/{dashboard_id}/comments", status_code=201)
async def create_comment(
    dashboard_id: str, body: CommentCreate, state: AppState = StateDep, principal: Principal = Viewer
) -> dict[str, Any]:
    return await _call(CommentService(state).create, principal, dashboard_id, body.body, body.widget_id, body.parent_id)


@router.patch("/{dashboard_id}/comments/{comment_id}")
async def update_comment(
    dashboard_id: str, comment_id: str, body: CommentUpdate, state: AppState = StateDep, principal: Principal = Viewer
) -> dict[str, Any]:
    return await _call(CommentService(state).update, principal, dashboard_id, comment_id, body.body, body.resolved)


@router.delete("/{dashboard_id}/comments/{comment_id}", status_code=204)
async def delete_comment(dashboard_id: str, comment_id: str, state: AppState = StateDep, principal: Principal = Viewer) -> None:
    await _call(CommentService(state).delete, principal, dashboard_id, comment_id)
