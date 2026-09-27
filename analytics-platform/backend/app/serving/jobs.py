"""Batch prediction jobs (API-005), drift checks (API-011) and webhook deliveries (WHK-001)."""

from __future__ import annotations

import io

import pandas as pd

from ..datasets_io import MultiTableError, load_table
from ..export_utils import jsonable
from ..jobs.core import JobContext, PermanentJobError, job_handler
from ..storage.datasets import DatasetNotFound
from ..training.service import NotFound
from .service import ServingService

CHUNK_ROWS = 10_000


@job_handler("serving.batch_predict")
def batch_predict_job(ctx: JobContext) -> dict:
    svc = ServingService(ctx.state)
    try:
        endpoint = svc.get(ctx.tenant_id, ctx.params["endpoint"])
        if ctx.params.get("dataset_id"):
            record = ctx.state.store.get(ctx.tenant_id, ctx.params["dataset_id"])
            frame = load_table(ctx.state.store, record)
        else:
            frame = pd.read_csv(io.BytesIO(ctx.state.objects.get_bytes(ctx.tenant_id, ctx.params["input_key"])))
    except (NotFound, DatasetNotFound, MultiTableError, KeyError) as exc:
        raise PermanentJobError(str(exc)) from exc
    # Batch jobs use the endpoint's primary (highest-weight) route for consistent output.
    route = max(endpoint.routes, key=lambda r: r["weight"])
    bundle = svc.bundle_for(ctx.tenant_id, route)
    if bundle.problem_type == "forecasting":
        raise PermanentJobError("batch prediction isn't available for forecasting endpoints; call predict with a horizon")
    outputs = []
    for start in range(0, len(frame), CHUNK_ROWS):
        chunk = frame.iloc[start : start + CHUNK_ROWS]
        try:
            result = bundle.predict([{k: jsonable(v) for k, v in row.items()} for row in chunk.to_dict(orient="records")])
        except ValueError as exc:
            raise PermanentJobError(str(exc)) from exc
        part = chunk.copy()
        preds = result["predictions"]
        if preds and isinstance(preds[0], dict):  # anomaly detection (TRN-008)
            part["is_anomaly"] = [p["is_anomaly"] for p in preds]
            part["anomaly_score"] = [p["score"] for p in preds]
        else:
            part["prediction"] = preds
        if "probabilities" in result:
            for i, cls in enumerate(result["classes"]):
                part[f"probability_{cls}"] = [p[i] for p in result["probabilities"]]
        outputs.append(part)
        ctx.progress(min(0.95, (start + len(chunk)) / max(1, len(frame))), f"{start + len(chunk):,}/{len(frame):,} rows")
    out = pd.concat(outputs) if outputs else frame.assign(prediction=[])
    key = f"batch/{ctx.job_id}/predictions.csv"
    ctx.state.objects.put_bytes(ctx.tenant_id, key, out.to_csv(index=False).encode())
    ctx.state.metering.add(ctx.tenant_id, "api.predictions", endpoint.name, len(out))
    return {"output_key": key, "rows": len(out), "endpoint": endpoint.name, "model_version": route["version"]}


@job_handler("serving.drift_check")
def drift_check_job(ctx: JobContext) -> dict:
    """API-011: compute drift for one endpoint (``params.endpoint``) or every active endpoint, and raise an
    ``endpoint.threshold`` notification (and webhook) for each endpoint whose drift reaches the alert threshold.

    Submit it on a schedule (cron / Cloud Scheduler calling ``POST /v1/endpoints/drift-checks``) or on demand.
    """
    from ..jobs.core import notify

    svc = ServingService(ctx.state)
    hours = int(ctx.params.get("hours") or 24)
    names = [ctx.params["endpoint"]] if ctx.params.get("endpoint") else [e.name for e in svc.list(ctx.tenant_id) if e.status == "active"]
    checked, alerts = [], []
    for i, name in enumerate(names):
        try:
            report = svc.drift(ctx.tenant_id, name, hours)
        except NotFound as exc:
            if ctx.params.get("endpoint"):
                raise PermanentJobError(f"endpoint not found: {exc}") from exc
            continue
        checked.append({"endpoint": name, "status": report["status"], "samples": report["samples"]})
        if report["status"] == "alert":
            prediction = report.get("prediction") or {}
            body = {
                "endpoint": name,
                "kind": "drift",
                "status": "alert",
                "window_hours": hours,
                "threshold": report["thresholds"]["alert"],
                "features": [{"feature": f["feature"], "psi": f["psi"]} for f in report["features"] if f["status"] == "alert"],
                "prediction_psi": prediction.get("psi"),
            }
            notify(ctx.state, ctx.tenant_id, None, "endpoint.threshold", f"drift alert on endpoint {name}", body)
            alerts.append(body)
        ctx.progress((i + 1) / max(1, len(names)), f"checked {i + 1}/{len(names)} endpoints")
    return {"checked": checked, "alerts": alerts}


@job_handler("serving.canary_step")
def canary_step_job(ctx: JobContext) -> dict:
    """API-009: evaluate one canary step (ramp, hold, complete or roll back); re-enqueues itself with a delay."""
    from .canary import CanaryService

    svc = CanaryService(ctx.state)
    if ctx.params.get("canary_id"):
        try:
            return svc.evaluate(ctx.tenant_id, ctx.params["canary_id"])
        except NotFound as exc:
            raise PermanentJobError(f"canary rollout not found: {exc}") from exc
    # Tick mode (POST /v1/endpoints/canary-steps): every due rollout of the tenant.
    return {"evaluated": [svc.evaluate(ctx.tenant_id, rid) for rid in svc.due(ctx.tenant_id)]}


@job_handler("webhook.deliver")
def webhook_delivery_job(ctx: JobContext) -> dict:
    from ..webhooks import deliver

    return deliver(ctx.state, ctx.tenant_id, ctx.params["delivery_id"])
