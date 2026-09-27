"""Resumable uploads (ING-002, ING-NFR-001), modelled on the tus core protocol.

1. ``POST /v1/datasets/uploads`` declares the file (name, total size, optional SHA-256). Size and storage quota
   are checked here, before any byte is sent.
2. ``PATCH /v1/datasets/uploads/{id}`` sends the next part as the raw body with ``Upload-Offset`` set to the
   number of bytes already received. A wrong offset is answered with 409 and the server's offset, so a client
   that lost a response simply asks ``GET`` for the offset and resumes from there.
3. ``POST /v1/datasets/uploads/{id}/complete`` assembles the parts and ingests them exactly like a single-shot
   upload: SHA-256 check, format detection, schema inference.

Parts are stored encrypted with the tenant key under ``uploads/{id}/``. The offset only moves forward through a
conditional update, so two clients racing on one session cannot interleave parts.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from ..auth.service import Principal
from ..db.models import UploadSession, utcnow
from ..storage.datasets import DatasetTooLarge, QuotaExceeded
from .datasets import UploadResponse, Writer, _store_upload, _target_project
from .deps import AppState, StateDep

router = APIRouter(prefix="/v1/datasets/uploads", tags=["datasets"])

MAX_OPEN_SESSIONS = 20


class CreateUpload(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    size: int = Field(gt=0, description="Total size of the file in bytes")
    sha256: str | None = Field(default=None, pattern="^[0-9a-fA-F]{64}$")
    project_id: str | None = Field(default=None, max_length=40)


class UploadStatus(BaseModel):
    id: str
    filename: str
    size: int
    offset: int
    status: str
    part_max_bytes: int
    expires_at: str
    dataset_id: str | None = None


def _status(state: AppState, u: UploadSession) -> UploadStatus:
    return UploadStatus(
        id=u.id,
        filename=u.filename,
        size=u.size,
        offset=u.received,
        status=u.status,
        part_max_bytes=state.settings.upload_part_max_bytes,
        expires_at=u.expires_at.isoformat(),
        dataset_id=u.dataset_id if u.status == "completed" else None,
    )


def _expired(u: UploadSession) -> bool:
    expires = u.expires_at if u.expires_at.tzinfo else u.expires_at.replace(tzinfo=utcnow().tzinfo)
    return expires <= utcnow()


def _load(state: AppState, principal: Principal, upload_id: str) -> UploadSession:
    with state.db.session(principal.tenant_id) as s:
        u = s.get(UploadSession, upload_id)
        if u is None or u.tenant_id != principal.tenant_id or u.created_by != principal.user_id or u.status == "aborted":
            raise HTTPException(status_code=404, detail="upload not found")
        s.expunge(u)
    if u.status in ("open", "completing") and _expired(u):
        _discard(state, principal.tenant_id, u, "aborted")
        raise HTTPException(status_code=410, detail="upload session expired; start a new upload")
    return u


def _delete_parts(state: AppState, tenant_id: str, parts: list[Any]) -> None:
    for _offset, _length, key in parts:
        state.store.objects.delete(tenant_id, key)


def _discard(state: AppState, tenant_id: str, u: UploadSession, status: str) -> None:
    _delete_parts(state, tenant_id, u.parts or [])
    with state.db.session(tenant_id) as s:
        s.execute(update(UploadSession).where(UploadSession.id == u.id).values(status=status, parts=[]))


def _purge_expired(state: AppState, tenant_id: str) -> None:
    with state.db.session(tenant_id) as s:
        stale = s.scalars(
            select(UploadSession).where(
                UploadSession.tenant_id == tenant_id, UploadSession.status == "open", UploadSession.expires_at <= utcnow()
            )
        ).all()
        for u in stale:
            s.expunge(u)
    for u in stale:
        _discard(state, tenant_id, u, "aborted")


@router.post("", response_model=UploadStatus, status_code=201)
async def create_upload(body: CreateUpload, state: AppState = StateDep, principal: Principal = Writer) -> UploadStatus:
    """Start a resumable upload. Oversized files and exhausted quotas are refused before the transfer."""
    if body.size > state.store.max_dataset_bytes:
        raise HTTPException(status_code=413, detail=str(DatasetTooLarge(state.store.max_dataset_bytes)))
    try:
        state.store._check_quota(principal.tenant_id, body.size)
    except QuotaExceeded as exc:
        raise HTTPException(status_code=507, detail=str(exc)) from exc
    project = _target_project(state, principal, body.project_id)
    _purge_expired(state, principal.tenant_id)
    with state.db.session(principal.tenant_id) as s:
        open_count = len(
            s.scalars(select(UploadSession.id).where(UploadSession.tenant_id == principal.tenant_id, UploadSession.status == "open")).all()
        )
        if open_count >= MAX_OPEN_SESSIONS:
            raise HTTPException(status_code=429, detail=f"at most {MAX_OPEN_SESSIONS} uploads may be in progress at once")
        u = UploadSession(
            tenant_id=principal.tenant_id,
            filename=body.filename,
            size=body.size,
            sha256=body.sha256.lower() if body.sha256 else None,
            project_id=project,
            parts=[],
            created_by=principal.user_id,
            expires_at=utcnow() + timedelta(hours=state.settings.upload_session_ttl_hours),
        )
        s.add(u)
        s.flush()
        s.expunge(u)
    state.audit.record(principal.tenant_id, principal.user_id, "dataset.upload_started", upload_id=u.id, size=body.size)
    return _status(state, u)


@router.get("/{upload_id}", response_model=UploadStatus)
async def get_upload(upload_id: str, response: Response, state: AppState = StateDep, principal: Principal = Writer) -> UploadStatus:
    u = _load(state, principal, upload_id)
    response.headers["Upload-Offset"] = str(u.received)
    return _status(state, u)


@router.patch("/{upload_id}", response_model=UploadStatus)
async def append_part(
    upload_id: str,
    request: Request,
    response: Response,
    upload_offset: int = Header(..., ge=0),
    state: AppState = StateDep,
    principal: Principal = Writer,
) -> UploadStatus:
    """Append the request body at ``Upload-Offset``."""
    u = _load(state, principal, upload_id)
    if u.status != "open":
        raise HTTPException(status_code=409, detail=f"upload is {u.status}")
    if upload_offset != u.received:
        raise HTTPException(
            status_code=409, detail={"message": "offset mismatch", "offset": u.received}, headers={"Upload-Offset": str(u.received)}
        )
    limit = min(state.settings.upload_part_max_bytes, u.size - u.received)
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > limit:
        raise HTTPException(status_code=413, detail=f"a part may carry at most {limit} bytes here")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > limit:
            raise HTTPException(status_code=413, detail=f"a part may carry at most {limit} bytes here")
    if not data:
        raise HTTPException(status_code=422, detail="empty part")

    key = f"uploads/{u.id}/part-{u.received:012d}-{uuid.uuid4().hex[:8]}"
    state.store.objects.put_bytes(principal.tenant_id, key, bytes(data))
    new_offset = u.received + len(data)
    with state.db.session(principal.tenant_id) as s:
        claimed = s.execute(
            update(UploadSession)
            .where(UploadSession.id == u.id, UploadSession.status == "open", UploadSession.received == u.received)
            .values(received=new_offset, parts=[*u.parts, [u.received, len(data), key]])
        ).rowcount
    if claimed != 1:  # another request appended first; drop ours
        state.store.objects.delete(principal.tenant_id, key)
        current = _load(state, principal, upload_id)
        raise HTTPException(
            status_code=409,
            detail={"message": "offset mismatch", "offset": current.received},
            headers={"Upload-Offset": str(current.received)},
        )
    u.received = new_offset
    response.headers["Upload-Offset"] = str(new_offset)
    return _status(state, u)


@router.post("/{upload_id}/complete", response_model=UploadResponse, status_code=201)
async def complete_upload(upload_id: str, state: AppState = StateDep, principal: Principal = Writer) -> UploadResponse:
    """Assemble the parts into a dataset. Calling it again after success returns the same dataset."""
    u = _load(state, principal, upload_id)
    if u.status == "completed" and u.dataset_id:
        return UploadResponse(dataset=state.store.get(principal.tenant_id, u.dataset_id))
    if u.received != u.size:
        raise HTTPException(status_code=409, detail={"message": "upload is incomplete", "offset": u.received, "size": u.size})
    with state.db.session(principal.tenant_id) as s:
        claimed = s.execute(
            update(UploadSession).where(UploadSession.id == u.id, UploadSession.status == "open").values(status="completing")
        ).rowcount
    if claimed != 1:
        raise HTTPException(status_code=409, detail="upload is already being completed")

    parts = sorted(u.parts, key=lambda p: p[0])

    async def chunks() -> AsyncIterator[bytes]:
        expected = 0
        for offset, length, key in parts:
            if offset != expected:
                raise ValueError("upload parts are not contiguous")
            data = state.store.objects.get_bytes(principal.tenant_id, key)
            if len(data) != length:
                raise ValueError("an upload part is corrupted")
            expected += length
            yield data

    try:
        result = await _store_upload(
            state, principal, u.filename, chunks(), declared_size=u.size, expected_sha256=u.sha256, project_id=u.project_id
        )
    except HTTPException:
        # A checksum or format failure is final: the parts are wrong, so the client must start over.
        _discard(state, principal.tenant_id, u, "aborted")
        raise
    except Exception:
        with state.db.session(principal.tenant_id) as s:  # transient (storage) failure: allow a retry
            s.execute(update(UploadSession).where(UploadSession.id == u.id).values(status="open"))
        raise
    _delete_parts(state, principal.tenant_id, parts)
    with state.db.session(principal.tenant_id) as s:
        s.execute(update(UploadSession).where(UploadSession.id == u.id).values(status="completed", parts=[], dataset_id=result.dataset.id))
    return result


@router.delete("/{upload_id}", status_code=204)
async def abort_upload(upload_id: str, state: AppState = StateDep, principal: Principal = Writer) -> None:
    u = _load(state, principal, upload_id)
    if u.status == "completed":
        raise HTTPException(status_code=409, detail="upload is already completed")
    _discard(state, principal.tenant_id, u, "aborted")
