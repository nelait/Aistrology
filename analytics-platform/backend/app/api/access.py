"""Access management: OAuth client credentials (MGT-004a), IP allow/deny lists (MGT-007) and teams (AUTH-004)."""

from __future__ import annotations

import base64
import binascii
from datetime import UTC, datetime
from typing import Any
from urllib.parse import unquote_plus

from fastapi import APIRouter, Form, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from ..auth.network import NetworkPolicy, get_policy, set_policy
from ..auth.oauth import OAuthError, OAuthService
from ..auth.rbac import Permission, Role
from ..auth.service import Principal
from ..db.models import OAuthClient, Project, ProjectTeam, Team, TeamMember, User
from .deps import AppState, StateDep, require

router = APIRouter(tags=["access"])
Admin = require(Permission.MANAGE_TENANT)
Deployer = require(Permission.DEPLOY)
Reader = require(Permission.READ_DATA)


# -- MGT-004a OAuth 2.0 client credentials ------------------------------------------------------------


class OAuthClientCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    role: Role = Role.DATA_SCIENTIST
    scopes: list[Permission] = Field(default_factory=list, description="Optional narrowing of the role's permissions")


def _client_out(c: OAuthClient) -> dict[str, Any]:
    return {
        "id": c.id,
        "client_id": c.client_id,
        "name": c.name,
        "role": c.role,
        "scopes": list(c.scopes),
        "created_by": c.created_by,
        "created_at": c.created_at,
        "revoked_at": c.revoked_at,
        "last_used_at": c.last_used_at,
    }


@router.post("/v1/tenant/oauth-clients", status_code=201)
async def create_oauth_client(body: OAuthClientCreate, state: AppState = StateDep, principal: Principal = Deployer) -> dict[str, Any]:
    """The ``client_secret`` is shown once; only its hash is stored."""
    if body.role == Role.ADMIN and principal.role != Role.ADMIN.value:
        raise HTTPException(status_code=403, detail="only admins can create admin clients")
    client, secret = OAuthService(state).create_client(
        principal.tenant_id, name=body.name, role=body.role, scopes=[p.value for p in body.scopes], created_by=principal.user_id
    )
    state.audit.record(principal.tenant_id, principal.user_id, "oauth_client.create", client_id=client.client_id, role=body.role.value)
    return {**_client_out(client), "client_secret": secret, "token_url": "/oauth/token"}


@router.get("/v1/tenant/oauth-clients")
async def list_oauth_clients(state: AppState = StateDep, principal: Principal = Deployer) -> list[dict[str, Any]]:
    with state.db.session(principal.tenant_id) as s:
        rows = s.execute(select(OAuthClient).where(OAuthClient.tenant_id == principal.tenant_id).order_by(OAuthClient.created_at))
        return [_client_out(c) for c in rows.scalars()]


@router.delete("/v1/tenant/oauth-clients/{client_row_id}", status_code=204)
async def revoke_oauth_client(client_row_id: str, state: AppState = StateDep, principal: Principal = Deployer) -> None:
    with state.db.session(principal.tenant_id) as s:
        client = s.get(OAuthClient, client_row_id)
        if client is None or client.tenant_id != principal.tenant_id:
            raise HTTPException(status_code=404, detail="OAuth client not found")
        client.revoked_at = client.revoked_at or datetime.now(UTC)
        client_id = client.client_id
    state.audit.record(principal.tenant_id, principal.user_id, "oauth_client.revoke", client_id=client_id)


def _oauth_error(error: str, description: str, status: int = 400) -> JSONResponse:
    headers = {"Cache-Control": "no-store", "Pragma": "no-cache"}
    if status == 401:
        headers["WWW-Authenticate"] = 'Basic realm="oauth"'
    return JSONResponse({"error": error, "error_description": description}, status_code=status, headers=headers)


