"""Tenant lifecycle: deletion with crypto-shredding (MT-010, SOC-CON-004, SOC-PRV-004)."""

from __future__ import annotations

import shutil
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete

from .db.models import TENANT_TABLES, Tenant

if TYPE_CHECKING:  # pragma: no cover
    from .api.deps import AppState


def delete_tenant_data(state: AppState, tenant_id: str) -> dict[str, Any]:
    """Irreversibly remove a tenant.

    1. Shred the tenant data key: every encrypted object, including copies in
       bucket versions and backups, becomes unreadable at once.
    2. Delete the tenant's objects, secrets and local cache.
    3. Delete tenant rows from the metadata DB. The audit chain is kept (with
       the tenant marked deleted) as evidence for the SOC 2 observation window.
    """
    objects = state.objects.delete_tenant(tenant_id)
    state.secrets.delete_tenant(tenant_id)
    shutil.rmtree(state.store.cache_dir / "cache" / tenant_id, ignore_errors=True)
    shutil.rmtree(state.store.cache_dir / "scratch" / tenant_id, ignore_errors=True)
    rows = 0
    keep = {"audit_log"}
    with state.db.session(tenant_id) as s:
        # Children before parents (reverse topological order).
        for table in reversed(TENANT_TABLES):
            if table.name in keep:
                continue
            rows += s.execute(delete(table).where(table.c.tenant_id == tenant_id)).rowcount or 0
        tenant = s.get(Tenant, tenant_id)
        if tenant is not None:
            tenant.status = "deleted"
    state.audit.record(tenant_id, "system", "tenant.deleted", objects_deleted=objects, rows_deleted=rows)
    return {"tenant_id": tenant_id, "objects_deleted": objects, "rows_deleted": rows, "key_shredded": True}
