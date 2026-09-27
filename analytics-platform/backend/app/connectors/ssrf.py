"""SSRF guard for tenant-configured connector hosts (ING-007, SEC).

Every host a connector connects to is resolved, and **every** resolved address
is checked:

* loopback, link-local (incl. cloud metadata endpoints), unspecified, multicast
  and reserved addresses are blocked unless the *platform* allowlist
  (``AP_CONNECTOR_HOST_ALLOWLIST``) permits them;
* private addresses (RFC 1918, CGNAT, IPv6 ULA) are blocked unless the tenant
  admin's allowlist (or the platform allowlist) permits them.

Callers connect to the checked IP (not the name again) where the driver allows
it, so DNS rebinding between check and connect is not possible.
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Iterable

_CGNAT = ipaddress.ip_network("100.64.0.0/10")
_METADATA = {ipaddress.ip_address("169.254.169.254"), ipaddress.ip_address("fd00:ec2::254"), ipaddress.ip_address("100.100.100.200")}


class BlockedHost(PermissionError):
    pass


def _matches(host: str, ip: ipaddress._BaseAddress, entries: Iterable[str]) -> bool:
    host = host.lower().rstrip(".")
    for raw in entries:
        entry = raw.strip().lower()
        if not entry:
            continue
        if "/" in entry or entry.replace(".", "").isdigit() or ":" in entry:
            try:
                if ip in ipaddress.ip_network(entry, strict=False):
                    return True
            except ValueError:
                continue
        elif entry.startswith("*."):
            if host.endswith(entry[1:]):
                return True
        elif host == entry:
            return True
    return False


def resolve(host: str, port: int | None = None) -> list[str]:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError) as exc:
        raise BlockedHost(f"could not resolve host {host!r}") from exc
    return sorted({info[4][0] for info in infos})


def check_host(
    host: str, port: int | None = None, *, tenant_allowlist: Iterable[str] = (), platform_allowlist: Iterable[str] = ()
) -> list[str]:
    """Resolve ``host`` and return its addresses, or raise BlockedHost."""
    if not host or len(host) > 253 or any(c in host for c in "/\\@ \t\r\n?#"):
        raise BlockedHost(f"invalid host {host!r}")
    tenant_allowlist, platform_allowlist = list(tenant_allowlist), list(platform_allowlist)
    addresses = resolve(host, port)
    if not addresses:
        raise BlockedHost(f"host {host!r} has no addresses")
    for addr in addresses:
        ip = ipaddress.ip_address(addr.split("%", 1)[0])
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        dangerous = ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast or ip.is_reserved or ip in _METADATA
        private = ip.is_private or ip in _CGNAT
        if dangerous:
            if not _matches(host, ip, platform_allowlist):
                raise BlockedHost(f"host {host!r} resolves to a loopback, link-local or reserved address ({ip})")
        elif private and not (_matches(host, ip, tenant_allowlist) or _matches(host, ip, platform_allowlist)):
            raise BlockedHost(f"host {host!r} resolves to a private address ({ip}); an admin must allowlist it")
    return addresses