@router.post("/oauth/token", tags=["auth"])
async def oauth_token(
    request: Request,
    grant_type: str | None = Form(None, max_length=100),
    client_id: str | None = Form(None, max_length=200),
    client_secret: str | None = Form(None, max_length=500),
    scope: str | None = Form(None, max_length=2000),
    authorization: str | None = Header(None),
    state: AppState = StateDep,
) -> JSONResponse:
    """RFC 6749 §4.4 token endpoint (form-encoded). Credentials via HTTP Basic or ``client_id``/``client_secret`` fields."""
    if not grant_type:
        return _oauth_error("invalid_request", "grant_type is required")
    if grant_type != "client_credentials":
        return _oauth_error("unsupported_grant_type", "only client_credentials is supported")
    if authorization and authorization.lower().startswith("basic "):
        try:
            raw = base64.b64decode(authorization[6:].strip(), validate=True).decode()
            basic_id, basic_secret = raw.split(":", 1)
        except (binascii.Error, UnicodeDecodeError, ValueError):
            return _oauth_error("invalid_client", "malformed Basic credentials", 401)
        if client_id and client_id != unquote_plus(basic_id):
            return _oauth_error("invalid_request", "conflicting client credentials")
        client_id, client_secret = unquote_plus(basic_id), unquote_plus(basic_secret)
    if not client_id or not client_secret:
        return _oauth_error("invalid_client", "client authentication required", 401)
    limiter_key = f"oauth-token:{request.client.host if request.client else '-'}"
    if not state.rate_limiter.allow(limiter_key, 120):
        return _oauth_error("slow_down", "too many token requests", 429)
    try:
        body = OAuthService(state).issue_token(client_id, client_secret, scope)
    except OAuthError as exc:
        state.audit.record("platform", client_id[:64], "auth.oauth_failed", error=exc.error)
        return _oauth_error(exc.error, str(exc), exc.status)
    return JSONResponse(body, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


# -- MGT-007 network policy ------------------------------------------------------------------------------


@router.get("/v1/tenant/network-policy", response_model=NetworkPolicy)
async def get_network_policy(state: AppState = StateDep, principal: Principal = Admin) -> NetworkPolicy:
    return get_policy(state, principal.tenant_id)


@router.put("/v1/tenant/network-policy", response_model=NetworkPolicy)
async def put_network_policy(
    body: NetworkPolicy, request: Request, state: AppState = StateDep, principal: Principal = Admin
) -> NetworkPolicy:
    """Replace the tenant's IP allowlist / denylist (CIDR). Refuses a policy that would lock out the caller."""
    caller_ip = request.client.host if request.client else None
    if not body.allows(caller_ip):
        raise HTTPException(status_code=409, detail="this policy would block your current IP address; include it in the allowlist first")
    set_policy(state, principal.tenant_id, body)
    state.audit.record(principal.tenant_id, principal.user_id, "tenant.network_policy.update", allow=body.allow, deny=body.deny)
    return body


# -- AUTH-004 teams -----------------------------------------------------------------------------------------


class TeamCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    members: list[str] = Field(default_factory=list, max_length=1000)


class MemberBody(BaseModel):
    user_id: str = Field(max_length=64)


class TeamGrant(BaseModel):
    team_id: str = Field(max_length=40)


def _team_out(s, t: Team) -> dict[str, Any]:
    members = [m.user_id for m in s.execute(select(TeamMember).where(TeamMember.team_id == t.id)).scalars()]
    projects = [p.project_id for p in s.execute(select(ProjectTeam).where(ProjectTeam.team_id == t.id)).scalars()]
    return {
        "id": t.id,
        "name": t.name,
        "description": t.description,
        "members": sorted(members),
        "projects": projects,
        "created_at": t.created_at,
    }


def _team(s, tenant_id: str, team_id: str) -> Team:
    team = s.get(Team, team_id)
    if team is None or team.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="team not found")
    return team


def _check_user(s, tenant_id: str, user_id: str) -> None:
    user = s.get(User, user_id)
    if user is None or user.tenant_id != tenant_id:
        raise HTTPException(status_code=422, detail=f"unknown user {user_id}")


@router.post("/v1/teams", status_code=201)
async def create_team(body: TeamCreate, state: AppState = StateDep, principal: Principal = Admin) -> dict[str, Any]:
    try:
        with state.db.session(principal.tenant_id) as s:
            team = Team(tenant_id=principal.tenant_id, name=body.name, description=body.description)
            s.add(team)
            s.flush()
            for user_id in sorted(set(body.members)):
                _check_user(s, principal.tenant_id, user_id)
                s.add(TeamMember(tenant_id=principal.tenant_id, team_id=team.id, user_id=user_id))
            s.flush()
            out = _team_out(s, team)
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="a team with that name already exists") from exc
    state.audit.record(principal.tenant_id, principal.user_id, "team.create", team_id=out["id"], members=out["members"])
    return out


