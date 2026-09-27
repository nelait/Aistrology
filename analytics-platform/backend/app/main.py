"""FastAPI application factory."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI

from .api import datasets, schemas, tenant
from .api.deps import AppState
from .storage.datasets import DatasetStore


def create_app(data_dir: Path | None = None, *, state: AppState | None = None) -> FastAPI:
    app = FastAPI(
        title="Analytics Platform API",
        version="0.1.0",
        description="Schema & sample data, ingestion, profiling, sandboxed SQL and LLM-assisted analytics.",
    )
    app.state.ap = state or AppState(store=DatasetStore(data_dir))
    app.include_router(schemas.router)
    app.include_router(datasets.router)
    app.include_router(tenant.router)

    @app.get("/healthz", tags=["ops"])
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
