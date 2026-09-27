"""Batch prediction jobs (API-005) and webhook deliveries (WHK-001)."""

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
    outputs = []
    for start in range(0, len(frame), CHUNK_ROWS):
        chunk = frame.iloc[start : start + CHUNK_ROWS]
        try:
            result = bundle.predict([{k: jsonable(v) for k, v in row.items()} for row in chunk.to_dict(orient="records")])
        except ValueError as exc:
            raise PermanentJobError(str(exc)) from exc
        part = chunk.copy()
        part["prediction"] = result["predictions"]
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


@job_handler("webhook.deliver")
def webhook_delivery_job(ctx: JobContext) -> dict:
    from ..webhooks import deliver

    return deliver(ctx.state, ctx.tenant_id, ctx.params["delivery_id"])
