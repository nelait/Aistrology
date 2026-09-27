"""Tenant-level IP allowlist / denylist (MGT-007).

Stored as the tenant setting ``network``: ``{"allow": [CIDR...], "deny": [CIDR...]}``.

* A deny match always rejects.
* A non-empty allowlist rejects every address that matches none of its entries (and unknown addresses).
* An empty policy allows everything (the default).

It applies to every tenant principal (users, API keys, OAuth clients); per-key allowlists (MGT-001) still
apply on top. Policies are cached per process for a few seconds and invalidated on write.
"""

from __future__ import annotations

import ipaddress
import threading
import time
from typing import TYPE_CHECKING

from pydantic import BaseModel, Field, field_validator

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState

SETTING_KEY = "network"
CACHE_SECONDS = 5.0
_lock = threading.Lock()


class NetworkPolicy(BaseModel):
    allow: list[str] = Field(default_factory=list, max_length=200)
    deny: list[str] = Field(default_factory=list, max_length=200)

    @field_validator("allow", "deny")
    @classmethod
    def _cidrs(cls, values: list[str]) -> list[str]:
        out = []
        for v in values:
            try:
                out.append(str(ipaddress.ip_network(v.strip(), strict=False)))
            except ValueError as exc:
                raise ValueError(f"not an IP address or CIDR range: {v!r}") from exc
        return sorted(set(out))

    def allows(self, ip: str | None) -> bool:
        try:
            addr = ipaddress.ip_address(ip) if ip else None
        except ValueError:
            addr = None
        if addr is not None and any(addr in ipaddress.ip_network(c) for c in self.deny):
            return False
        if not self.allow:
            return True
        return addr is not None and any(addr in ipaddress.ip_network(c) for c in self.allow)


def _cache(state: AppState) -> dict[str, tuple[float, NetworkPolicy]]:
    with _lock:
        return state.extras.setdefault("network_policies", {})


def get_policy(state: AppState, tenant_id: str) -> NetworkPolicy:
    cache = _cache(state)
    hit = cache.get(tenant_id)
    now = time.monotonic()
    if hit and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    policy = NetworkPolicy.model_validate(state.get_setting(tenant_id, SETTING_KEY) or {})
    cache[tenant_id] = (now, policy)
    return policy


def set_policy(state: AppState, tenant_id: str, policy: NetworkPolicy) -> None:
    state.put_setting(tenant_id, SETTING_KEY, policy.model_dump())
    _cache(state).pop(tenant_id, None)


def network_allows(state: AppState, tenant_id: str, ip: str | None) -> bool:
    return get_policy(state, tenant_id).allows(ip)
