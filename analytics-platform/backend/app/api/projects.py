"""Projects and membership (AUTH-003)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..auth.rbac import Permission
from ..auth.service import Principal
from ..db.models import Project, ProjectMember, User
from ..projects import visible_projects
from .deps import AppState, StateDep, require

router = APIRouter(prefix="/v1/projects", tags=["projects"])
Admin = require(Permission.MANAGE_TENANT)
Reader = require(Permission.READ_DATA)


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    open: bool = False
    members: list[str] = Field(default_factory=list, max_length=500)


class MemberBody(BaseModel):
    user_id: str


def _out(p: Project, members: list[str]) -> dict[str, Any]:
    return {"id": p.id, "name": p.name, "open": p.open, "members": members, "created_at": p.created_at}


def _members(s, project_id: str) -> list[str]:
    return [m.user_id for m in s.execute(select(ProjectMember).where(ProjectMember.project_id == project_id)).scalars()]


@router.get("")
async def list_projects(state: AppState = StateDep, principal: Principal = Reader) -> list[dict[str, Any]]:
    allowed = visible_projects(state, principal)
    with state.db.session(principal.tenant_id) as s:
        rows = s.execute(select(Project).where(Project.tenant_id == principal.tenant_id).order_by(Project.name)).scalars().all()
        return [_out(p, _members(s, p.id)) for p in rows if allowed is None or p.id in allowed]


@router.post("", status_code=201)
async def create_project(body: ProjectCreate, state: AppState = StateDep, principal: Principal = Admin) -> dict[str, Any]:
    try:
        with state.db.session(principal.tenant_id) as s:
            project = Project(tenant_id=principal.tenant_id, name=body.name, open=body.open)
            s.add(project)
            s.flush()
            for user_id in body.members:
                user = s.get(User, user_id)
                if user is None or user.tenant_id != principal.tenant_id:
                    raise HTTPException(status_code=422, detail=f"unknown user {user_id}")
                s.add(ProjectMember(tenant_id=principal.tenant_id, project_id=project.id, user_id=user_id))
            out = _out(project, list(body.members))
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="a project with that name already exists") from exc
    state.audit.record(principal.tenant_id, principal.user_id, "project.create", project_id=out["id"], open=body.open)
    return out


@router.post("/{project_id}/members", status_code=204)
async def add_member(project_id: str, body: MemberBody, state: AppState = StateDep, principal: Principal = Admin) -> None:
    with state.db.session(principal.tenant_id) as s:
        project, user = s.get(Project, project_id), s.get(User, body.user_id)
        if project is None or project.tenant_id != principal.tenant_id or user is None or user.tenant_id != principal.tenant_id:
            raise HTTPException(status_code=404, detail="project or user not found")
        if s.get(ProjectMember, (project_id, body.user_id)) is None:
            s.add(ProjectMember(tenant_id=principal.tenant_id, project_id=project_id, user_id=body.user_id))
    state.audit.record(principal.tenant_id, principal.user_id, "project.member.add", project_id=project_id, user_id=body.user_id)


@router.delete("/{project_id}/members/{user_id}", status_code=204)
async def remove_member(project_id: str, user_id: str, state: AppState = StateDep, principal: Principal = Admin) -> None:
    with state.db.session(principal.tenant_id) as s:
        member = s.get(ProjectMember, (project_id, user_id))
        if member is None or member.tenant_id != principal.tenant_id:
            raise HTTPException(status_code=404, detail="membership not found")
        s.delete(member)
    state.audit.record(principal.tenant_id, principal.user_id, "project.member.remove", project_id=project_id, user_id=user_id)
