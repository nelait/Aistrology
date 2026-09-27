"""SCIM 2.0 user provisioning (AUTH-001a, RFC 7643/7644).

* Authentication: a per-tenant bearer token ``scim_<tenant>_<secret>`` created by a tenant admin
  (shown once; only its SHA-256 is stored in the tenant setting ``scim``).
* ``/scim/v2/Users``: list (``filter=userName eq "..."`` / ``externalId eq "..."``, paging), get, create,
  replace (PUT), patch (``active``, ``name``, ``displayName``, ``externalId`` and the role via the custom
  extension attribute ``urn:ietf:params:scim:schemas:extension:analyticsplatform:2.0:User:role``) and delete
  (which disables the user; data and audit history are kept).
* Provisioned users sign in through SSO (they have no password). The last active admin can't be
  disabled or demoted through SCIM.

SAML 2.0 is out of scope here: the maintained libraries (pysaml2, python3-saml) need the native xmlsec1 /
libxmlsec1 toolchain for XML-DSig verification, which is not part of this deployment image.
"""

from __future__ import annotations

import functools
import hashlib
import hmac
import secrets
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import func, select

from ..auth.rbac import Permission, Role
from ..auth.service import Principal
from ..db.models import RefreshToken, ScimIdentity, User
from ..storage.datasets import TENANT_ID_RE
from .deps import AppState, StateDep, require

router = APIRouter(tags=["scim"])
Admin = require(Permission.MANAGE_TENANT)

USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"
EXT_SCHEMA = "urn:ietf:params:scim:schemas:extension:analyticsplatform:2.0:User"
LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error"
MEDIA_TYPE = "application/scim+json"
SETTING_KEY = "scim"
NO_PASSWORD = "!scim-provisioned"


class ScimError(Exception):
    def __init__(self, status: int, detail: str, scim_type: str | None = None):
        self.status, self.detail, self.scim_type = status, detail, scim_type
        super().__init__(detail)


def _error_response(exc: ScimError) -> JSONResponse:
    body: dict[str, Any] = {"schemas": [ERROR_SCHEMA], "status": str(exc.status), "detail": exc.detail}
    if exc.scim_type:
        body["scimType"] = exc.scim_type
    headers = {"WWW-Authenticate": "Bearer"} if exc.status == 401 else None
    return JSONResponse(body, status_code=exc.status, media_type=MEDIA_TYPE, headers=headers)


