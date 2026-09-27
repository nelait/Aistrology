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


def _digest(payload: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


class AuditLog:
    GENESIS = "0" * 64

    def __init__(self) -> None:
        self._entries: list[AuditEntry] = []
        self._lock = threading.Lock()

    def record(self, tenant_id: str, actor: str, action: str, **detail: Any) -> AuditEntry:
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
