"""Observability (OBS-001 … OBS-003): structured JSON logs, request IDs, Prometheus metrics, OpenTelemetry traces.

* Every request gets an ``X-Request-ID`` (a caller-supplied ID is kept if it is safe) and one
  JSON access-log line with tenant, principal, route, status and latency, but no bodies
  and no query strings (which can carry PII).
* ``/metrics`` exposes RED metrics per route template: requests, errors, latency histogram.
* When ``OTEL_EXPORTER_OTLP_ENDPOINT`` is set, FastAPI requests are traced and exported over OTLP/HTTP.
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
import re
import sys
import time
import uuid
from datetime import UTC, datetime

from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Counter, Gauge, Histogram, generate_latest
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from .privacy import redact_text

request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{8,64}$")

REGISTRY = CollectorRegistry()
REQUESTS = Counter("ap_http_requests_total", "HTTP requests", ["method", "route", "status"], registry=REGISTRY)
LATENCY = Histogram(
    "ap_http_request_duration_seconds",
    "HTTP request latency",
    ["method", "route"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30),
    registry=REGISTRY,
)
IN_FLIGHT = Gauge("ap_http_requests_in_flight", "Requests being served", registry=REGISTRY)
JOBS = Counter("ap_jobs_total", "Finished jobs", ["type", "status"], registry=REGISTRY)
LLM_TOKENS = Counter("ap_llm_tokens_total", "LLM tokens", ["provider", "direction"], registry=REGISTRY)


class JsonFormatter(logging.Formatter):
    """One JSON object per line; messages pass through PII redaction (OBS-001)."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": redact_text(record.getMessage()),
            "request_id": request_id_var.get(),
        }
        for key in ("tenant_id", "principal", "method", "route", "status", "duration_ms", "job_id"):
            if hasattr(record, key):
                payload[key] = getattr(record, key)
        if record.exc_info:
            payload["exc"] = redact_text(self.formatException(record.exc_info))[-4000:]
        return json.dumps(payload, default=str)


def configure_logging(level: str | None = None) -> None:
    root = logging.getLogger()
    if any(isinstance(h.formatter, JsonFormatter) for h in root.handlers):
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root.handlers = [handler]
    root.setLevel(level or os.environ.get("AP_LOG_LEVEL", "INFO"))
    for noisy in ("uvicorn.access",):  # replaced by our access log
        logging.getLogger(noisy).disabled = True


access_log = logging.getLogger("app.access")


def _route_template(request: Request) -> str:
    route = request.scope.get("route")
    return getattr(route, "path", None) or "unmatched"


class ObservabilityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        incoming = request.headers.get("x-request-id", "")
        rid = incoming if REQUEST_ID_RE.match(incoming) else uuid.uuid4().hex
        token = request_id_var.set(rid)
        started = time.perf_counter()
        IN_FLIGHT.inc()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers["X-Request-ID"] = rid
            return response
        finally:
            IN_FLIGHT.dec()
            elapsed = time.perf_counter() - started
            route = _route_template(request)
            if route != "/metrics":
                REQUESTS.labels(request.method, route, str(status)).inc()
                LATENCY.labels(request.method, route).observe(elapsed)
                principal = getattr(request.state, "principal", None)
                access_log.info(
                    "%s %s %s",
                    request.method,
                    route,
                    status,
                    extra={
                        "tenant_id": getattr(principal, "tenant_id", None),
                        "principal": getattr(principal, "user_id", None),
                        "method": request.method,
                        "route": route,
                        "status": status,
                        "duration_ms": round(elapsed * 1000, 2),
                    },
                )
            request_id_var.reset(token)


def metrics_response() -> Response:
    return Response(generate_latest(REGISTRY), media_type=CONTENT_TYPE_LATEST)


def configure_tracing(app) -> bool:
    """OBS-002: OpenTelemetry tracing, enabled when an OTLP endpoint is configured."""
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        return False
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(resource=Resource.create({"service.name": os.environ.get("OTEL_SERVICE_NAME", "analytics-platform-api")}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    # Don't record query strings or headers on spans; they can carry PII or credentials.
    FastAPIInstrumentor.instrument_app(app, tracer_provider=provider, excluded_urls="healthz,metrics")
    return True
