"""External data connectors (ING-007): S3/GCS buckets and PostgreSQL/MySQL databases, imported as jobs."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from ..auth.rbac import Permission
from ..auth.service import Principal
from ..connectors.service import ConnectorCreate, ConnectorError, ConnectorOut, ConnectorService, ImportRequest
from ..jobs.core import JobOut, JobService
from .datasets import _target_project
from .deps import AppState, StateDep, require

router = APIRouter(prefix="/v1/connectors", tags=["connectors"])
Reader = require(Permission.READ_DATA)
Writer = require(Permission.WRITE_DATA)
Admin = require(Permission.MANAGE_TENANT)


class AllowlistBody(BaseModel):
    # Hostnames, "*.suffix" wildcards or CIDRs of private hosts connectors may reach.
    hosts: list[str] = Field(default_factory=list, max_length=100)

    @field_validator("hosts")
    @classmethod
    def _hosts(cls, v: list[str]) -> list[str]:
        import ipaddress
        import re

        out = []
        for h in v:
            h = h.strip().lower()
            if "/" in h or ":" in h or h.replace(".", "").isdigit():
                net = ipaddress.ip_network(h, strict=False)  # raises ValueError on garbage
                if net.num_addresses > 2**24 and net.version == 4 or net.prefixlen < 8:
                    raise ValueError(f"{h} is too broad")
            elif not re.match(r"^(\*\.)?[a-z0-9.-]{1,253}$", h):
                raise ValueError(f"invalid host {h!r}")
            out.append(h)
        return out


def _service(state: AppState) -> ConnectorService:
    return ConnectorService(state)


@router.get("/allowlist", response_model=AllowlistBody)
async def get_allowlist(state: AppState = StateDep, principal: Principal = Admin) -> AllowlistBody:
    return AllowlistBody(hosts=_service(state).tenant_allowlist(principal.tenant_id))


@router.put("/allowlist", response_model=AllowlistBody)
async def put_allowlist(body: AllowlistBody, state: AppState = StateDep, principal: Principal = Admin) -> AllowlistBody:
    """Tenant admins may let connectors reach private (RFC 1918) hosts. Loopback and link-local stay blocked."""
    hosts = _service(state).set_tenant_allowlist(principal.tenant_id, body.hosts)
    state.audit.record(principal.tenant_id, principal.user_id, "connector.allowlist", hosts=hosts)
    return AllowlistBody(hosts=hosts)


@router.get("", response_model=list[ConnectorOut])
async def list_connectors(state: AppState = StateDep, principal: Principal = Reader) -> list[ConnectorOut]:
    return _service(state).list(principal.tenant_id)


@router.post("", response_model=ConnectorOut, status_code=201)
async def create_connector(body: ConnectorCreate, state: AppState = StateDep, principal: Principal = Writer) -> ConnectorOut:
    """Credentials go to the secret store and are never returned."""
    try:
        out = _service(state).create(principal.tenant_id, principal.user_id, body)
    except ConnectorError as exc:
        status = 409 if "already exists" in str(exc) else 422
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    state.audit.record(principal.tenant_id, principal.user_id, "connector.create", connector_id=out.id, kind=out.kind)
    return out


@router.get("/{connector_id}", response_model=ConnectorOut)
async def get_connector(connector_id: str, state: AppState = StateDep, principal: Principal = Reader) -> ConnectorOut:
    try:
        return _service(state).get(principal.tenant_id, connector_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail="connector not found") from exc


@router.delete("/{connector_id}", status_code=204)
async def delete_connector(connector_id: str, state: AppState = StateDep, principal: Principal = Writer) -> None:
    try:
        _service(state).delete(principal.tenant_id, connector_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail="connector not found") from exc
    state.audit.record(principal.tenant_id, principal.user_id, "connector.delete", connector_id=connector_id)


@router.post("/{connector_id}/import", response_model=JobOut, status_code=202)
async def import_data(connector_id: str, body: ImportRequest, state: AppState = StateDep, principal: Principal = Writer) -> JSONResponse:
    """Start an import job; its result is ``{dataset_id, version, tables, warnings}``."""
    service = _service(state)
    try:
        connector = service.get(principal.tenant_id, connector_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail="connector not found") from exc
    try:
        service.check_import(connector.kind, body)
    except ConnectorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    project_id = _target_project(state, principal, body.project_id)
    params = {**body.model_dump(exclude_none=True), "project_id": project_id, "connector_id": connector_id}
    job = JobService(state).submit(principal.tenant_id, "connector.import", params, principal.user_id)
    return JSONResponse(job.model_dump(mode="json"), status_code=202)
