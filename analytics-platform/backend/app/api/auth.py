"""Authentication endpoints (AUTH-001, AUTH-006, MT-005)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr, Field

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
