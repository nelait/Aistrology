"""OAuth 2.0 client-credentials grant (MGT-004a, RFC 6749 §4.4).

A tenant creates a client with a role and optional scopes (a narrowing of the role's permissions, exactly
like API-key scopes). The client exchanges ``client_id`` + ``client_secret`` at ``POST /oauth/token`` for a
short-lived JWT access token, which ``get_principal`` accepts as principal method ``oauth_client``.

* The secret is shown once; only its SHA-256 is stored (it is 256 bits of randomness, so a fast hash is fine).
* Tokens carry ``aud=oauth-client`` so they can never be confused with user access tokens.
* Every verification re-checks the client row, so revoking a client takes effect immediately.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

import jwt
from sqlalchemy import select

from ..db.models import OAuthClient, Tenant
from .rbac import Permission, Role
from .service import ISSUER, JWT_ALG, AuthError, Principal

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState

AUDIENCE = "oauth-client"
CLIENT_PREFIX = "apc_"
SECRET_PREFIX = "apcs_"


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def is_oauth_token(token: str) -> bool:
    """Cheap routing check (unverified): is this a client-credentials JWT? Verification happens in ``verify_token``."""
    try:
        return jwt.decode(token, options={"verify_signature": False}).get("aud") == AUDIENCE
    except jwt.PyJWTError:
        return False


class OAuthError(Exception):
    """An RFC 6749 §5.2 error: ``error`` is the OAuth error code."""

    def __init__(self, error: str, description: str, status: int = 400):
        self.error = error
        self.status = status
        super().__init__(description)


class OAuthService:
    def __init__(self, state: AppState):
        self.state = state

    def create_client(self, tenant_id: str, *, name: str, role: Role, scopes: list[str], created_by: str) -> tuple[OAuthClient, str]:
        client_id = CLIENT_PREFIX + secrets.token_hex(12)
        secret = SECRET_PREFIX + secrets.token_urlsafe(32)
        with self.state.db.session(tenant_id) as s:
            client = OAuthClient(
                tenant_id=tenant_id,
                client_id=client_id,
                secret_hash=_sha256(secret),
                name=name,
                role=role.value,
                scopes=scopes,
                created_by=created_by,
            )
            s.add(client)
            s.flush()
            s.expunge(client)
        return client, secret

    def issue_token(self, client_id: str, client_secret: str, requested_scope: str | None = None) -> dict:
        """Authenticate the client and return the token response body."""
        with self.state.db.session() as s:
            client = s.execute(select(OAuthClient).where(OAuthClient.client_id == client_id)).scalar_one_or_none()
            # Constant-time comparison; unknown clients compare against a dummy hash to equalize timing.
            expected = client.secret_hash if client else _sha256("unknown-client")
            if not hmac.compare_digest(expected, _sha256(client_secret)) or client is None or client.revoked_at is not None:
                raise OAuthError("invalid_client", "client authentication failed", 401)
            tenant = s.get(Tenant, client.tenant_id)
            if tenant is None or tenant.status != "active":
                raise OAuthError("invalid_client", "organization is suspended", 401)
            granted = list(client.scopes or [])
            if requested_scope:
                requested = requested_scope.split()
                valid = {p.value for p in Permission}
                allowed = set(granted) if granted else valid
                if not set(requested) <= allowed:
                    raise OAuthError("invalid_scope", "requested scope exceeds the client's scopes")
                granted = sorted(set(requested))
            client.last_used_at = datetime.now(UTC)
            tenant_id, row_id, role = client.tenant_id, client.id, client.role
        now = datetime.now(UTC)
        ttl = self.state.settings.oauth_token_ttl_seconds
        token = jwt.encode(
            {
                "iss": ISSUER,
                "aud": AUDIENCE,
                "sub": row_id,
                "tid": tenant_id,
                "cid": client_id,
                "role": role,
                "scope": " ".join(granted),
                "iat": int(now.timestamp()),
                "exp": int((now + timedelta(seconds=ttl)).timestamp()),
                "jti": secrets.token_hex(8),
            },
            self.state.auth.signing_key(),
            algorithm=JWT_ALG,
        )
        return {"access_token": token, "token_type": "bearer", "expires_in": ttl, "scope": " ".join(granted)}

    def verify_token(self, token: str) -> Principal:
        try:
            claims = jwt.decode(
                token,
                self.state.auth.signing_key(),
                algorithms=[JWT_ALG],
                audience=AUDIENCE,
                issuer=ISSUER,
                options={"require": ["exp", "sub", "tid", "iss", "aud"]},
            )
        except jwt.ExpiredSignatureError as exc:
            raise AuthError("access token expired", "expired") from exc
        except jwt.PyJWTError as exc:
            raise AuthError("invalid access token", "invalid_token") from exc
        with self.state.db.session(claims["tid"]) as s:
            client = s.get(OAuthClient, claims["sub"])
            tenant = s.get(Tenant, claims["tid"])
            if client is None or client.revoked_at is not None or client.tenant_id != claims["tid"]:
                raise AuthError("OAuth client revoked", "invalid_token")
            if tenant is None or tenant.status != "active":
                raise AuthError("organization is suspended", "disabled")
            role = client.role
        scopes = [s for s in str(claims.get("scope", "")).split() if s]
        return Principal(tenant_id=claims["tid"], user_id=claims["sub"], role=role, method="oauth_client", scopes=scopes)
