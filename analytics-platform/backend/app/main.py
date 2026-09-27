"""FastAPI application factory."""

from __future__ import annotations

import logging

from fastapi import FastAPI

from .api import auth, datasets, schemas, tenant
from .api.deps import AppState, build_state

log = logging.getLogger("app")


def create_app(state: AppState | None = None) -> FastAPI:
    app = FastAPI(
        title="Analytics Platform API",
        version="0.2.0",
        description="Schemas & sample data, ingestion, profiling, cleaning, analytics, model training, serving and dashboards.",
    )
    app.state.ap = state or build_state()
    for module in (auth, tenant, schemas, datasets):
        app.include_router(module.router)

    @app.get("/healthz", tags=["ops"])
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "cloud": app.state.ap.cloud.provider}

    return app


def __getattr__(name: str):
    # ``uvicorn app.main:app`` builds the app lazily, so importing this module has no side effects.
    if name == "app":
        return create_app()
    raise AttributeError(name)
