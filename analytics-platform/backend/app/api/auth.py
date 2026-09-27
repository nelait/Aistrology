"""Authentication endpoints (AUTH-001, AUTH-006, MT-005)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr, Field

from ..auth.oidc import OIDCClient, OIDCError, providers_from_env
from ..auth.service import AuthError, ConflictError, Principal
from ..db.models import User
from .deps import AppState, PrincipalDep, StateDep

router = APIRouter(prefix="/v1/auth", tags=["auth"])


class SignupRequest(BaseModel):
    tenant_id: str = Field(min_length=3, max_length=63, description="Organization slug, e.g. 'acme'")
    org_name: str = Field(min_length=1, max_length=200)
    email: EmailStr
    password: str = Field(min_length=12, max_length=256)
    name: str | None = Field(default=None, max_length=200)
    region: str = Field(default="us", pattern="^(us|eu)$")


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(max_length=256)
    totp: str | None = Field(default=None, max_length=10)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(max_length=200)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int
    token_type: str = "bearer"


class MfaCode(BaseModel):
    code: str = Field(min_length=6, max_length=10)


def _auth_error(exc: AuthError) -> HTTPException:
    return HTTPException(status_code=401, detail={"code": exc.code, "message": str(exc)})


@router.post("/signup", status_code=201)
async def signup(body: SignupRequest, state: AppState = StateDep) -> dict:
    try:
        user = state.auth.signup(
            tenant_id=body.tenant_id, org_name=body.org_name, email=body.email, password=body.password, name=body.name, region=body.region
        )
    except ConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    state.audit.record(user.tenant_id, user.id, "tenant.signup", email=user.email, region=body.region)
    return {"tenant_id": user.tenant_id, "user_id": user.id}


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, state: AppState = StateDep) -> TokenResponse:
    try:
        pair = state.auth.login(body.email, body.password, body.totp)
    except AuthError as exc:
        # SOC-SEC-009: failed authentications are audited (platform scope; the email may not exist).
        state.audit.record("platform", body.email, "auth.login_failed", code=exc.code)
        raise _auth_error(exc) from exc
    return TokenResponse(**pair.__dict__)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(body: RefreshRequest, state: AppState = StateDep) -> TokenResponse:
    try:
        return TokenResponse(**state.auth.refresh(body.refresh_token).__dict__)
    except AuthError as exc:
        raise _auth_error(exc) from exc


@router.post("/logout", status_code=204)
async def logout(body: RefreshRequest, state: AppState = StateDep) -> None:
    state.auth.logout(body.refresh_token)


@router.get("/me")
async def me(principal: Principal = PrincipalDep, state: AppState = StateDep) -> dict:
    out = {"tenant_id": principal.tenant_id, "id": principal.user_id, "role": principal.role, "method": principal.method}
    if principal.method == "jwt":
        with state.db.session(principal.tenant_id) as s:
            user = s.get(User, principal.user_id)
            out.update(email=user.email, name=user.name, mfa_enabled=user.mfa_enabled)
    return out


@router.post("/mfa/setup")
async def mfa_setup(principal: Principal = PrincipalDep, state: AppState = StateDep) -> dict:
    if principal.method != "jwt":
        raise HTTPException(status_code=400, detail="MFA enrollment requires a user session")
    return {"otpauth_uri": state.auth.mfa_setup(principal)}


@router.post("/mfa/activate", status_code=204)
async def mfa_activate(body: MfaCode, principal: Principal = PrincipalDep, state: AppState = StateDep) -> None:
    try:
        state.auth.mfa_activate(principal, body.code)
    except AuthError as exc:
        raise _auth_error(exc) from exc
    state.audit.record(principal.tenant_id, principal.user_id, "auth.mfa_enabled")


# -- OIDC single sign-on (AUTH-001) ------------------------------------------------------------------


class OIDCCallback(BaseModel):
    code: str = Field(max_length=4096)
    state: str = Field(max_length=4096)


def _oidc_clients(state: AppState) -> dict[str, OIDCClient]:
    if "oidc" not in state.extras:
        state.extras["oidc"] = {name: OIDCClient(cfg, state.auth.signing_key()) for name, cfg in providers_from_env().items()}
    return state.extras["oidc"]


def _allowed_redirects() -> set[str]:
    import os

    return {u.strip() for u in os.environ.get("AP_OIDC_REDIRECT_URIS", "http://localhost:3000/auth/callback").split(",") if u.strip()}


@router.get("/oidc/providers")
async def oidc_providers(state: AppState = StateDep) -> dict[str, list[str]]:
    return {"providers": sorted(_oidc_clients(state))}


@router.get("/oidc/{provider}/authorize")
async def oidc_authorize(provider: str, redirect_uri: str, state: AppState = StateDep) -> dict[str, str]:
    client = _oidc_clients(state).get(provider)
    if client is None:
        raise HTTPException(status_code=404, detail="unknown identity provider")
    if redirect_uri not in _allowed_redirects():
        raise HTTPException(status_code=400, detail="redirect_uri is not allowed")
    try:
        url, st = client.authorization_url(redirect_uri)
    except OIDCError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"authorization_url": url, "state": st}


@router.post("/oidc/{provider}/callback", response_model=TokenResponse)
async def oidc_callback(provider: str, body: OIDCCallback, state: AppState = StateDep) -> TokenResponse:
    client = _oidc_clients(state).get(provider)
    if client is None:
        raise HTTPException(status_code=404, detail="unknown identity provider")
    try:
        claims = client.exchange(body.code, body.state)
        pair = state.auth.sso_login(claims["email"], provider, claims["sub"])
    except OIDCError as exc:
        state.audit.record("platform", provider, "auth.sso_failed", reason=str(exc))
        raise HTTPException(status_code=401, detail={"code": "sso_failed", "message": str(exc)}) from exc
    except AuthError as exc:
        state.audit.record("platform", claims.get("email", provider), "auth.sso_failed", code=exc.code)
        raise _auth_error(exc) from exc
    return TokenResponse(**pair.__dict__)
