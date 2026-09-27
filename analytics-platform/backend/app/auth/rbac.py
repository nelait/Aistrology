"""Role-based access control (AUTH-002). The matrix mirrors REQUIREMENTS.md Appendix A."""

from __future__ import annotations

from enum import Enum


class Role(str, Enum):
    ADMIN = "admin"
    DATA_ENGINEER = "data_engineer"
    DATA_SCIENTIST = "data_scientist"
    ANALYST = "analyst"
    VIEWER = "viewer"


class Permission(str, Enum):
    MANAGE_TENANT = "tenant.manage"  # users, billing, LLM keys, quotas
    VIEW_AUDIT = "audit.view"
    WRITE_DATA = "data.write"  # upload / generate / connect
    EDIT_PIPELINES = "pipelines.edit"  # schemas + cleaning pipelines
    READ_DATA = "data.read"
    CREATE_ANALYTICS = "analytics.create"
    TRAIN_MODELS = "models.train"
    DEPLOY = "endpoints.deploy"  # deploy endpoints, manage API keys
    EDIT_DASHBOARDS = "dashboards.edit"
    VIEW = "view"  # dashboards and analytics
    PREDICT = "endpoints.predict"  # call inference endpoints (API keys)


_ALL = set(Permission)
_BUILDER = {
    Permission.WRITE_DATA,
    Permission.EDIT_PIPELINES,
    Permission.READ_DATA,
    Permission.CREATE_ANALYTICS,
    Permission.EDIT_DASHBOARDS,
    Permission.VIEW,
    Permission.PREDICT,
}

ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    Role.ADMIN: frozenset(_ALL),
    Role.DATA_ENGINEER: frozenset(_BUILDER | {Permission.DEPLOY}),
    Role.DATA_SCIENTIST: frozenset(_BUILDER | {Permission.TRAIN_MODELS, Permission.DEPLOY}),
    Role.ANALYST: frozenset(_BUILDER),
    Role.VIEWER: frozenset({Permission.VIEW, Permission.READ_DATA}),
}


def has_permission(role: str, permission: Permission, scopes: list[str] | None = None) -> bool:
    try:
        granted = ROLE_PERMISSIONS[Role(role)]
    except ValueError:
        return False
    if permission not in granted:
        return False
    # API keys may be narrowed further by scopes.
    return scopes is None or not scopes or permission.value in scopes
