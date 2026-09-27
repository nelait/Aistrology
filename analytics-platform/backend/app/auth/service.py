"""Identity: signup, login, tokens, MFA, users and API keys (AUTH-001/002/006, MGT-001, MT-005)."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import jwt
import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from sqlalchemy import func, select

from ..cloud.base import SecretStore
from ..config import Settings
from ..db.models import ApiKey, Project, RefreshToken, Tenant, User
from ..db.session import Database
from ..storage.datasets import TENANT_ID_RE
from .rbac import Role

PLATFORM = "platform"  # reserved tenant ID for platform-level secrets
RESERVED_TENANTS = {PLATFORM, "admin", "api", "www", "system"}
JWT_ALG = "HS256"
ISSUER = "analytics-platform"
MAX_FAILED_LOGINS = 5
LOCKOUT = timedelta(minutes=15)
API_KEY_RE = re.compile(r"^ap_(live)_([0-9a-f]{12})_([A-Za-z0-9_-]{32,})$")

_hasher = PasswordHasher()


class AuthError(Exception):
    """401: bad credentials or token."""

    def __init__(self, message: str, code: str = "invalid_credentials"):
        self.code = code
        super().__init__(message)


class ConflictError(Exception):
    pass


@dataclass(frozen=True)
class Principal:
    tenant_id: str
    user_id: str  # user id or api key id
    role: str
    method: str  # jwt | api_key | dev
    scopes: list[str] = field(default_factory=list)
    email: str | None = None
    rate_limit_per_minute: int | None = None


@dataclass
class TokenPair:
    access_token: str
    refresh_token: str
    expires_in: int
    token_type: str = "bearer"


def validate_password(password: str) -> None:
    if len(password) < 12:
        raise ValueError("password must be at least 12 characters")
    if password.lower() == password or password.upper() == password or not re.search(r"\d", password):
        raise ValueError("password needs upper- and lower-case letters and a digit")


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class AuthService:
    def __init__(self, db: Database, secrets_store: SecretStore, settings: Settings):
        self.db = db
        self.secrets = secrets_store
        self.settings = settings
        self._signing_key: str | None = None

    # -- keys ------------------------------------------------------------
    def signing_key(self) -> str:
        if self._signing_key is None:
            key = self.secrets.get(PLATFORM, self.settings.jwt_secret_name)
            if key is None:
                key = secrets.token_urlsafe(64)
                self.secrets.put(PLATFORM, self.settings.jwt_secret_name, key)
            self._signing_key = key
        return self._signing_key

    # -- signup / users --------------------------------------------------
    def signup(self, *, tenant_id: str, org_name: str, email: str, password: str, name: str | None = None, region: str = "us") -> User:
        """MT-005: self-service sign-up creates the tenant, its first admin and a default project."""
        tenant_id = tenant_id.lower()
        if not TENANT_ID_RE.match(tenant_id) or tenant_id in RESERVED_TENANTS:
            raise ValueError("tenant id must be 3-63 lowercase letters, digits or dashes and not reserved")
        validate_password(password)
        with self.db.session() as s:
            if s.get(Tenant, tenant_id) is not None:
                raise ConflictError("that organization id is taken")
            if s.execute(select(User).where(func.lower(User.email) == email.lower())).scalar_one_or_none():
                raise ConflictError("an account with that email already exists")
            s.add(Tenant(id=tenant_id, name=org_name, region=region))
            s.flush()
            user = User(tenant_id=tenant_id, email=email.lower(), name=name, password_hash=_hasher.hash(password), role=Role.ADMIN.value)
            s.add(user)
            s.add(Project(tenant_id=tenant_id, name="Default", open=True))
        return user

    def create_user(self, tenant_id: str, *, email: str, role: Role, password: str, name: str | None = None) -> User:
        validate_password(password)
        with self.db.session(tenant_id) as s:
            if s.execute(select(User).where(func.lower(User.email) == email.lower())).scalar_one_or_none():
                raise ConflictError("an account with that email already exists")
            user = User(tenant_id=tenant_id, email=email.lower(), name=name, password_hash=_hasher.hash(password), role=role.value)
            s.add(user)
        return user

    # -- login / tokens --------------------------------------------------
    def login(self, email: str, password: str, totp_code: str | None = None) -> TokenPair:
        now = datetime.now(UTC)
        with self.db.session() as s:
            user = s.execute(select(User).where(func.lower(User.email) == email.lower())).scalar_one_or_none()
            if user is None:
                _hasher.hash(password)  # equalize timing for unknown emails
                raise AuthError("invalid email or password")
            tenant = s.get(Tenant, user.tenant_id)
            if user.locked_until and _aware(user.locked_until) > now:
                raise AuthError("account temporarily locked after repeated failures", "locked")
            try:
                _hasher.verify(user.password_hash, password)
            except (VerifyMismatchError, InvalidHashError):
                user.failed_logins += 1
                if user.failed_logins >= MAX_FAILED_LOGINS:
                    user.locked_until, user.failed_logins = now + LOCKOUT, 0
                s.commit()
                raise AuthError("invalid email or password") from None
            if user.disabled or tenant is None or tenant.status != "active":
                raise AuthError("account is disabled or the organization is suspended", "disabled")
            if user.mfa_enabled:
                if not totp_code:
                    raise AuthError("multi-factor code required", "mfa_required")
                if not self._verify_totp(user, totp_code):
                    raise AuthError("invalid multi-factor code", "mfa_invalid")
            elif tenant.require_mfa:
                raise AuthError("your organization requires MFA; enroll first", "mfa_enrollment_required")
            if _hasher.check_needs_rehash(user.password_hash):
                user.password_hash = _hasher.hash(password)
            user.failed_logins, user.locked_until, user.last_login_at = 0, None, now
            return self._issue(s, user)

    def _issue(self, s, user: User) -> TokenPair:
        now = datetime.now(UTC)
        ttl = self.settings.access_token_ttl_seconds
        access = jwt.encode(
            {
                "iss": ISSUER,
                "sub": user.id,
                "tid": user.tenant_id,
                "role": user.role,
                "email": user.email,
                "iat": int(now.timestamp()),
                "exp": int((now + timedelta(seconds=ttl)).timestamp()),
            },
            self.signing_key(),
            algorithm=JWT_ALG,
        )
        refresh = secrets.token_urlsafe(48)
        s.add(
            RefreshToken(
                tenant_id=user.tenant_id,
                user_id=user.id,
                token_hash=_sha256(refresh),
                expires_at=now + timedelta(seconds=self.settings.refresh_token_ttl_seconds),
            )
        )
        return TokenPair(access_token=access, refresh_token=refresh, expires_in=ttl)

    def refresh(self, refresh_token: str) -> TokenPair:
        """Rotate: the presented refresh token is revoked and a new pair issued. Reuse of a revoked token revokes all of the user's tokens."""
        with self.db.session() as s:
            row = s.execute(select(RefreshToken).where(RefreshToken.token_hash == _sha256(refresh_token))).scalar_one_or_none()
            if row is None:
                raise AuthError("invalid refresh token")
            if row.revoked:
                for t in s.execute(select(RefreshToken).where(RefreshToken.user_id == row.user_id)).scalars():
                    t.revoked = True
                s.commit()
                raise AuthError("refresh token reuse detected; all sessions revoked", "token_reuse")
            if _aware(row.expires_at) < datetime.now(UTC):
                raise AuthError("refresh token expired", "expired")
            user = s.get(User, row.user_id)
            tenant = s.get(Tenant, row.tenant_id)
            if user is None or user.disabled or tenant is None or tenant.status != "active":
                raise AuthError("account is disabled", "disabled")
            row.revoked = True
            return self._issue(s, user)

    def logout(self, refresh_token: str) -> None:
        with self.db.session() as s:
            row = s.execute(select(RefreshToken).where(RefreshToken.token_hash == _sha256(refresh_token))).scalar_one_or_none()
            if row:
                row.revoked = True

    def verify_access_token(self, token: str) -> Principal:
        try:
            claims = jwt.decode(
                token, self.signing_key(), algorithms=[JWT_ALG], issuer=ISSUER, options={"require": ["exp", "sub", "tid", "iss"]}
            )
        except jwt.ExpiredSignatureError as exc:
            raise AuthError("access token expired", "expired") from exc
        except jwt.PyJWTError as exc:
            raise AuthError("invalid access token", "invalid_token") from exc
        # Re-check account state so disabling a user or suspending a tenant takes effect immediately.
        with self.db.session(claims["tid"]) as s:
            user = s.get(User, claims["sub"])
            tenant = s.get(Tenant, claims["tid"])
            if user is None or user.disabled or tenant is None or tenant.status != "active" or user.tenant_id != claims["tid"]:
                raise AuthError("account is disabled", "disabled")
            role = user.role
        return Principal(tenant_id=claims["tid"], user_id=claims["sub"], role=role, method="jwt", email=claims.get("email"))

    # -- SSO (AUTH-001) ------------------------------------------------------
    def sso_login(self, email: str, provider: str, subject: str) -> TokenPair:
        """Log in a user authenticated by an OIDC provider.

        Existing users are matched by verified email. Unknown users are provisioned just-in-time
        only if some tenant has claimed the email's domain in its SSO settings.
        """
        from ..db.models import TenantSetting

        email = email.lower()
        domain = email.rsplit("@", 1)[-1]
        with self.db.session() as s:
            user = s.execute(select(User).where(func.lower(User.email) == email)).scalar_one_or_none()
            if user is None:
                for setting in s.execute(select(TenantSetting).where(TenantSetting.key == "sso")).scalars():
                    if domain in [d.lower() for d in setting.value.get("domains", [])]:
                        role = setting.value.get("default_role", Role.VIEWER.value)
                        user = User(tenant_id=setting.tenant_id, email=email, password_hash="!sso-only", role=role)
                        s.add(user)
                        s.flush()
                        break
            if user is None:
                raise AuthError("no account for this email; ask your admin to invite you", "sso_no_account")
            tenant = s.get(Tenant, user.tenant_id)
            if user.disabled or tenant is None or tenant.status != "active":
                raise AuthError("account is disabled or the organization is suspended", "disabled")
            user.last_login_at = datetime.now(UTC)
            return self._issue(s, user)

    # -- MFA (TOTP) --------------------------------------------------------
    def _mfa_secret_name(self, user_id: str) -> str:
        return f"mfa-{user_id}"

    def mfa_setup(self, principal: Principal) -> str:
        secret = pyotp.random_base32()
        self.secrets.put(principal.tenant_id, self._mfa_secret_name(principal.user_id) + "-pending", secret)
        return pyotp.TOTP(secret).provisioning_uri(name=principal.email or principal.user_id, issuer_name="Analytics Platform")

    def mfa_activate(self, principal: Principal, code: str) -> None:
        pending = self.secrets.get(principal.tenant_id, self._mfa_secret_name(principal.user_id) + "-pending")
        if not pending or not pyotp.TOTP(pending).verify(code, valid_window=1):
            raise AuthError("invalid multi-factor code", "mfa_invalid")
        self.secrets.put(principal.tenant_id, self._mfa_secret_name(principal.user_id), pending)
        self.secrets.delete(principal.tenant_id, self._mfa_secret_name(principal.user_id) + "-pending")
        with self.db.session(principal.tenant_id) as s:
            s.get(User, principal.user_id).mfa_enabled = True

    def _verify_totp(self, user: User, code: str) -> bool:
        secret = self.secrets.get(user.tenant_id, self._mfa_secret_name(user.id))
        return bool(secret) and pyotp.TOTP(secret).verify(code, valid_window=1)

    # -- API keys ----------------------------------------------------------
    def create_api_key(
        self,
        tenant_id: str,
        *,
        name: str,
        role: Role,
        created_by: str,
        scopes: list[str] | None = None,
        rate_limit_per_minute: int = 600,
        expires_in_days: int | None = None,
        allowed_ips: list[str] | None = None,
    ) -> tuple[ApiKey, str]:
        """MGT-001. The full key is returned once; only its SHA-256 is stored."""
        prefix = secrets.token_hex(6)
        secret = secrets.token_urlsafe(32)
        full = f"ap_live_{prefix}_{secret}"
        with self.db.session(tenant_id) as s:
            key = ApiKey(
                tenant_id=tenant_id,
                name=name,
                prefix=prefix,
                key_hash=_sha256(full),
                role=role.value,
                scopes=scopes or [],
                rate_limit_per_minute=rate_limit_per_minute,
                allowed_ips=allowed_ips or [],
                created_by=created_by,
                expires_at=datetime.now(UTC) + timedelta(days=expires_in_days) if expires_in_days else None,
            )
            s.add(key)
        return key, full

    def verify_api_key(self, presented: str, client_ip: str | None = None) -> Principal:
        match = API_KEY_RE.match(presented)
        if not match:
            raise AuthError("invalid API key", "invalid_api_key")
        with self.db.session() as s:
            key = s.execute(select(ApiKey).where(ApiKey.prefix == match.group(2))).scalar_one_or_none()
            if key is None or not hmac.compare_digest(key.key_hash, _sha256(presented)):
                raise AuthError("invalid API key", "invalid_api_key")
            if key.revoked_at is not None or (key.expires_at and _aware(key.expires_at) < datetime.now(UTC)):
                raise AuthError("API key revoked or expired", "invalid_api_key")
            if key.allowed_ips and client_ip not in key.allowed_ips:
                raise AuthError("API key not allowed from this IP address", "ip_denied")
            tenant = s.get(Tenant, key.tenant_id)
            if tenant is None or tenant.status != "active":
                raise AuthError("organization is suspended", "disabled")
            key.last_used_at = datetime.now(UTC)
            return Principal(
                tenant_id=key.tenant_id,
                user_id=key.id,
                role=key.role,
                method="api_key",
                scopes=list(key.scopes or []),
                rate_limit_per_minute=key.rate_limit_per_minute,
            )

    def rotate_api_key(self, tenant_id: str, key_id: str, actor: str) -> tuple[ApiKey, str]:
        with self.db.session(tenant_id) as s:
            old = s.get(ApiKey, key_id)
            if old is None or old.tenant_id != tenant_id:
                raise LookupError(key_id)
            old.revoked_at = datetime.now(UTC)
            params = dict(
                name=old.name,
                role=Role(old.role),
                scopes=list(old.scopes),
                rate_limit_per_minute=old.rate_limit_per_minute,
                allowed_ips=list(old.allowed_ips),
            )
        return self.create_api_key(tenant_id, created_by=actor, **params)


def _aware(ts: datetime) -> datetime:
    """SQLite drops tzinfo; treat naive timestamps as UTC."""
    return ts if ts.tzinfo else ts.replace(tzinfo=UTC)
