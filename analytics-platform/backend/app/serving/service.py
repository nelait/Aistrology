"""Model serving: endpoints, traffic splitting, online and batch inference, request logging and drift monitoring
(API-*, MGT-005/006, API-011)."""

from __future__ import annotations

import logging
import random
import re
import time
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

import numpy as np
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import delete, select

from ..db.models import DriftCounter, Endpoint, ModelVersion, PredictionLog, PredictionSample, RegisteredModel
from ..privacy import redact_text
from ..training.drift_profile import PSI_ALERT, PSI_WARN, drift_report, prediction_token_value, token
from ..training.service import ModelBundle, NotFound, TrainingService

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState

ENDPOINT_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")
MAX_INSTANCES = 1000
# API-011 drift sample: a reservoir of at most DRIFT_SAMPLES_PER_DAY instances per endpoint and day, kept for
# DRIFT_RETENTION_DAYS. Only drift tokens (bins / known categories) are stored, never raw values or PII features.
DRIFT_SAMPLES_PER_DAY = 500
DRIFT_SAMPLES_PER_REQUEST = 100
DRIFT_RETENTION_DAYS = 30
DRIFT_MIN_SAMPLES = 30
log = logging.getLogger("app.serving")


class Route(BaseModel):
    model_version_id: str
    weight: int = Field(ge=0, le=100)


class EndpointCreate(BaseModel):
    name: str = Field(pattern=ENDPOINT_NAME_RE.pattern)
    model_id: str | None = None
    version: int | None = None
    routes: list[Route] | None = None
    min_replicas: int = Field(default=0, ge=0, le=100)
    log_payloads: bool = False
    cors_origins: list[str] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def _check(self) -> EndpointCreate:
        if not self.routes and not self.model_id:
            raise ValueError("give model_id (optionally version) or routes")
        return self


class EndpointPatch(BaseModel):
    routes: list[Route] | None = None
    min_replicas: int | None = Field(default=None, ge=0, le=100)
    log_payloads: bool | None = None
    cors_origins: list[str] | None = None
    status: str | None = Field(default=None, pattern="^(active|paused)$")


class EndpointOut(BaseModel):
    id: str
    name: str
    routes: list[dict[str, Any]]
    status: str
    min_replicas: int
    log_payloads: bool
    cors_origins: list[str]
    created_at: Any
    url: str


def _out(ep: Endpoint) -> EndpointOut:
    return EndpointOut(
        id=ep.id,
        name=ep.name,
        routes=list(ep.routes),
        status=ep.status,
        min_replicas=ep.min_replicas,
        log_payloads=ep.log_payloads,
        cors_origins=list(ep.cors_origins),
        created_at=ep.created_at,
        url=f"/v1/endpoints/{ep.name}/predict",
    )


class ServingError(ValueError):
    pass


