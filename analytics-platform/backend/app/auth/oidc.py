"""OIDC single sign-on (AUTH-001): Google and Microsoft, plus any standards-compliant issuer.

Authorization-code flow with PKCE. The ``state`` parameter is a short-lived JWT
signed by the platform (it carries the PKCE verifier, nonce and redirect URI),
so no server-side session storage is needed. ID tokens are verified against the
issuer's JWKS: signature, issuer, audience, expiry, nonce and email_verified.
"""

from __future__ import annotations

import base64
import hashlib
import os
import re
import secrets
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt

KNOWN_ISSUERS = {
    "google": "https://accounts.google.com",
    "microsoft": "https://login.microsoftonline.com/common/v2.0",
}
MS_ISSUER_RE = re.compile(r"^https://login\.microsoftonline\.com/[0-9a-f-]{36}/v2\.0$")
STATE_TTL = 600


class OIDCError(Exception):
    pass


@dataclass
class OIDCProviderConfig:
    name: str
    issuer: str
    client_id: str
    client_secret: str
    scopes: str = "openid email profile"


def providers_from_env() -> dict[str, OIDCProviderConfig]:
    """``AP_OIDC_<NAME>_CLIENT_ID`` / ``_CLIENT_SECRET`` (/ ``_ISSUER`` for custom issuers)."""
    out: dict[str, OIDCProviderConfig] = {}
    names = set(KNOWN_ISSUERS) | {m.group(1).lower() for k in os.environ if (m := re.match(r"AP_OIDC_([A-Z0-9]+)_CLIENT_ID$", k))}
    for name in names:
        client_id = os.environ.get(f"AP_OIDC_{name.upper()}_CLIENT_ID")
        client_secret = os.environ.get(f"AP_OIDC_{name.upper()}_CLIENT_SECRET")
        issuer = os.environ.get(f"AP_OIDC_{name.upper()}_ISSUER") or KNOWN_ISSUERS.get(name)
        if client_id and client_secret and issuer:
            out[name] = OIDCProviderConfig(name, issuer.rstrip("/"), client_id, client_secret)
    return out


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class OIDCClient:
    def __init__(self, config: OIDCProviderConfig, signing_key: str, *, http: httpx.Client | None = None):
        self.config = config
        self.signing_key = signing_key
        self.http = http or httpx.Client(timeout=10.0)
        self._discovery: dict[str, Any] | None = None
        self._jwks: dict[str, Any] | None = None

    def discovery(self) -> dict[str, Any]:
        if self._discovery is None:
            response = self.http.get(f"{self.config.issuer}/.well-known/openid-configuration")
            if response.status_code != 200:
                raise OIDCError(f"discovery failed for {self.config.name}: HTTP {response.status_code}")
            self._discovery = response.json()
        return self._discovery

    def authorization_url(self, redirect_uri: str) -> tuple[str, str]:
        verifier = secrets.token_urlsafe(48)
        nonce = secrets.token_urlsafe(16)
        now = int(time.time())
        state = jwt.encode(
            {"aud": "oidc-state", "p": self.config.name, "v": verifier, "n": nonce, "r": redirect_uri, "iat": now, "exp": now + STATE_TTL},
            self.signing_key,
            algorithm="HS256",
        )
        params = {
            "response_type": "code",
            "client_id": self.config.client_id,
            "redirect_uri": redirect_uri,
            "scope": self.config.scopes,
            "state": state,
            "nonce": nonce,
            "code_challenge": _b64url(hashlib.sha256(verifier.encode()).digest()),
            "code_challenge_method": "S256",
            "prompt": "select_account",
        }
        return f"{self.discovery()['authorization_endpoint']}?{urlencode(params)}", state

    def _state(self, state: str) -> dict[str, Any]:
        try:
            claims = jwt.decode(state, self.signing_key, algorithms=["HS256"], audience="oidc-state")
        except jwt.PyJWTError as exc:
            raise OIDCError("invalid or expired state") from exc
        if claims.get("p") != self.config.name:
            raise OIDCError("state was issued for another provider")
        return claims

    def _jwk(self, kid: str | None) -> jwt.PyJWK:
        for attempt in range(2):
            if self._jwks is None or attempt == 1:  # refetch once on unknown kid (key rotation)
                response = self.http.get(self.discovery()["jwks_uri"])
                if response.status_code != 200:
                    raise OIDCError("could not fetch the issuer's signing keys")
                self._jwks = response.json()
            for key in self._jwks.get("keys", []):
                if kid is None or key.get("kid") == kid:
                    return jwt.PyJWK(key)
        raise OIDCError("no matching signing key")

    def exchange(self, code: str, state: str) -> dict[str, Any]:
        """Exchange the code and return verified ID-token claims."""
        st = self._state(state)
        response = self.http.post(
            self.discovery()["token_endpoint"],
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": st["r"],
                "client_id": self.config.client_id,
                "client_secret": self.config.client_secret,
                "code_verifier": st["v"],
            },
            headers={"Accept": "application/json"},
        )
        if response.status_code != 200:
            raise OIDCError(f"token exchange failed: HTTP {response.status_code}")
        id_token = response.json().get("id_token")
        if not id_token:
            raise OIDCError("no id_token in the token response")
        header = jwt.get_unverified_header(id_token)
        if header.get("alg") not in ("RS256", "ES256", "PS256"):
            raise OIDCError(f"unexpected id_token algorithm {header.get('alg')}")
        key = self._jwk(header.get("kid"))
        try:
            claims = jwt.decode(
                id_token,
                key=key.key,
                algorithms=[header["alg"]],
                audience=self.config.client_id,
                options={"require": ["exp", "iat", "iss", "aud", "sub"], "verify_iss": False},
                leeway=60,
            )
        except jwt.PyJWTError as exc:
            raise OIDCError(f"invalid id_token: {exc}") from exc
        issuer = claims["iss"].rstrip("/")
        expected = self.discovery().get("issuer", self.config.issuer).rstrip("/")
        multi_tenant_ms = expected.endswith("/common/v2.0") or "{tenantid}" in expected
        if not (issuer == expected or (multi_tenant_ms and MS_ISSUER_RE.match(issuer))):
            raise OIDCError("id_token issuer mismatch")
        if claims.get("nonce") != st["n"]:
            raise OIDCError("id_token nonce mismatch")
        email = claims.get("email") or claims.get("preferred_username")
        if not email or "@" not in email:
            raise OIDCError("the identity provider did not return an email address")
        # Google sets email_verified; Microsoft work accounts don't, but their emails are tenant-managed.
        if claims.get("email_verified") is False:
            raise OIDCError("email address is not verified with the identity provider")
        return {**claims, "email": email.lower()}
