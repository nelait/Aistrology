"""Append-only, tamper-evident audit log (AUTH-005, PIP-006, SOC-PI-003, LLM-NFR-003).

Each entry stores the SHA-256 of the previous entry, so an edit or deletion
anywhere in the chain is detectable with :meth:`AuditLog.verify`. This
in-memory implementation defines the interface; production storage is an
append-only Postgres table plus a periodic export to WORM object storage.
"""

from __future__ import annotations

import hashlib
import json
import threading
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel


class AuditEntry(BaseModel):
    seq: int
    at: str
    tenant_id: str
    actor: str
    action: str
    detail: dict[str, Any]
    prev_hash: str
    hash: str


# Detail fields that the retention policy may later erase (SOC-PRV-002, Appendix B: LLM bodies after 30 days).
# The chain hashes a commitment (SHA-256) of each such value instead of the value itself, so erasing the value
# and keeping its commitment leaves the chain verifiable. Entries list their committed fields in ``_redactable``.
REDACTABLE = ("prompt_excerpt", "error")


def _commit(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def redacted(value: Any) -> dict[str, Any]:
    """What an erased field is replaced with: its commitment, without the content."""
    if isinstance(value, dict) and value.get("redacted") is True:
        return value
    return {"redacted": True, "sha256": _commit(value)}


def _hashable(payload: dict[str, Any]) -> dict[str, Any]:
    detail = payload.get("detail")
    if not isinstance(detail, dict) or not detail.get("_redactable"):
        return payload
    detail = dict(detail)
    for key in detail["_redactable"]:
        if key in detail:
            value = detail[key]
            detail[key] = {"commit": value["sha256"] if isinstance(value, dict) and value.get("redacted") is True else _commit(value)}
    return {**payload, "detail": detail}


def _digest(payload: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(_hashable(payload), sort_keys=True, default=str).encode()).hexdigest()


def _mark_redactable(action: str, detail: dict[str, Any]) -> dict[str, Any]:
    if action == "llm.call":
        keys = [k for k in REDACTABLE if detail.get(k) is not None]
        if keys:
            return {**detail, "_redactable": keys}
    return detail


class AuditLog:
    GENESIS = "0" * 64

    def __init__(self) -> None:
        self._entries: list[AuditEntry] = []
        self._lock = threading.Lock()

    def record(self, tenant_id: str, actor: str, action: str, **detail: Any) -> AuditEntry:
        detail = _mark_redactable(action, detail)
        with self._lock:
            prev = self._entries[-1].hash if self._entries else self.GENESIS
            body = {
                "seq": len(self._entries),
                "at": datetime.now(UTC).isoformat(),
                "tenant_id": tenant_id,
                "actor": actor,
                "action": action,
                "detail": detail,
                "prev_hash": prev,
            }
            entry = AuditEntry(**body, hash=_digest(body))
            self._entries.append(entry)
            return entry

    def entries(self, tenant_id: str | None = None, action: str | None = None) -> list[AuditEntry]:
        return [e for e in self._entries if (tenant_id is None or e.tenant_id == tenant_id) and (action is None or e.action == action)]

    def verify(self) -> bool:
        prev = self.GENESIS
        for entry in self._entries:
            body = entry.model_dump(exclude={"hash"})
            if entry.prev_hash != prev or _digest(body) != entry.hash:
                return False
            prev = entry.hash
        return True


class DbAuditLog(AuditLog):
    """Audit log persisted in the metadata DB, with one hash chain per tenant.

    Appends for a tenant are serialized, so the chain stays linear across API
    and worker processes: a per-process lock plus the UNIQUE (tenant_id, seq)
    constraint, retried on conflict.
    """

    def __init__(self, db) -> None:  # db: app.db.session.Database
        super().__init__()
        self.db = db

    def record(self, tenant_id: str, actor: str, action: str, **detail: Any) -> AuditEntry:
        from sqlalchemy import select
        from sqlalchemy.exc import IntegrityError

        from .db.models import AuditRecord

        detail = _mark_redactable(action, json.loads(json.dumps(detail, default=str)))
        for _ in range(5):
            with self._lock:
                try:
                    with self.db.session(tenant_id) as s:
                        last = s.execute(
                            select(AuditRecord).where(AuditRecord.tenant_id == tenant_id).order_by(AuditRecord.seq.desc()).limit(1)
                        ).scalar_one_or_none()
                        body = {
                            "seq": last.seq + 1 if last else 0,
                            "at": datetime.now(UTC).isoformat(),
                            "tenant_id": tenant_id,
                            "actor": actor,
                            "action": action,
                            "detail": detail,
                            "prev_hash": last.hash if last else self.GENESIS,
                        }
                        entry = AuditEntry(**body, hash=_digest(body))
                        s.add(AuditRecord(**entry.model_dump()))
                    return entry
                except IntegrityError:
                    continue
        raise RuntimeError("could not append to the audit log")

    def entries(self, tenant_id: str | None = None, action: str | None = None, limit: int | None = None) -> list[AuditEntry]:
        from sqlalchemy import select

        from .db.models import AuditRecord

        with self.db.session(tenant_id) as s:
            q = select(AuditRecord).order_by(AuditRecord.tenant_id, AuditRecord.seq)
            if tenant_id is not None:
                q = q.where(AuditRecord.tenant_id == tenant_id)
            if action is not None:
                q = q.where(AuditRecord.action == action)
            rows = s.execute(q).scalars().all()
        entries = [
            AuditEntry(
                seq=r.seq,
                at=r.at,
                tenant_id=r.tenant_id,
                actor=r.actor,
                action=r.action,
                detail=r.detail,
                prev_hash=r.prev_hash,
                hash=r.hash,
            )
            for r in rows
        ]
        return entries[-limit:] if limit else entries

    def anchor(self, tenant_id: str) -> dict[str, Any] | None:
        """The last entry removed by retention (``{seq, hash}``); the remaining chain continues from it."""
        from .db.models import TenantSetting

        with self.db.session(tenant_id) as s:
            row = s.get(TenantSetting, (tenant_id, "audit_anchor"))
            return dict(row.value) if row else None

    def verify(self, tenant_id: str | None = None) -> bool:
        chains: dict[str, list[AuditEntry]] = {}
        for e in self.entries(tenant_id):
            chains.setdefault(e.tenant_id, []).append(e)
        for tenant, chain in chains.items():
            anchor = self.anchor(tenant)
            prev, seq = (anchor["hash"], anchor["seq"] + 1) if anchor else (self.GENESIS, 0)
            for entry in chain:
                if entry.seq != seq or entry.prev_hash != prev or _digest(entry.model_dump(exclude={"hash"})) != entry.hash:
                    return False
                prev, seq = entry.hash, seq + 1
        return True