class ServingService:
    def __init__(self, state: AppState):
        self.state = state
        self.training = TrainingService(state)

    # -- endpoint management ------------------------------------------------------------------
    def _resolve_routes(self, s, tenant_id: str, body: EndpointCreate | EndpointPatch) -> list[dict[str, Any]]:
        if body.routes:
            if sum(r.weight for r in body.routes) != 100:
                raise ServingError("route weights must add up to 100")
            routes = []
            for r in body.routes:
                mv = s.get(ModelVersion, r.model_version_id)
                if mv is None or mv.tenant_id != tenant_id:
                    raise NotFound(r.model_version_id)
                routes.append(
                    {"model_version_id": mv.id, "model_id": mv.model_id, "version": mv.version, "run_id": mv.run_id, "weight": r.weight}
                )
            return routes
        model = s.get(RegisteredModel, body.model_id)
        if model is None or model.tenant_id != tenant_id:
            raise NotFound(body.model_id)
        versions = s.execute(select(ModelVersion).where(ModelVersion.model_id == model.id).order_by(ModelVersion.version)).scalars().all()
        if not versions:
            raise ServingError("model has no versions")
        if body.version is not None:
            mv = next((v for v in versions if v.version == body.version), None)
            if mv is None:
                raise NotFound(f"version {body.version}")
        else:
            mv = next((v for v in versions if v.stage == "production"), versions[-1])
        return [{"model_version_id": mv.id, "model_id": mv.model_id, "version": mv.version, "run_id": mv.run_id, "weight": 100}]

    def create(self, tenant_id: str, actor: str, body: EndpointCreate) -> EndpointOut:
        with self.state.db.session(tenant_id) as s:
            if s.execute(select(Endpoint).where(Endpoint.tenant_id == tenant_id, Endpoint.name == body.name)).scalar_one_or_none():
                raise ServingError(f"endpoint {body.name!r} already exists")
            routes = self._resolve_routes(s, tenant_id, body)
            ep = Endpoint(
                tenant_id=tenant_id,
                name=body.name,
                routes=routes,
                min_replicas=body.min_replicas,
                log_payloads=body.log_payloads,
                cors_origins=body.cors_origins,
                created_by=actor,
            )
            s.add(ep)
            s.flush()
            out = _out(ep)
        # API-010: warm up (load and cache the models) so the first request is fast.
        for r in out.routes:
            self.training.load_bundle(tenant_id, r["run_id"])
        self.state.audit.record(
            tenant_id, actor, "endpoint.deploy", endpoint=body.name, routes=[(r["model_id"], r["version"], r["weight"]) for r in out.routes]
        )
        return out

    def _get(self, s, tenant_id: str, name: str) -> Endpoint:
        ep = s.execute(select(Endpoint).where(Endpoint.tenant_id == tenant_id, Endpoint.name == name)).scalar_one_or_none()
        if ep is None:
            raise NotFound(name)
        return ep

    def get(self, tenant_id: str, name: str) -> EndpointOut:
        with self.state.db.session(tenant_id) as s:
            return _out(self._get(s, tenant_id, name))

    def list(self, tenant_id: str) -> list[EndpointOut]:
        with self.state.db.session(tenant_id) as s:
            return [_out(e) for e in s.execute(select(Endpoint).where(Endpoint.tenant_id == tenant_id).order_by(Endpoint.name)).scalars()]

    def update(self, tenant_id: str, actor: str, name: str, body: EndpointPatch) -> EndpointOut:
        with self.state.db.session(tenant_id) as s:
            ep = self._get(s, tenant_id, name)
            if body.routes is not None:
                from .canary import CanaryConflict, CanaryService

                if CanaryService(self.state).running_for(tenant_id, ep.id):
                    raise CanaryConflict("a canary rollout is running; promote or abort it before changing routes")
                ep.routes = self._resolve_routes(s, tenant_id, body)
            for key in ("min_replicas", "log_payloads", "cors_origins", "status"):
                value = getattr(body, key)
                if value is not None:
                    setattr(ep, key, value)
            out = _out(ep)
        for r in out.routes:
            self.training.load_bundle(tenant_id, r["run_id"])
        self.state.audit.record(tenant_id, actor, "endpoint.update", endpoint=name, **body.model_dump(mode="json", exclude_none=True))
        return out

    def delete(self, tenant_id: str, actor: str, name: str) -> None:
        with self.state.db.session(tenant_id) as s:
            s.delete(self._get(s, tenant_id, name))
        self.state.audit.record(tenant_id, actor, "endpoint.delete", endpoint=name)

    # -- inference ------------------------------------------------------------------------------
    def _pick_route(self, routes: list[dict[str, Any]]) -> dict[str, Any]:
        live = [r for r in routes if r["weight"] > 0]
        return random.choices(live, weights=[r["weight"] for r in live], k=1)[0] if len(live) > 1 else live[0]

    def bundle_for(self, tenant_id: str, route: dict[str, Any]) -> ModelBundle:
        return self.training.load_bundle(tenant_id, route["run_id"])

    def predict(
        self,
        tenant_id: str,
        name: str,
        instances: list[dict[str, Any]] | None,
        *,
        explain: bool = False,
        caller: str = "",
        horizon: int | None = None,
        history: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Online inference. Forecasting endpoints (TRN-007) take ``horizon`` (and optional recent ``history``)."""
        instances = instances or []
        if len(instances) > MAX_INSTANCES:
            raise ServingError(f"at most {MAX_INSTANCES} instances per request; use the batch API for more")
        with self.state.db.session(tenant_id) as s:
            ep = self._get(s, tenant_id, name)
            if ep.status != "active":
                raise ServingError("endpoint is paused")
            routes, endpoint_id, log_payloads = list(ep.routes), ep.id, ep.log_payloads
        route = self._pick_route(routes)
        started = time.perf_counter()
        status = 200
        out: dict[str, Any] = {}
        bundle: ModelBundle | None = None
        try:
            bundle = self.bundle_for(tenant_id, route)
            if bundle.problem_type == "forecasting":
                if explain:
                    raise ServingError("explanations are not available for forecasting endpoints")
                first = instances[0] if instances else {}
                out = bundle.forecast(horizon or first.get("horizon"), history or first.get("history"))
            else:
                if not instances:
                    raise ServingError("instances must not be empty")
                if horizon is not None or history is not None:
                    raise ServingError("horizon and history apply to forecasting endpoints only")
                out = bundle.explain(instances) if explain else bundle.predict(instances)
            out["model_version"] = {"model_id": route["model_id"], "version": route["version"]}
            return out
        except ValueError:
            status = 422
            raise
        except Exception:
            status = 500
            raise
        finally:
            latency = (time.perf_counter() - started) * 1000
            with self.state.db.session(tenant_id) as s:
                s.add(
                    PredictionLog(
                        tenant_id=tenant_id,
                        endpoint_id=endpoint_id,
                        model_version_id=route["model_version_id"],
                        latency_ms=latency,
                        status=status,
                        # MGT-006: payload logging is opt-in and PII-redacted.
                        inputs={"instances": _redact(instances)} if log_payloads else None,
                        outputs={"predictions": out.get("predictions")} if log_payloads and out else None,
                    )
                )
            if status == 200 and bundle is not None and bundle.problem_type != "forecasting":
                self._sample(tenant_id, endpoint_id, route["model_version_id"], bundle, instances, out.get("predictions") or [])
            self.state.metering.add(tenant_id, "api.requests", name)
            self.state.metering.add(tenant_id, "api.predictions", name, max(1, len(instances)))

    # -- drift monitoring (API-011) ---------------------------------------------------------------------
    def _sample(
        self, tenant_id: str, endpoint_id: str, model_version_id: str, bundle: ModelBundle, instances: list[dict], predictions: list
    ) -> None:
        """Reservoir-sample tokenised inputs and predictions (Algorithm R, per endpoint and day). Best-effort."""
        try:
            reference = bundle.reference or {}
            features, pred_profile = reference.get("features") or {}, reference.get("prediction")
            if not features and not pred_profile:
                return
            rows = []
            for i, row in enumerate(instances[:DRIFT_SAMPLES_PER_REQUEST]):
                tokens = {f: token(profile, row.get(f)) for f, profile in features.items()}
                pred = token(pred_profile, prediction_token_value(predictions[i])) if pred_profile and i < len(predictions) else None
                rows.append((tokens, pred))
            now = datetime.now(UTC)
            day = now.strftime("%Y-%m-%d")
            with self.state.db.session(tenant_id) as s:
                counter = s.get(DriftCounter, (tenant_id, endpoint_id, day))
                if counter is None:
                    counter = DriftCounter(tenant_id=tenant_id, endpoint_id=endpoint_id, day=day, seen=0)
                    s.add(counter)
                    cutoff = (now - timedelta(days=DRIFT_RETENTION_DAYS)).strftime("%Y-%m-%d")
                    s.execute(delete(PredictionSample).where(PredictionSample.endpoint_id == endpoint_id, PredictionSample.day < cutoff))
                    s.execute(delete(DriftCounter).where(DriftCounter.endpoint_id == endpoint_id, DriftCounter.day < cutoff))
                for tokens, pred in rows:
                    counter.seen = (counter.seen or 0) + 1
                    if counter.seen <= DRIFT_SAMPLES_PER_DAY:
                        s.add(
                            PredictionSample(
                                tenant_id=tenant_id,
                                endpoint_id=endpoint_id,
                                day=day,
                                slot=counter.seen - 1,
                                model_version_id=model_version_id,
                                at=now,
                                features=tokens,
                                prediction=pred,
                            )
                        )
                        continue
                    slot = random.randrange(counter.seen)
                    if slot < DRIFT_SAMPLES_PER_DAY:
                        existing = s.execute(
                            select(PredictionSample).where(
                                PredictionSample.endpoint_id == endpoint_id, PredictionSample.day == day, PredictionSample.slot == slot
                            )
                        ).scalar_one_or_none()
                        if existing is not None:
                            existing.features, existing.prediction = tokens, pred
                            existing.model_version_id, existing.at = model_version_id, now
        except Exception as exc:  # noqa: BLE001 - drift sampling must never fail a prediction
            log.warning("drift sampling failed for endpoint %s: %s", endpoint_id, exc)

    def drift(self, tenant_id: str, name: str, hours: int = 24) -> dict[str, Any]:
        """API-011: per-feature PSI (input drift) and prediction PSI of recent traffic against the training reference."""
        since = datetime.now(UTC) - timedelta(hours=hours)
        with self.state.db.session(tenant_id) as s:
            ep = self._get(s, tenant_id, name)
            routes = list(ep.routes)
            samples = s.execute(
                select(PredictionSample.model_version_id, PredictionSample.features, PredictionSample.prediction).where(
                    PredictionSample.endpoint_id == ep.id, PredictionSample.at >= since
                )
            ).all()
            version_ids = {r[0] for r in samples} | {r["model_version_id"] for r in routes}
            versions = {mv.id: mv for mv in s.execute(select(ModelVersion).where(ModelVersion.id.in_(version_ids))).scalars()}
            info = {mv_id: (mv.version, mv.run_id, dict(mv.signature)) for mv_id, mv in versions.items()}
        base = {
            "endpoint": name,
            "window_hours": hours,
            "thresholds": {"warn": PSI_WARN, "alert": PSI_ALERT},
            "min_samples": DRIFT_MIN_SAMPLES,
            "samples": len(samples),
        }
        primary = max(routes, key=lambda r: r["weight"])
        if info.get(primary["model_version_id"], (None, None, {}))[2].get("problem_type") == "forecasting":
            return {**base, "status": "not_applicable", "features": [], "prediction": None, "by_version": {}}
        by_version: dict[str, Any] = {}
        grouped: dict[str, list[dict[str, Any]]] = {}
        for mv_id, feats, pred in samples:
            grouped.setdefault(mv_id, []).append({"features": feats or {}, "prediction": pred})
        for mv_id, rows in grouped.items():
            version, run_id, signature = info.get(mv_id, (None, None, {}))
            reference = signature.get("reference_profile")
            if reference is None and run_id:
                try:
                    reference = self.training.load_bundle(tenant_id, run_id).reference
                except NotFound:
                    reference = None
            if not reference:
                continue
            report = drift_report(reference, rows)
            if len(rows) < DRIFT_MIN_SAMPLES:
                report["status"] = "insufficient_data"
            by_version[str(version if version is not None else mv_id)] = {"model_version_id": mv_id, "samples": len(rows), **report}
        ranked = sorted(by_version.values(), key=lambda v: -v["samples"])
        top = ranked[0] if ranked else None
        statuses = [v["status"] for v in ranked if v["status"] != "insufficient_data"]
        status = (
            "alert"
            if "alert" in statuses
            else "warn"
            if "warn" in statuses
            else "ok"
            if statuses
            else "insufficient_data"
            if ranked
            else "no_data"
        )
        return {
            **base,
            "status": status,
            "model_version": top and {"model_version_id": top["model_version_id"], "samples": top["samples"]},
            "features": top["features"] if top else [],
            "prediction": top["prediction"] if top else None,
            "by_version": by_version,
        }

    def metrics(self, tenant_id: str, name: str, hours: int = 24) -> dict[str, Any]:
        """MGT-005: request count, error rate and latency percentiles, overall and per model version."""
        since = datetime.now(UTC) - timedelta(hours=hours)
        with self.state.db.session(tenant_id) as s:
            ep = self._get(s, tenant_id, name)
            rows = s.execute(
                select(PredictionLog.model_version_id, PredictionLog.latency_ms, PredictionLog.status).where(
                    PredictionLog.endpoint_id == ep.id, PredictionLog.at >= since
                )
            ).all()
            versions = {r["model_version_id"]: r["version"] for r in ep.routes}

        def summarize(items):
            lat = np.array([r[1] for r in items]) if items else np.array([0.0])
            return {
                "requests": len(items),
                "errors": sum(1 for r in items if r[2] >= 400),
                "p50_ms": round(float(np.percentile(lat, 50)), 3),
                "p95_ms": round(float(np.percentile(lat, 95)), 3),
                "p99_ms": round(float(np.percentile(lat, 99)), 3),
            }

        by_version = {}
        for mv_id in {r[0] for r in rows}:
            by_version[str(versions.get(mv_id, mv_id))] = summarize([r for r in rows if r[0] == mv_id])
        return {"window_hours": hours, **summarize(rows), "by_version": by_version}

    def openapi(self, tenant_id: str, name: str) -> dict[str, Any]:
        """API-007: an OpenAPI document generated from the served model's signature."""
        ep = self.get(tenant_id, name)
        bundle = self.bundle_for(tenant_id, ep.routes[0])
        if bundle.problem_type == "forecasting":
            return self._forecast_openapi(name, ep, bundle)
        props: dict[str, Any] = {}
        for f in bundle.signature["features"]:
            if f["group"] == "dropped":
                continue
            if f["group"] == "numeric":
                props[f["name"]] = {"type": "number", **({"example": f["min"]} if f.get("min") is not None else {})}
            elif f["group"] == "datetime":
                props[f["name"]] = {"type": "string", "format": "date-time"}
            else:
                props[f["name"]] = {
                    "type": "string",
                    **({"enum": f["categories"]} if f.get("categories") and len(f["categories"]) <= 50 else {}),
                }
        classes = bundle.signature.get("classes")
        prediction_schema = {"type": "string", "enum": [str(c) for c in classes]} if classes else {"type": "number"}
        if bundle.problem_type == "clustering":
            prediction_schema = {"type": "integer", "description": "cluster id (-1 = noise, DBSCAN only)"}
        elif bundle.problem_type == "anomaly":
            prediction_schema = {
                "type": "object",
                "description": "score: higher = more anomalous; is_anomaly = score above the model's threshold",
                "properties": {"is_anomaly": {"type": "boolean"}, "score": {"type": "number"}},
            }
        return {
            "openapi": "3.1.0",
            "info": {
                "title": f"Endpoint {name}",
                "version": str(ep.routes[0]["version"]),
                "description": f"Predicts {bundle.signature['target']} ({bundle.problem_type})."
                if bundle.signature.get("target")
                else "Flags anomalous rows (anomaly)."
                if bundle.problem_type == "anomaly"
                else f"Assigns rows to clusters ({bundle.problem_type}).",
            },
            "components": {
                "securitySchemes": {
                    "apiKey": {"type": "apiKey", "in": "header", "name": "X-API-Key"},
                    "bearer": {"type": "http", "scheme": "bearer"},
                },
                "schemas": {
                    "Instance": {"type": "object", "properties": props, "required": [k for k in props]},
                    "PredictRequest": {
                        "type": "object",
                        "required": ["instances"],
                        "properties": {
                            "instances": {"type": "array", "maxItems": MAX_INSTANCES, "items": {"$ref": "#/components/schemas/Instance"}},
                            "explain": {"type": "boolean", "default": False},
                        },
                    },
                    "PredictResponse": {
                        "type": "object",
                        "properties": {
                            "predictions": {"type": "array", "items": prediction_schema},
                            **(
                                {
                                    "probabilities": {"type": "array", "items": {"type": "array", "items": {"type": "number"}}},
                                    "classes": {"type": "array"},
                                }
                                if classes
                                else {}
                            ),
                            "model_version": {"type": "object"},
                        },
                    },
                },
            },
            "security": [{"apiKey": []}, {"bearer": []}],
            "paths": {
                f"/v1/endpoints/{name}/predict": {
                    "post": {
                        "summary": f"Predict {bundle.signature['target'] or ('anomalies' if bundle.problem_type == 'anomaly' else 'cluster')}",
                        "requestBody": {
                            "required": True,
                            "content": {"application/json": {"schema": {"$ref": "#/components/schemas/PredictRequest"}}},
                        },
                        "responses": {
                            "200": {
                                "description": "Predictions",
                                "content": {"application/json": {"schema": {"$ref": "#/components/schemas/PredictResponse"}}},
                            },
                            "401": {"description": "Missing or invalid credentials"},
                            "422": {"description": "Invalid instances"},
                            "429": {"description": "Rate limit exceeded"},
                        },
                    }
                }
            },
        }

    def _forecast_openapi(self, name: str, ep: EndpointOut, bundle: ModelBundle) -> dict[str, Any]:
        """API-007 for forecasting endpoints: ``{horizon, history?}`` in, timestamps + forecasts + intervals out."""
        sig = bundle.signature
        numbers = {"type": "array", "items": {"type": "number"}}
        return {
            "openapi": "3.1.0",
            "info": {
                "title": f"Endpoint {name}",
                "version": str(ep.routes[0]["version"]),
                "description": f"Forecasts {sig['target']} ({sig.get('frequency')} periods).",
            },
            "components": {
                "securitySchemes": {
                    "apiKey": {"type": "apiKey", "in": "header", "name": "X-API-Key"},
                    "bearer": {"type": "http", "scheme": "bearer"},
                },
                "schemas": {
                    "ForecastRequest": {
                        "type": "object",
                        "properties": {
                            "horizon": {"type": "integer", "minimum": 1, "maximum": 1000, "default": sig.get("horizon")},
                            "history": {
                                "type": "array",
                                "description": "Optional recent observations; the model is refit with them.",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        sig["time_column"]: {"type": "string", "format": "date-time"},
                                        sig["target"]: {"type": "number"},
                                    },
                                },
                            },
                        },
                    },
                    "ForecastResponse": {
                        "type": "object",
                        "properties": {
                            "horizon": {"type": "integer"},
                            "timestamps": {"type": "array", "items": {"type": "string", "format": "date-time"}},
                            "predictions": numbers,
                            "lower": numbers,
                            "upper": numbers,
                            "interval_level": {"type": "number"},
                            "model_version": {"type": "object"},
                        },
                    },
                },
            },
            "security": [{"apiKey": []}, {"bearer": []}],
            "paths": {
                f"/v1/endpoints/{name}/predict": {
                    "post": {
                        "summary": f"Forecast {sig['target']}",
                        "requestBody": {
                            "required": True,
                            "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ForecastRequest"}}},
                        },
                        "responses": {
                            "200": {
                                "description": "Forecast",
                                "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ForecastResponse"}}},
                            },
                            "401": {"description": "Missing or invalid credentials"},
                            "422": {"description": "Invalid request"},
                            "429": {"description": "Rate limit exceeded"},
                        },
                    }
                }
            },
        }


def _redact(instances: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{k: redact_text(v) if isinstance(v, str) else v for k, v in row.items()} for row in instances[:100]]
