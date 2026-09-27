"""Phase 2 platform routers (LPA-006/008, NTF-002/003, MGT-004a/007, SHR-001a, AUTH-001a/004, SEC-003, OBS-004, WHK-002).

Kept in one list so ``main.py`` only needs a single include loop.
"""

from __future__ import annotations

from fastapi import APIRouter

from . import access, governance, inbound, llm_admin, notify, scim, sharing


def extension_routers() -> list[APIRouter]:
    return [llm_admin.router, notify.router, access.router, scim.router, sharing.router, governance.router, inbound.router]
