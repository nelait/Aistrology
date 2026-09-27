"""Phase 2 platform routers (LPA-006/008, NTF-002/003, MGT-004a/007, SHR-001a, AUTH-001a/004, SEC-003, OBS-004, WHK-002)
and Phase 3 scheduling & collaboration routers (USR-007, SHR-004/005, LLM-008/009, ING-008).

Kept in one list so ``main.py`` only needs a single include loop.
"""

from __future__ import annotations

from fastapi import APIRouter

from . import access, analytics_p3, comments, governance, inbound, llm_admin, notify, schedules, scim, sharing, streams


def extension_routers() -> list[APIRouter]:
    return [
        llm_admin.router,
        notify.router,
        access.router,
        scim.router,
        sharing.router,
        governance.router,
        inbound.router,
        # Phase 3
        schedules.router,
        comments.router,
        analytics_p3.router,
        streams.router,
    ]
