"""Projects and project-level access (AUTH-003).

* Admins and API keys see every project in the tenant.
* Other users see open projects (the "Default" project is open) and projects they are members of.
* Datasets belong to exactly one project. Everything reached through a dataset id
  (queries, pipelines, experiments, analytics, batch scoring) checks access here.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import or_, select

from .auth.rbac import Role
from .db.models import Project, ProjectMember

if TYPE_CHECKING:  # pragma: no cover
    from .api.deps import AppState
    from .auth.service import Principal


class ProjectAccessDenied(LookupError):
    """Raised as 404 so project contents aren't revealed."""


def default_project_id(state: AppState, tenant_id: str) -> str:
    with state.db.session(tenant_id) as s:
        project = s.execute(select(Project).where(Project.tenant_id == tenant_id, Project.name == "Default")).scalar_one_or_none()
        if project is None:
            project = Project(tenant_id=tenant_id, name="Default", open=True)
            s.add(project)
            s.flush()
        return project.id


def visible_projects(state: AppState, principal: Principal) -> set[str] | None:
    """None means unrestricted (all projects)."""
    if principal.role == Role.ADMIN.value or principal.method in ("api_key", "dev"):
        return None
    with state.db.session(principal.tenant_id) as s:
        member_of = select(ProjectMember.project_id).where(ProjectMember.user_id == principal.user_id)
        rows = s.execute(
            select(Project.id).where(Project.tenant_id == principal.tenant_id, or_(Project.open.is_(True), Project.id.in_(member_of)))
        ).all()
    return {r[0] for r in rows}


def check_project(state: AppState, principal: Principal, project_id: str | None) -> None:
    allowed = visible_projects(state, principal)
    if allowed is not None and project_id not in allowed:
        raise ProjectAccessDenied(project_id)


def check_dataset(state: AppState, principal: Principal, dataset_id: str) -> None:
    record = state.store.get(principal.tenant_id, dataset_id)
    check_project(state, principal, record.project_id)
