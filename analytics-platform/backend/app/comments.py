"""Comments and annotations on dashboards and widgets (SHR-005).

* Anyone who can view a dashboard (SHR-002) can read and add comments; nobody else learns they exist.
* Threads are one level deep: a reply to a reply is attached to the thread's root comment.
* ``@<user id>`` mentions notify the mentioned user (``comment.mention``), but only users of the tenant who
  can view the dashboard; other mentions are ignored. Notifications carry no comment text.
* Authors edit their own comments. Authors and admins delete (deleting a root removes its replies).
  Authors, dashboard owners/editors and admins can resolve or reopen a thread.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from .auth.rbac import Role
from .dashboards.service import DashboardService, Forbidden, NotFound
from .db.models import Dashboard, DashboardComment, User

if TYPE_CHECKING:  # pragma: no cover
    from .api.deps import AppState
    from .auth.service import Principal

MAX_BODY = 5000
MAX_MENTIONS = 20
MENTION_RE = re.compile(r"(?<![\w@])@([A-Za-z0-9_-]{1,64})")


class CommentError(ValueError):
    pass


def _aware(ts: datetime | None) -> datetime | None:
    return ts if ts is None or ts.tzinfo else ts.replace(tzinfo=UTC)


def comment_out(c: DashboardComment) -> dict[str, Any]:
    return {
        "id": c.id,
        "dashboard_id": c.dashboard_id,
        "widget_id": c.widget_id,
        "parent_id": c.parent_id,
        "author_id": c.author_id,
        "body": c.body,
        "mentions": list(c.mentions or []),
        "resolved": c.resolved,
        "created_at": _aware(c.created_at),
        "edited_at": _aware(c.edited_at),
    }


class CommentService:
    def __init__(self, state: AppState):
        self.state = state
        self.dashboards = DashboardService(state)

    def _dashboard(self, principal: Principal, dashboard_id: str):
        return self.dashboards.get(principal, dashboard_id)  # NotFound unless the caller can view it

    def _mentions(self, principal: Principal, dashboard_id: str, body: str) -> list[str]:
        """Mentioned user ids that exist, are active and can view the dashboard."""
        from .auth.service import Principal as P

        wanted = list(dict.fromkeys(MENTION_RE.findall(body)))[:MAX_MENTIONS]
        out = []
        with self.state.db.session(principal.tenant_id) as s:
            dash = s.get(Dashboard, dashboard_id)
            for uid in wanted:
                user = s.get(User, uid)
                if user is None or user.tenant_id != principal.tenant_id or user.disabled or uid == principal.user_id:
                    continue
                if DashboardService.role_for(dash, P(principal.tenant_id, user.id, user.role, "jwt")) is not None:
                    out.append(uid)
        return out

    def _notify(self, principal: Principal, dash_name: str, comment: dict[str, Any], user_ids: list[str]) -> None:
        from .jobs.core import notify

        for uid in user_ids:
            notify(
                self.state,
                principal.tenant_id,
                uid,
                "comment.mention",
                f"You were mentioned on the dashboard {dash_name}",
                {
                    "dashboard_id": comment["dashboard_id"],
                    "widget_id": comment["widget_id"],
                    "comment_id": comment["id"],
                    "author_id": principal.user_id,
                },
            )

    @staticmethod
    def _body(body: str) -> str:
        body = body.strip()
        if not body:
            raise CommentError("comment is empty")
        if len(body) > MAX_BODY:
            raise CommentError(f"comments are limited to {MAX_BODY} characters")
        return body

    def list(self, principal: Principal, dashboard_id: str, widget_id: str | None = None, include_resolved: bool = True) -> list[dict]:
        self._dashboard(principal, dashboard_id)
        with self.state.db.session(principal.tenant_id) as s:
            q = (
                select(DashboardComment)
                .where(DashboardComment.tenant_id == principal.tenant_id, DashboardComment.dashboard_id == dashboard_id)
                .order_by(DashboardComment.created_at, DashboardComment.id)
            )
            rows = [comment_out(c) for c in s.execute(q).scalars()]
        roots = [dict(r, replies=[]) for r in rows if r["parent_id"] is None]
        by_id = {r["id"]: r for r in roots}
        for r in rows:
            if r["parent_id"] in by_id:
                by_id[r["parent_id"]]["replies"].append(r)
        if widget_id is not None:
            roots = [r for r in roots if r["widget_id"] == widget_id]
        if not include_resolved:
            roots = [r for r in roots if not r["resolved"]]
        return roots

    def create(self, principal: Principal, dashboard_id: str, body: str, widget_id: str | None, parent_id: str | None) -> dict:
        dash = self._dashboard(principal, dashboard_id)
        body = self._body(body)
        if widget_id is not None and dash.spec.widget(widget_id) is None:
            raise CommentError(f"unknown widget {widget_id!r}")
        with self.state.db.session(principal.tenant_id) as s:
            if parent_id is not None:
                parent = s.get(DashboardComment, parent_id)
                if parent is None or parent.tenant_id != principal.tenant_id or parent.dashboard_id != dashboard_id:
                    raise NotFound(parent_id)
                root = s.get(DashboardComment, parent.parent_id) if parent.parent_id else parent  # one level of threading
                parent_id, widget_id = root.id, root.widget_id
            mentions = self._mentions(principal, dashboard_id, body)
            c = DashboardComment(
                tenant_id=principal.tenant_id,
                dashboard_id=dashboard_id,
                widget_id=widget_id,
                parent_id=parent_id,
                author_id=principal.user_id,
                body=body,
                mentions=mentions,
            )
            s.add(c)
            s.flush()
            out = comment_out(c)
        self.state.audit.record(
            principal.tenant_id, principal.user_id, "dashboard.comment.create", dashboard_id=dashboard_id, comment_id=out["id"]
        )
        self._notify(principal, dash.name, out, mentions)
        return out

    def _load(self, s, principal: Principal, dashboard_id: str, comment_id: str) -> DashboardComment:
        c = s.get(DashboardComment, comment_id)
        if c is None or c.tenant_id != principal.tenant_id or c.dashboard_id != dashboard_id:
            raise NotFound(comment_id)
        return c

    def update(self, principal: Principal, dashboard_id: str, comment_id: str, body: str | None, resolved: bool | None) -> dict:
        dash = self._dashboard(principal, dashboard_id)
        new_mentions: list[str] = []
        with self.state.db.session(principal.tenant_id) as s:
            c = self._load(s, principal, dashboard_id, comment_id)
            is_author = c.author_id == principal.user_id
            if body is not None:
                if not is_author:
                    raise Forbidden("only the author can edit a comment")
                c.body = self._body(body)
                mentions = self._mentions(principal, dashboard_id, c.body)
                new_mentions = [m for m in mentions if m not in (c.mentions or [])]
                c.mentions = mentions
                c.edited_at = datetime.now(UTC)
            if resolved is not None:
                if not (is_author or dash.your_role in ("owner", "editor") or principal.role == Role.ADMIN.value):
                    raise Forbidden("only the author or a dashboard editor can resolve a comment")
                c.resolved = resolved
            out = comment_out(c)
        self._notify(principal, dash.name, out, new_mentions)
        return out

    def delete(self, principal: Principal, dashboard_id: str, comment_id: str) -> None:
        self._dashboard(principal, dashboard_id)
        with self.state.db.session(principal.tenant_id) as s:
            c = self._load(s, principal, dashboard_id, comment_id)
            is_admin = principal.role == Role.ADMIN.value
            if c.author_id != principal.user_id and not is_admin:
                raise Forbidden("only the author or an admin can delete a comment")
            replies = s.execute(
                select(DashboardComment).where(DashboardComment.tenant_id == principal.tenant_id, DashboardComment.parent_id == c.id)
            ).scalars()
            for r in replies:
                s.delete(r)
            s.delete(c)
            author = c.author_id
        self.state.audit.record(
            principal.tenant_id,
            principal.user_id,
            "dashboard.comment.delete",
            dashboard_id=dashboard_id,
            comment_id=comment_id,
            author_id=author,
        )