@router.get("/v1/teams")
async def list_teams(state: AppState = StateDep, principal: Principal = Reader) -> list[dict[str, Any]]:
    with state.db.session(principal.tenant_id) as s:
        teams = s.execute(select(Team).where(Team.tenant_id == principal.tenant_id).order_by(Team.name)).scalars().all()
        return [_team_out(s, t) for t in teams]


@router.get("/v1/teams/{team_id}")
async def get_team(team_id: str, state: AppState = StateDep, principal: Principal = Reader) -> dict[str, Any]:
    with state.db.session(principal.tenant_id) as s:
        return _team_out(s, _team(s, principal.tenant_id, team_id))


@router.delete("/v1/teams/{team_id}", status_code=204)
async def delete_team(team_id: str, state: AppState = StateDep, principal: Principal = Admin) -> None:
    with state.db.session(principal.tenant_id) as s:
        team = _team(s, principal.tenant_id, team_id)
        s.execute(delete(TeamMember).where(TeamMember.team_id == team_id, TeamMember.tenant_id == principal.tenant_id))
        s.execute(delete(ProjectTeam).where(ProjectTeam.team_id == team_id, ProjectTeam.tenant_id == principal.tenant_id))
        s.delete(team)
    state.audit.record(principal.tenant_id, principal.user_id, "team.delete", team_id=team_id)


@router.post("/v1/teams/{team_id}/members", status_code=204)
async def add_team_member(team_id: str, body: MemberBody, state: AppState = StateDep, principal: Principal = Admin) -> None:
    with state.db.session(principal.tenant_id) as s:
        _team(s, principal.tenant_id, team_id)
        _check_user(s, principal.tenant_id, body.user_id)
        if s.get(TeamMember, (team_id, body.user_id)) is None:
            s.add(TeamMember(tenant_id=principal.tenant_id, team_id=team_id, user_id=body.user_id))
    state.audit.record(principal.tenant_id, principal.user_id, "team.member.add", team_id=team_id, user_id=body.user_id)


@router.delete("/v1/teams/{team_id}/members/{user_id}", status_code=204)
async def remove_team_member(team_id: str, user_id: str, state: AppState = StateDep, principal: Principal = Admin) -> None:
    with state.db.session(principal.tenant_id) as s:
        member = s.get(TeamMember, (team_id, user_id))
        if member is None or member.tenant_id != principal.tenant_id:
            raise HTTPException(status_code=404, detail="membership not found")
        s.delete(member)
    state.audit.record(principal.tenant_id, principal.user_id, "team.member.remove", team_id=team_id, user_id=user_id)


@router.post("/v1/projects/{project_id}/teams", status_code=204)
async def grant_project_to_team(project_id: str, body: TeamGrant, state: AppState = StateDep, principal: Principal = Admin) -> None:
    """AUTH-004: every member of the team can see the project."""
    with state.db.session(principal.tenant_id) as s:
        project = s.get(Project, project_id)
        if project is None or project.tenant_id != principal.tenant_id:
            raise HTTPException(status_code=404, detail="project not found")
        _team(s, principal.tenant_id, body.team_id)
        if s.get(ProjectTeam, (project_id, body.team_id)) is None:
            s.add(ProjectTeam(tenant_id=principal.tenant_id, project_id=project_id, team_id=body.team_id))
    state.audit.record(principal.tenant_id, principal.user_id, "project.team.add", project_id=project_id, team_id=body.team_id)


@router.delete("/v1/projects/{project_id}/teams/{team_id}", status_code=204)
async def revoke_project_from_team(project_id: str, team_id: str, state: AppState = StateDep, principal: Principal = Admin) -> None:
    with state.db.session(principal.tenant_id) as s:
        grant = s.get(ProjectTeam, (project_id, team_id))
        if grant is None or grant.tenant_id != principal.tenant_id:
            raise HTTPException(status_code=404, detail="team grant not found")
        s.delete(grant)
    state.audit.record(principal.tenant_id, principal.user_id, "project.team.remove", project_id=project_id, team_id=team_id)
