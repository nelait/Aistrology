"""Canary rollouts (API-009).

``start`` routes ``steps[0]`` % of an endpoint's traffic to a new model version (the rest keeps the baseline split,
scaled down). A ``serving.canary_step`` job evaluates each step from the prediction logs written since the step began:

* canary error rate (HTTP status ≥ 400) above ``max_error_rate`` → **roll back** (baseline routes restored);
* canary p95 latency more than ``max_p95_ms_increase`` ms above the baseline's → **roll back**;
* fewer than ``min_requests`` canary requests → **hold** (evaluate again after another step);
* otherwise → **ramp** to the next step, or **complete** at 100 % (the candidate takes all traffic).

Rollbacks emit an ``endpoint.threshold`` notification + webhook (``kind: "canary"``) and are audited, as are
manual ``promote`` / ``abort``.

Scheduling: the codebase has no job scheduler, so each step job **re-enqueues itself** with a delay. The delay is
carried as ``not_before`` in the job params and the rollout's ``next_eval_at`` (durable in the database); the
re-enqueue happens through ``state.extras["canary_scheduler"]`` when set (tests inject one) or an in-process timer
thread. Since in-process timers don't survive a restart, ``POST /v1/endpoints/canary-steps`` evaluates every due
rollout; point a scheduler (cron / Cloud Scheduler) at it every minute in production, like drift checks. A job that
runs before ``next_eval_at`` is dropped (the pending follow-up stays), so duplicate triggers are harmless.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

import numpy as np
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from ..db.models import CanaryRollout, Endpoint, ModelVersion, PredictionLog
from ..training.service import NotFound

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState

log = logging.getLogger("app.serving.canary")
HOLD_MIN_SECONDS = 60.0
JOB_TYPE = "serving.canary_step"


class CanaryError(ValueError):
    pass


class CanaryConflict(CanaryError):
    pass


class CanaryStart(BaseModel):
    model_version_id: str
    steps: list[int] = Field(default_factory=lambda: [5, 25, 50, 100], min_length=1, max_length=20)
    step_minutes: float = Field(default=10.0, ge=0.0, le=7 * 24 * 60)
    max_error_rate: float = Field(default=0.05, ge=0.0, le=1.0)
    max_p95_ms_increase: float = Field(default=200.0, ge=0.0, le=600_000)
    min_requests: int = Field(default=20, ge=1, le=1_000_000)

    @field_validator("steps")
    @classmethod
    def _steps(cls, v: list[int]) -> list[int]:
        if any(s < 1 or s > 100 for s in v) or v != sorted(set(v)):
            raise ValueError("steps must be strictly increasing percentages between 1 and 100")
        if v[-1] != 100:
            v = [*v, 100]
        return v


def _aware(dt: datetime | None) -> datetime | None:
    return dt.replace(tzinfo=UTC) if dt is not None and dt.tzinfo is None else dt


def _split(baseline: list[dict[str, Any]], candidate: dict[str, Any], weight: int) -> list[dict[str, Any]]:
    """Baseline routes scaled to ``100 - weight`` (largest-remainder rounding) plus the candidate at ``weight``."""
    rest = 100 - weight
    total = sum(r["weight"] for r in baseline) or 1
    raw = [r["weight"] * rest / total for r in baseline]
    floors = [int(v) for v in raw]
    for i in sorted(range(len(raw)), key=lambda i: -(raw[i] - floors[i]))[: rest - sum(floors)]:
        floors[i] += 1
    routes = [{**r, "weight": w} for r, w in zip(baseline, floors) if w > 0]
    return [*routes, {**candidate, "weight": weight}] if weight > 0 else routes


def rollout_out(c: CanaryRollout) -> dict[str, Any]:
    return {
        "id": c.id,
        "endpoint": c.endpoint_name,
        "status": c.status,
        "candidate": {k: c.candidate[k] for k in ("model_version_id", "model_id", "version")},
        "baseline_routes": c.baseline_routes,
        "steps": c.steps,
        "step_index": c.step_index,
        "weight": c.steps[min(c.step_index, len(c.steps) - 1)] if c.status == "running" else (100 if c.status == "completed" else 0),
        "step_minutes": c.step_minutes,
        "thresholds": {"max_error_rate": c.max_error_rate, "max_p95_ms_increase": c.max_p95_ms_increase, "min_requests": c.min_requests},
        "reason": c.reason,
        "history": c.history,
        "step_started_at": _aware(c.step_started_at),
        "next_eval_at": _aware(c.next_eval_at) if c.status == "running" else None,
        "created_by": c.created_by,
        "created_at": _aware(c.created_at),
        "finished_at": _aware(c.finished_at),
    }


def _default_scheduler(state: AppState) -> Callable[[str, dict[str, Any], float], None]:
    def schedule(tenant_id: str, params: dict[str, Any], delay: float) -> None:
        from ..jobs.core import JobService

        def fire() -> None:
            try:
                JobService(state).submit(tenant_id, JOB_TYPE, params, "system")
            except Exception:  # noqa: BLE001 - the canary-steps tick endpoint is the durable fallback
                log.exception("could not enqueue canary step %s", params.get("canary_id"))

        if delay <= 0:
            fire()
            return
        timer = threading.Timer(delay, fire)
        timer.daemon = True
        timer.start()

    return schedule


class CanaryService:
    def __init__(self, state: AppState):
        self.state = state

    # -- scheduling ----------------------------------------------------------------------------------
    def schedule(self, tenant_id: str, rollout_id: str, endpoint: str, at: datetime) -> None:
        delay = max(0.0, (_aware(at) - datetime.now(UTC)).total_seconds())
        params = {"canary_id": rollout_id, "endpoint": endpoint, "not_before": _aware(at).isoformat()}
        scheduler = self.state.extras.get("canary_scheduler") or _default_scheduler(self.state)
        scheduler(tenant_id, params, delay)

    # -- lifecycle -----------------------------------------------------------------------------------
    def _endpoint(self, s, tenant_id: str, name: str) -> Endpoint:
        ep = s.execute(select(Endpoint).where(Endpoint.tenant_id == tenant_id, Endpoint.name == name)).scalar_one_or_none()
        if ep is None:
            raise NotFound(name)
        return ep

    def _running(self, s, endpoint_id: str) -> CanaryRollout | None:
        return s.execute(
            select(CanaryRollout).where(CanaryRollout.endpoint_id == endpoint_id, CanaryRollout.status == "running")
        ).scalar_one_or_none()

    def running_for(self, tenant_id: str, endpoint_id: str) -> bool:
        with self.state.db.session(tenant_id) as s:
            return self._running(s, endpoint_id) is not None

    def start(self, tenant_id: str, actor: str, name: str, body: CanaryStart) -> dict[str, Any]:
        from .service import ServingService

        with self.state.db.session(tenant_id) as s:
            ep = self._endpoint(s, tenant_id, name)
            if ep.status != "active":
                raise CanaryError("endpoint is paused")
            if self._running(s, ep.id) is not None:
                raise CanaryConflict("a canary rollout is already running on this endpoint")
            mv = s.get(ModelVersion, body.model_version_id)
            if mv is None or mv.tenant_id != tenant_id:
                raise NotFound(body.model_version_id)
            baseline = [dict(r) for r in ep.routes if r["weight"] > 0]
            if any(r["model_version_id"] == mv.id for r in baseline):
                raise CanaryError("that model version already serves this endpoint")
            candidate = {"model_version_id": mv.id, "model_id": mv.model_id, "version": mv.version, "run_id": mv.run_id}
            now = datetime.now(UTC)
            rollout = CanaryRollout(
                tenant_id=tenant_id,
                endpoint_id=ep.id,
                endpoint_name=name,
                candidate=candidate,
                baseline_routes=baseline,
                steps=body.steps,
                step_index=0,
                step_minutes=body.step_minutes,
                max_error_rate=body.max_error_rate,
                max_p95_ms_increase=body.max_p95_ms_increase,
                min_requests=body.min_requests,
                history=[{"at": now.isoformat(), "event": "start", "weight": body.steps[0]}],
                step_started_at=now,
                next_eval_at=now + timedelta(minutes=body.step_minutes),
                created_by=actor,
            )
            s.add(rollout)
            if body.steps[0] >= 100:
                raise CanaryError("the first step must be below 100 %; to switch all traffic, PATCH the endpoint routes")
            ep.routes = _split(baseline, candidate, body.steps[0])
            s.flush()
            out = rollout_out(rollout)
        ServingService(self.state).training.load_bundle(tenant_id, candidate["run_id"])  # warm up (API-010)
        self.state.audit.record(tenant_id, actor, "endpoint.canary.start", endpoint=name, canary_id=out["id"], model_version_id=mv.id)
        self.schedule(tenant_id, out["id"], name, out["next_eval_at"])
        return out

    def status(self, tenant_id: str, name: str) -> dict[str, Any]:
        with self.state.db.session(tenant_id) as s:
            ep = self._endpoint(s, tenant_id, name)
            rollout = s.execute(
                select(CanaryRollout).where(CanaryRollout.endpoint_id == ep.id).order_by(CanaryRollout.created_at.desc()).limit(1)
            ).scalar_one_or_none()
            if rollout is None:
                raise NotFound(f"no canary rollout on {name}")
            out = rollout_out(rollout)
            if rollout.status == "running":
                out["live"] = self._compare(s, rollout)
            return out

    def _finish(self, s, rollout: CanaryRollout, status: str, reason: str, routes: list[dict[str, Any]], metrics: dict | None) -> None:
        ep = s.get(Endpoint, rollout.endpoint_id)
        if ep is not None:
            ep.routes = routes
        now = datetime.now(UTC)
        rollout.status, rollout.reason, rollout.finished_at = status, reason, now
        rollout.history = [*rollout.history, {"at": now.isoformat(), "event": status, "reason": reason, "metrics": metrics}]

    def promote(self, tenant_id: str, actor: str, name: str) -> dict[str, Any]:
        with self.state.db.session(tenant_id) as s:
            ep = self._endpoint(s, tenant_id, name)
            rollout = self._running(s, ep.id)
            if rollout is None:
                raise CanaryConflict("no canary rollout is running on this endpoint")
            self._finish(s, rollout, "completed", "promoted manually", [{**rollout.candidate, "weight": 100}], None)
            out = rollout_out(rollout)
        self.state.audit.record(tenant_id, actor, "endpoint.canary.promote", endpoint=name, canary_id=out["id"])
        return out

    def abort(self, tenant_id: str, actor: str, name: str) -> dict[str, Any]:
        with self.state.db.session(tenant_id) as s:
            ep = self._endpoint(s, tenant_id, name)
            rollout = self._running(s, ep.id)
            if rollout is None:
                raise CanaryConflict("no canary rollout is running on this endpoint")
            self._finish(s, rollout, "aborted", "aborted manually", list(rollout.baseline_routes), None)
            out = rollout_out(rollout)
        self.state.audit.record(tenant_id, actor, "endpoint.canary.abort", endpoint=name, canary_id=out["id"])
        return out

    # -- evaluation ----------------------------------------------------------------------------------
    def _compare(self, s, rollout: CanaryRollout) -> dict[str, Any]:
        rows = s.execute(
            select(PredictionLog.model_version_id, PredictionLog.latency_ms, PredictionLog.status).where(
                PredictionLog.endpoint_id == rollout.endpoint_id, PredictionLog.at >= _aware(rollout.step_started_at)
            )
        ).all()
        cand_id = rollout.candidate["model_version_id"]

        def summarize(items: list) -> dict[str, Any]:
            if not items:
                return {"requests": 0, "errors": 0, "error_rate": None, "p95_ms": None}
            errors = sum(1 for r in items if r[2] >= 400)
            ok = [r[1] for r in items if r[2] < 400] or [r[1] for r in items]
            return {
                "requests": len(items),
                "errors": errors,
                "error_rate": round(errors / len(items), 6),
                "p95_ms": round(float(np.percentile(ok, 95)), 3),
            }

        return {"canary": summarize([r for r in rows if r[0] == cand_id]), "baseline": summarize([r for r in rows if r[0] != cand_id])}

    def evaluate(self, tenant_id: str, rollout_id: str, *, force: bool = False) -> dict[str, Any]:
        """One canary step. Returns ``{status, action, ...}``; re-schedules itself while the rollout runs."""
        from ..jobs.core import notify

        now = datetime.now(UTC)
        with self.state.db.session(tenant_id) as s:
            rollout = s.get(CanaryRollout, rollout_id)
            if rollout is None or rollout.tenant_id != tenant_id:
                raise NotFound(rollout_id)
            if rollout.status != "running":
                return {"canary_id": rollout_id, "status": rollout.status, "action": "none"}
            name = rollout.endpoint_name
            if not force and _aware(rollout.next_eval_at) > now + timedelta(seconds=1):
                action, next_at = "deferred", _aware(rollout.next_eval_at)
                metrics = None
            else:
                metrics = self._compare(s, rollout)
                cand, base = metrics["canary"], metrics["baseline"]
                reason = None
                if cand["requests"] and cand["error_rate"] > rollout.max_error_rate:
                    reason = f"canary error rate {cand['error_rate']:.2%} exceeds {rollout.max_error_rate:.2%}"
                elif (
                    cand["requests"] >= rollout.min_requests
                    and base["p95_ms"] is not None
                    and cand["p95_ms"] - base["p95_ms"] > rollout.max_p95_ms_increase
                ):
                    reason = (
                        f"canary p95 latency {cand['p95_ms']:.1f} ms is {cand['p95_ms'] - base['p95_ms']:.1f} ms above the "
                        f"baseline (limit {rollout.max_p95_ms_increase:.1f} ms)"
                    )
                step_seconds = rollout.step_minutes * 60
                if reason:
                    self._finish(s, rollout, "rolled_back", reason, list(rollout.baseline_routes), metrics)
                    action, next_at = "rolled_back", None
                elif cand["requests"] < rollout.min_requests:
                    action = "hold"
                    next_at = now + timedelta(seconds=max(step_seconds, HOLD_MIN_SECONDS))
                    rollout.next_eval_at = next_at
                    rollout.history = [
                        *rollout.history,
                        {"at": now.isoformat(), "event": "hold", "weight": rollout.steps[rollout.step_index], "metrics": metrics},
                    ]
                else:
                    rollout.step_index += 1
                    weight = rollout.steps[rollout.step_index]
                    if weight >= 100:
                        self._finish(s, rollout, "completed", "all steps passed", [{**rollout.candidate, "weight": 100}], metrics)
                        action, next_at = "completed", None
                    else:
                        ep = s.get(Endpoint, rollout.endpoint_id)
                        ep.routes = _split(list(rollout.baseline_routes), rollout.candidate, weight)
                        rollout.step_started_at, rollout.next_eval_at = now, now + timedelta(seconds=step_seconds)
                        rollout.history = [*rollout.history, {"at": now.isoformat(), "event": "ramp", "weight": weight, "metrics": metrics}]
                        action, next_at = "ramped", rollout.next_eval_at
            out = rollout_out(rollout)
        if action == "rolled_back":
            body = {
                "endpoint": name,
                "kind": "canary",
                "status": "rolled_back",
                "canary_id": rollout_id,
                "reason": out["reason"],
                **metrics,
            }
            notify(self.state, tenant_id, None, "endpoint.threshold", f"canary on endpoint {name} rolled back", body)
            self.state.audit.record(
                tenant_id, "system", "endpoint.canary.rollback", endpoint=name, canary_id=rollout_id, reason=out["reason"]
            )
        elif action == "completed":
            self.state.audit.record(tenant_id, "system", "endpoint.canary.complete", endpoint=name, canary_id=rollout_id)
        elif action == "ramped":
            self.state.audit.record(tenant_id, "system", "endpoint.canary.ramp", endpoint=name, canary_id=rollout_id, weight=out["weight"])
        # Every hold / ramp schedules exactly one follow-up; an early (deferred) trigger is dropped, so duplicate
        # triggers (timer + tick endpoint) never multiply.
        if next_at is not None and action != "deferred":
            self.schedule(tenant_id, rollout_id, name, next_at)
        return {"canary_id": rollout_id, "status": out["status"], "action": action, "weight": out["weight"], "metrics": metrics}

    def due(self, tenant_id: str) -> list[str]:
        now = datetime.now(UTC)
        with self.state.db.session(tenant_id) as s:
            rows = s.execute(
                select(CanaryRollout.id, CanaryRollout.next_eval_at).where(
                    CanaryRollout.tenant_id == tenant_id, CanaryRollout.status == "running"
                )
            ).all()
        return [r[0] for r in rows if _aware(r[1]) <= now]
