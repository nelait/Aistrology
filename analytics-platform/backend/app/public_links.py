"""Public view-only dashboard links (SHR-001a).

Unlike stateless embed tokens (SHR-003), a public link is a stored row: it expires, can be revoked
individually, and stops working everywhere as soon as a tenant admin disables public links (tenant
setting ``sharing.public_links_enabled``). Only the SHA-256 of the token is stored; the token is shown once.

Anonymous viewers get the dashboard spec (without owner and share lists) and widget data computed by
:class:`DashboardService` exactly as for signed-in viewers.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel
from sqlalchemy import select

from .dashboards.service import DashboardOut, DashboardService, Forbidden, NotFound
from .db.models import Dashboard, PublicLink, Tenant

if TYPE_CHECKING:  # pragma: no cover
    from .api.deps import AppState
    from .auth.service import Principal

SETTING_KEY = "sharing"
TOKEN_PREFIX = "apl_"


class SharingSettings(BaseModel):
    public_links_enabled: bool = True


class PublicLinksDisabled(PermissionError):
    pass


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _aware(ts: datetime) -> datetime:
    return ts if ts.tzinfo else ts.replace(tzinfo=UTC)


def sharing_settings(state: AppState, tenant_id: str) -> SharingSettings:
    return SharingSettings.model_validate(state.get_setting(tenant_id, SETTING_KEY) or {})


def link_out(link: PublicLink) -> dict[str, Any]:
    now = datetime.now(UTC)
    status = "revoked" if link.revoked_at else "expired" if _aware(link.expires_at) <= now else "active"
    return {
        "id": link.id,
        "dashboard_id": link.dashboard_id,
        "created_by": link.created_by,
        "created_at": link.created_at,
        "expires_at": link.expires_at,
        "revoked_at": link.revoked_at,
        "status": status,
    }


class PublicLinkService:
    def __init__(self, state: AppState):
        self.state = state
        self.dashboards = DashboardService(state)

    def _require_editor(self, principal: Principal, dashboard_id: str) -> DashboardOut:
        dash = self.dashboards.get(principal, dashboard_id)  # NotFound unless visible
        if dash.your_role not in ("owner", "editor"):
            raise Forbidden("editor access required to manage public links")
        return dash

    def create(self, principal: Principal, dashboard_id: str, ttl_hours: int) -> tuple[dict[str, Any], str]:
        if not sharing_settings(self.state, principal.tenant_id).public_links_enabled:
            raise PublicLinksDisabled("public links are disabled for this organization")
        self._require_editor(principal, dashboard_id)
        token = TOKEN_PREFIX + secrets.token_urlsafe(32)
        with self.state.db.session(principal.tenant_id) as s:
            link = PublicLink(
                tenant_id=principal.tenant_id,
                dashboard_id=dashboard_id,
                token_hash=_sha256(token),
                created_by=principal.user_id,
                expires_at=datetime.now(UTC) + timedelta(hours=ttl_hours),
            )
            s.add(link)
            s.flush()
            out = link_out(link)
        return out, token

    def list(self, principal: Principal, dashboard_id: str) -> list[dict[str, Any]]:
        self._require_editor(principal, dashboard_id)
        with self.state.db.session(principal.tenant_id) as s:
            rows = s.execute(
                select(PublicLink)
                .where(PublicLink.tenant_id == principal.tenant_id, PublicLink.dashboard_id == dashboard_id)
                .order_by(PublicLink.created_at.desc())
            ).scalars()
            return [link_out(r) for r in rows]

    def revoke(self, principal: Principal, dashboard_id: str, link_id: str) -> None:
        self._require_editor(principal, dashboard_id)
        with self.state.db.session(principal.tenant_id) as s:
            link = s.get(PublicLink, link_id)
            if link is None or link.tenant_id != principal.tenant_id or link.dashboard_id != dashboard_id:
                raise NotFound(link_id)
            link.revoked_at = link.revoked_at or datetime.now(UTC)

    # -- anonymous access ----------------------------------------------------------------------------
    def resolve(self, token: str) -> tuple[str, str, DashboardOut]:
        """(tenant_id, link_id, dashboard) for a valid token; NotFound for anything else (no oracle)."""
        if not token.startswith(TOKEN_PREFIX) or len(token) > 200:
            raise NotFound("link")
        with self.state.db.session() as s:
            link = s.execute(select(PublicLink).where(PublicLink.token_hash == _sha256(token))).scalar_one_or_none()
            if link is None or link.revoked_at is not None or _aware(link.expires_at) <= datetime.now(UTC):
                raise NotFound("link")
            tenant = s.get(Tenant, link.tenant_id)
            dash = s.get(Dashboard, link.dashboard_id)
            if tenant is None or tenant.status != "active" or dash is None or dash.archived or dash.tenant_id != link.tenant_id:
                raise NotFound("link")
            tenant_id, link_id = link.tenant_id, link.id
            out = DashboardService._out(dash, "viewer")
        if not sharing_settings(self.state, tenant_id).public_links_enabled:
            raise NotFound("link")
        # Never reveal who owns the dashboard or whom it is shared with.
        return tenant_id, link_id, out.model_copy(update={"owner_id": "", "shares": {}})

    def widget_data(self, token: str, widget_id: str, filters: dict[str, Any]) -> dict[str, Any]:
        tenant_id, _, dash = self.resolve(token)
        return self.dashboards._widget_data(tenant_id, dash, widget_id, filters)
