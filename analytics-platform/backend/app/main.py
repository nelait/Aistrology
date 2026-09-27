"""FastAPI application factory."""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .api import auth, dashboards, datasets, jobs, pipelines, projects, schemas, serving, tenant, training
from .api.connectors import router as connectors_router
from .api.dataset_extras import router as dataset_extras_router
from .api.deps import AppState, build_state
from .api.extensions import extension_routers
from .api.schema_history import router as schema_history_router
from .api.uploads import router as uploads_router
from .cors import CorsMiddleware
from .jobs import handlers  # noqa: F401 - registers job handlers
from .jobs.core import Worker
from .observability import JOBS, ObservabilityMiddleware, configure_logging, configure_tracing, metrics_response
from .quotas import QuotaExceededError
from .webhooks import WebhookDispatcher

log = logging.getLogger("app")


def create_app(state: AppState | None = None) -> FastAPI:
    app = FastAPI(
        title="Analytics Platform API",
        version="0.2.0",
        description="Schemas & sample data, ingestion, profiling, cleaning, analytics, model training, serving and dashboards.",
    )
    app.state.ap = state or build_state()
    app.state.ap.extras.setdefault("webhooks", WebhookDispatcher(app.state.ap))
    origins = [o.strip() for o in os.environ.get("AP_CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()]
    app.add_middleware(CorsMiddleware, state=app.state.ap, global_origins=origins)
    app.add_middleware(ObservabilityMiddleware)  # outermost: request ids, access logs, RED metrics
    if os.environ.get("AP_JSON_LOGS", "1") == "1":
        configure_logging()
    configure_tracing(app)
    app.state.ap.extras.setdefault("job_metrics", JOBS)
    app.include_router(uploads_router)  # before the dataset routes, so /v1/datasets/uploads/... never matches /{dataset_id}
    for module in (auth, tenant, projects, schemas, datasets, pipelines, jobs, training, serving, dashboards):
        app.include_router(module.router)
    for extension in extension_routers():  # Phase 2 platform features
        app.include_router(extension)
    for router in (schema_history_router, dataset_extras_router, connectors_router):  # Phase 2 data layer
        app.include_router(router)
    try:  # Phase 3: GraphQL (API-003)
        from .api.graphql import graphql_router

        app.include_router(graphql_router(dev=app.state.ap.settings.dev_auth))
    except ImportError:  # pragma: no cover - strawberry-graphql not installed
        log.warning("strawberry-graphql is not installed; /graphql is disabled")

    if app.state.ap.settings.inline_worker and "worker" not in app.state.ap.extras:
        # Local mode: run jobs in a background thread of the API process.
        from .jobs.scheduler import Scheduler

        tick = app.state.ap.settings.scheduler_tick_seconds
        worker = Worker(app.state.ap, wait_seconds=1.0, scheduler=Scheduler(app.state.ap) if tick > 0 else None, scheduler_interval=tick)
        worker.start()
        app.state.ap.extras["worker"] = worker

    @app.exception_handler(QuotaExceededError)
    async def _quota(request: Request, exc: QuotaExceededError) -> JSONResponse:
        return JSONResponse(
            {"detail": {"code": "quota_exceeded", "quota": exc.quota, "limit": exc.limit, "message": str(exc)}}, status_code=429
        )

    @app.get("/metrics", tags=["ops"], include_in_schema=False)
    async def metrics():
        """Prometheus scrape endpoint (OBS-003). Expose it only inside the cluster (NetworkPolicy / no ingress path)."""
        return metrics_response()

    @app.get("/readyz", tags=["ops"])
    async def readyz() -> JSONResponse:
        """Readiness: the metadata database answers."""
        from sqlalchemy import text

        try:
            with app.state.ap.db.session() as s:
                s.execute(text("SELECT 1"))
        except Exception as exc:  # noqa: BLE001
            return JSONResponse({"status": "unavailable", "error": type(exc).__name__}, status_code=503)
        return JSONResponse({"status": "ready"})

    @app.get("/healthz", tags=["ops"])
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "cloud": app.state.ap.cloud.provider}

    return app


def __getattr__(name: str):
    # ``uvicorn app.main:app`` builds the app lazily, so importing this module has no side effects.
    if name == "app":
        return create_app()
    raise AttributeError(name)