def scim_endpoint(fn):
    """Convert :class:`ScimError` into SCIM error responses."""

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except ScimError as exc:
            return _error_response(exc)

    return wrapper


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _authenticate(state: AppState, request: Request, authorization: str | None) -> str:
    """Return the tenant the SCIM token belongs to."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise ScimError(401, "SCIM bearer token required")
    token = authorization[7:].strip()
    if not token.startswith("scim_") or "_" not in token[5:]:
        raise ScimError(401, "invalid SCIM token")
    tenant_id = token[5:].split("_", 1)[0]
    if not TENANT_ID_RE.match(tenant_id):
        raise ScimError(401, "invalid SCIM token")
    setting = state.get_setting(tenant_id, SETTING_KEY) or {}
    expected = setting.get("token_hash") or _sha256("no-token")
    if not hmac.compare_digest(expected, _sha256(token)) or not setting.get("token_hash"):
        raise ScimError(401, "invalid SCIM token")
    from ..auth.network import network_allows
    from ..db.models import Tenant

    with state.db.session(tenant_id) as s:
        tenant = s.get(Tenant, tenant_id)
        if tenant is None or tenant.status != "active":
            raise ScimError(401, "organization is suspended")
    if not network_allows(state, tenant_id, request.client.host if request.client else None):  # MGT-007 applies here too
        raise ScimError(403, "access from this IP address is not allowed")
    if not state.rate_limiter.allow(f"scim:{tenant_id}", 600):
        raise ScimError(429, "rate limit exceeded")
    return tenant_id


def _resource(user: User, external_id: str | None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "schemas": [USER_SCHEMA, EXT_SCHEMA],
        "id": user.id,
        "userName": user.email,
        "name": {"formatted": user.name or ""},
        "displayName": user.name or user.email,
        "emails": [{"value": user.email, "primary": True, "type": "work"}],
        "active": not user.disabled,
        EXT_SCHEMA: {"role": user.role},
        "meta": {
            "resourceType": "User",
            "created": user.created_at.isoformat() if user.created_at else None,
            "location": f"/scim/v2/Users/{user.id}",
        },
    }
    if external_id:
        out["externalId"] = external_id
    return out


def _json(body: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(body, status_code=status, media_type=MEDIA_TYPE)


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.lower() in ("true", "false"):
        return value.lower() == "true"
    raise ScimError(400, "active must be a boolean", "invalidValue")


def _as_role(value: Any) -> str:
    try:
        return Role(str(value)).value
    except ValueError as exc:
        raise ScimError(400, f"role must be one of {[r.value for r in Role]}", "invalidValue") from exc


def _get_user(s, tenant_id: str, user_id: str) -> User:
    user = s.get(User, user_id)
    if user is None or user.tenant_id != tenant_id:
        raise ScimError(404, "user not found")
    return user


def _external(s, user_id: str) -> str | None:
    row = s.get(ScimIdentity, user_id)
    return row.external_id if row else None


def _set_external(s, tenant_id: str, user_id: str, external_id: str | None) -> None:
    row = s.get(ScimIdentity, user_id)
    if row is None:
        s.add(ScimIdentity(user_id=user_id, tenant_id=tenant_id, external_id=external_id))
    else:
        row.external_id = external_id


def _guard_last_admin(s, tenant_id: str, user: User, *, disabled: bool, role: str) -> None:
    if user.role != Role.ADMIN.value or (not disabled and role == Role.ADMIN.value) or user.disabled:
        return
    admins = s.execute(
        select(func.count()).select_from(User).where(User.tenant_id == tenant_id, User.role == Role.ADMIN.value, User.disabled.is_(False))
    ).scalar_one()
    if admins <= 1:
        raise ScimError(409, "can't disable or demote the organization's last active admin", "mutability")


def _apply(s, tenant_id: str, user: User, attrs: dict[str, Any]) -> dict[str, Any]:
    """Apply a dict of SCIM attributes; returns what changed (for the audit log)."""
    changes: dict[str, Any] = {}
    disabled, role = user.disabled, user.role
    if "active" in attrs:
        disabled = not _as_bool(attrs["active"])
    ext = attrs.get(EXT_SCHEMA)
    if isinstance(ext, dict) and "role" in ext:
        role = _as_role(ext["role"])
    if f"{EXT_SCHEMA}:role" in attrs:
        role = _as_role(attrs[f"{EXT_SCHEMA}:role"])
    _guard_last_admin(s, tenant_id, user, disabled=disabled, role=role)
    if disabled != user.disabled:
        user.disabled = changes["disabled"] = disabled
        if disabled:  # end sessions now; access tokens are re-checked on every request
            for t in s.execute(select(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.revoked.is_(False))).scalars():
                t.revoked = True
    if role != user.role:
        user.role = changes["role"] = role
    name = attrs.get("displayName")
    if isinstance(attrs.get("name"), dict):
        n = attrs["name"]
        name = n.get("formatted") or " ".join(p for p in (n.get("givenName"), n.get("familyName")) if p) or name
    if "name.formatted" in attrs:
        name = attrs["name.formatted"]
    if name is not None and str(name)[:200] != (user.name or ""):
        user.name = changes["name"] = str(name)[:200]
    if "externalId" in attrs:
        _set_external(s, tenant_id, user.id, str(attrs["externalId"])[:255] if attrs["externalId"] else None)
        changes["external_id"] = True
    return changes


def _email_of(body: dict[str, Any]) -> str:
    email = body.get("userName")
    if not email:
        emails = body.get("emails") or []
        primary = next((e for e in emails if isinstance(e, dict) and e.get("primary")), emails[0] if emails else None)
        email = primary.get("value") if isinstance(primary, dict) else None
    if not isinstance(email, str) or "@" not in email or len(email) > 320:
        raise ScimError(400, "userName must be the user's email address", "invalidValue")
    return email.strip().lower()


async def _body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except ValueError as exc:
        raise ScimError(400, "invalid JSON", "invalidSyntax") from exc
    if not isinstance(body, dict):
        raise ScimError(400, "expected a JSON object", "invalidSyntax")
    return body


# -- endpoints ------------------------------------------------------------------------------------------


@router.get("/scim/v2/ServiceProviderConfig")
async def service_provider_config() -> JSONResponse:
    return _json(
        {
            "schemas": ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
            "patch": {"supported": True},
            "bulk": {"supported": False, "maxOperations": 0, "maxPayloadSize": 0},
            "filter": {"supported": True, "maxResults": 200},
            "changePassword": {"supported": False},
            "sort": {"supported": False},
            "etag": {"supported": False},
            "authenticationSchemes": [{"type": "oauthbearertoken", "name": "Bearer token", "description": "Per-tenant SCIM token"}],
        }
    )


@router.get("/scim/v2/Users")
@scim_endpoint
async def list_users(
    request: Request,
    filter: str | None = None,
    startIndex: int = 1,  # noqa: N803 - SCIM parameter names
    count: int = 100,
    authorization: str | None = Header(None),
    state: AppState = StateDep,
) -> JSONResponse:
    tenant_id = _authenticate(state, request, authorization)
    start, count = max(1, startIndex), max(0, min(200, count))
    with state.db.session(tenant_id) as s:
        q = select(User).where(User.tenant_id == tenant_id)
        if filter:
            parts = filter.split(" ", 2)
            if len(parts) != 3 or parts[1].lower() != "eq" or not (parts[2].startswith('"') and parts[2].endswith('"')):
                raise ScimError(400, 'supported filters: userName eq "..." and externalId eq "..."', "invalidFilter")
            attr, value = parts[0].lower(), parts[2][1:-1]
            if attr == "username":
                q = q.where(func.lower(User.email) == value.lower())
            elif attr == "externalid":
                q = q.where(
                    User.id.in_(select(ScimIdentity.user_id).where(ScimIdentity.tenant_id == tenant_id, ScimIdentity.external_id == value))
                )
            else:
                raise ScimError(400, 'supported filters: userName eq "..." and externalId eq "..."', "invalidFilter")
        users = s.execute(q.order_by(User.created_at, User.id)).scalars().all()
        page = users[start - 1 : start - 1 + count]
        resources = [_resource(u, _external(s, u.id)) for u in page]
    return _json(
        {"schemas": [LIST_SCHEMA], "totalResults": len(users), "startIndex": start, "itemsPerPage": len(resources), "Resources": resources}
    )


@router.get("/scim/v2/Users/{user_id}")
@scim_endpoint
async def get_user(user_id: str, request: Request, authorization: str | None = Header(None), state: AppState = StateDep) -> JSONResponse:
    tenant_id = _authenticate(state, request, authorization)
    with state.db.session(tenant_id) as s:
        user = _get_user(s, tenant_id, user_id)
        return _json(_resource(user, _external(s, user.id)))


@router.post("/scim/v2/Users")
@scim_endpoint
async def create_user(request: Request, authorization: str | None = Header(None), state: AppState = StateDep) -> JSONResponse:
    tenant_id = _authenticate(state, request, authorization)
    body = await _body(request)
    email = _email_of(body)
    default_role = (state.get_setting(tenant_id, "sso") or {}).get("default_role", Role.VIEWER.value)
    ext = body.get(EXT_SCHEMA) if isinstance(body.get(EXT_SCHEMA), dict) else {}
    role = _as_role(ext.get("role", default_role))
    with state.db.session(tenant_id) as s:
        if s.execute(select(User.id).where(func.lower(User.email) == email)).first():
            raise ScimError(409, "a user with this userName already exists", "uniqueness")
        user = User(tenant_id=tenant_id, email=email, password_hash=NO_PASSWORD, role=role)
        s.add(user)
        s.flush()
        attrs = {k: v for k, v in body.items() if k in ("name", "displayName", "externalId", "active")}
        _apply(s, tenant_id, user, attrs)
        s.flush()
        out = _resource(user, _external(s, user.id))
    state.audit.record(tenant_id, "scim", "scim.user.create", user_id=out["id"], role=role)
    return _json(out, 201)


@router.put("/scim/v2/Users/{user_id}")
@scim_endpoint
async def replace_user(
    user_id: str, request: Request, authorization: str | None = Header(None), state: AppState = StateDep
) -> JSONResponse:
    tenant_id = _authenticate(state, request, authorization)
    body = await _body(request)
    with state.db.session(tenant_id) as s:
        user = _get_user(s, tenant_id, user_id)
        if _email_of(body) != user.email:
            raise ScimError(400, "userName can't be changed", "mutability")
        changes = _apply(
            s, tenant_id, user, {k: v for k, v in body.items() if k in ("name", "displayName", "externalId", "active", EXT_SCHEMA)}
        )
        out = _resource(user, _external(s, user.id))
    state.audit.record(tenant_id, "scim", "scim.user.replace", user_id=user_id, **changes)
    return _json(out)


@router.patch("/scim/v2/Users/{user_id}")
@scim_endpoint
async def patch_user(user_id: str, request: Request, authorization: str | None = Header(None), state: AppState = StateDep) -> JSONResponse:
    tenant_id = _authenticate(state, request, authorization)
    body = await _body(request)
    ops = body.get("Operations")
    if not isinstance(ops, list) or not ops:
        raise ScimError(400, "Operations are required", "invalidSyntax")
    attrs: dict[str, Any] = {}
    for op in ops:
        if not isinstance(op, dict) or str(op.get("op", "")).lower() not in ("add", "replace"):
            raise ScimError(400, "only add and replace operations are supported", "invalidSyntax")
        path, value = op.get("path"), op.get("value")
        if path:
            key = {"active": "active", "displayname": "displayName", "externalid": "externalId", "name.formatted": "name.formatted"}.get(
                path.lower(), path
            )
            if key not in ("active", "displayName", "externalId", "name.formatted", f"{EXT_SCHEMA}:role", "name"):
                raise ScimError(400, f"unsupported path {path!r}", "invalidPath")
            attrs[key] = value
        elif isinstance(value, dict):
            attrs.update(value)
        else:
            raise ScimError(400, "operations without a path need an object value", "invalidValue")
    with state.db.session(tenant_id) as s:
        user = _get_user(s, tenant_id, user_id)
        changes = _apply(s, tenant_id, user, attrs)
        out = _resource(user, _external(s, user.id))
    state.audit.record(tenant_id, "scim", "scim.user.patch", user_id=user_id, **changes)
    return _json(out)


@router.delete("/scim/v2/Users/{user_id}", status_code=204)
@scim_endpoint
async def delete_user(user_id: str, request: Request, authorization: str | None = Header(None), state: AppState = StateDep) -> Response:
    """Deprovisioning disables the user (their work and the audit trail are kept)."""
    tenant_id = _authenticate(state, request, authorization)
    with state.db.session(tenant_id) as s:
        user = _get_user(s, tenant_id, user_id)
        _apply(s, tenant_id, user, {"active": False})
    state.audit.record(tenant_id, "scim", "scim.user.deprovision", user_id=user_id)
    return Response(status_code=204)


# -- token management (tenant admin) ------------------------------------------------------------------------


@router.post("/v1/tenant/scim-token", status_code=201, tags=["tenant"])
async def create_scim_token(state: AppState = StateDep, principal: Principal = Admin) -> dict[str, Any]:
    """Create (or rotate) the tenant's SCIM token. Shown once; the previous token stops working."""
    token = f"scim_{principal.tenant_id}_{secrets.token_urlsafe(32)}"
    state.put_setting(
        principal.tenant_id,
        SETTING_KEY,
        {"token_hash": _sha256(token), "created_at": datetime.now(UTC).isoformat(), "created_by": principal.user_id},
    )
    state.audit.record(principal.tenant_id, principal.user_id, "tenant.scim_token.create")
    return {"token": token, "base_url": "/scim/v2"}


@router.get("/v1/tenant/scim-token", tags=["tenant"])
async def get_scim_token(state: AppState = StateDep, principal: Principal = Admin) -> dict[str, Any]:
    setting = state.get_setting(principal.tenant_id, SETTING_KEY) or {}
    return {"configured": bool(setting.get("token_hash")), "created_at": setting.get("created_at"), "created_by": setting.get("created_by")}


@router.delete("/v1/tenant/scim-token", status_code=204, tags=["tenant"])
async def delete_scim_token(state: AppState = StateDep, principal: Principal = Admin) -> None:
    if not (state.get_setting(principal.tenant_id, SETTING_KEY) or {}).get("token_hash"):
        raise HTTPException(status_code=404, detail="no SCIM token")
    state.put_setting(principal.tenant_id, SETTING_KEY, {})
    state.audit.record(principal.tenant_id, principal.user_id, "tenant.scim_token.revoke")
