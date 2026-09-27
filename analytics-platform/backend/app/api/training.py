"""Model Training Studio, model registry and training-template endpoints (Module 5; CFG-007, MDL-NFR-004)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..auth.rbac import Permission
from ..auth.service import Principal
from ..datasets_io import load_table
from ..jobs.core import JobService
from ..llm.base import LLMRequest, Message
from ..llm.prompts import DEFAULT_PROMPTS
from ..llm.router import LLMUnavailableError
from ..storage.datasets import DatasetNotFound
from ..training.algorithms import AlgorithmInfo, catalog
from ..training.anomaly import POSITIVE_LABELS
from ..training.custom_models import MAX_UPLOAD_BYTES, CustomModelService, UploadRejected, UploadSignature
from ..training.forecasting import detect_time_series
from ..training.onnx_export import OnnxUnsupported
from ..training.projection import ProjectionRequest, project_dataset, project_run
from ..training.service import (
    ExperimentOut,
    HoldoutMissing,
    NotFound,
    RunOut,
    TemplateConflict,
    TemplateService,
    TrainingService,
)
from ..training.trainer import TrainingConfig, TrainingError, detect_problem_type
from .deps import AppState, StateDep, guard_dataset, require

router = APIRouter(prefix="/v1", tags=["training"])
Trainer = require(Permission.TRAIN_MODELS)
Reader = require(Permission.READ_DATA)


class DetectBody(BaseModel):
    dataset_id: str
    target: str | None = None  # no target → clustering (MDL-002a)
    version: int | None = None


class ExperimentCreate(TrainingConfig):
    name: str = Field(min_length=1, max_length=200)
    dataset_id: str
    dataset_version: int | None = None


class ExplainBody(BaseModel):
    instances: list[dict[str, Any]] = Field(min_length=1, max_length=100)


class RegisterBody(BaseModel):
    name: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
    run_id: str
    description: str | None = Field(default=None, max_length=2000)


class StageBody(BaseModel):
    stage: str


class FairnessBody(BaseModel):
    protected: list[str] = Field(min_length=1, max_length=20)
    positive_class: Any = None
    min_group_size: int = Field(default=10, ge=1, le=10_000)


class TemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    config: dict[str, Any]


class TemplatePatch(BaseModel):
    description: str | None = Field(default=None, max_length=2000)
    config: dict[str, Any] | None = None


class TemplateApply(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    dataset_id: str
    dataset_version: int | None = None
    overrides: dict[str, Any] = Field(default_factory=dict)


def _nf(exc: Exception) -> HTTPException:
    return HTTPException(status_code=404, detail=f"not found: {exc}")


@router.get("/algorithms", response_model=list[AlgorithmInfo])
async def algorithms(principal: Principal = Reader) -> list[AlgorithmInfo]:
    """Supervised algorithms first, then ensembles (TRN-005), clustering (TRN-006) and forecasting (TRN-007)."""
    return catalog()


@router.post("/experiments/detect")
async def detect(body: DetectBody, state: AppState = StateDep, principal: Principal = Reader) -> dict[str, Any]:
    """MDL-002 / MDL-002a: auto-detect the problem type for a target column.

    Without a target the answer is clustering. A numeric target indexed by a regular date column also gets a
    forecasting suggestion in ``alternatives`` (``{problem_type, time_column, frequency, reason}``).
    """
    guard_dataset(state, principal, body.dataset_id)
    try:
        record = state.store.get(principal.tenant_id, body.dataset_id, body.version)
        frame = await asyncio.to_thread(load_table, state.store, record)
    except DatasetNotFound as exc:
        raise _nf(exc) from exc
    if not body.target:
        return {
            "problem_type": "clustering",
            "reason": "no target column: group similar rows into clusters",
            # MDL-002b: unsupervised anomaly detection is the other target-free option.
            "alternatives": [{"problem_type": "anomaly", "reason": "no target column: flag unusual rows (anomaly detection)"}],
        }
    if body.target not in frame.columns:
        raise HTTPException(status_code=422, detail=f"unknown column {body.target!r}")
    try:
        problem, reason = detect_problem_type(frame[body.target])
    except TrainingError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    out: dict[str, Any] = {"problem_type": problem, "reason": reason}
    if problem != "regression":
        counts = frame[body.target].astype(str).value_counts()
        out["classes"] = [{"value": k, "count": int(v)} for k, v in counts.head(100).items()]
        if len(counts) >= 2 and counts.iloc[-1] / counts.iloc[0] < 0.2:
            out["imbalance_hint"] = "classes are imbalanced; consider class_imbalance = class_weight or smote"
    if problem == "regression":
        series = await asyncio.to_thread(detect_time_series, frame, body.target)
        if series:
            out["alternatives"] = [series]
    anomaly = _anomaly_hint(frame[body.target]) if problem == "binary" else None
    if anomaly:
        out.setdefault("alternatives", []).append(anomaly)
    return out


def _anomaly_hint(y) -> dict[str, Any] | None:
    """MDL-002b: a rare binary label (≤ 5 %, or named like fraud / anomaly / outlier) suggests anomaly detection, with the
    label used only for evaluation."""
    counts = y.dropna().astype(str).str.strip().value_counts()
    if len(counts) != 2:
        return None
    minority, share = counts.index[-1], float(counts.iloc[-1] / counts.sum())
    named = any(str(v).lower() in POSITIVE_LABELS - {"1", "1.0", "true", "yes", "y"} for v in counts.index)
    if share > 0.05 and not named:
        return None
    return {
        "problem_type": "anomaly",
        "label_column": y.name,
        "positive_label": minority,
        "reason": f"{minority!r} is rare ({share:.1%}); anomaly detection learns what is normal and uses the label only for evaluation",
    }


@router.post("/experiments", status_code=202)
async def create_experiment(body: ExperimentCreate, state: AppState = StateDep, principal: Principal = Trainer) -> dict[str, Any]:
    guard_dataset(state, principal, body.dataset_id)
    config = TrainingConfig.model_validate(body.model_dump(exclude={"name", "dataset_id", "dataset_version"}))
    try:
        exp = TrainingService(state).create_experiment(
            principal.tenant_id,
            principal.user_id,
            name=body.name,
            dataset_id=body.dataset_id,
            dataset_version=body.dataset_version,
            config=config,
        )
    except DatasetNotFound as exc:
        raise _nf(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    job = JobService(state).submit(principal.tenant_id, "training.run", {"experiment_id": exp.id}, principal.user_id, max_attempts=2)
    return {"experiment": exp.model_dump(mode="json"), "job": job.model_dump(mode="json")}


@router.get("/experiments", response_model=list[ExperimentOut])
async def list_experiments(state: AppState = StateDep, principal: Principal = Reader) -> list[ExperimentOut]:
    return TrainingService(state).list_experiments(principal.tenant_id)


@router.get("/experiments/compare")
async def compare(run_ids: str, state: AppState = StateDep, principal: Principal = Reader) -> dict[str, Any]:
    """EXP-007: side-by-side metrics for runs, across experiments."""
    svc = TrainingService(state)
    try:
        runs = [svc.get_run(principal.tenant_id, rid) for rid in run_ids.split(",") if rid][:20]
    except NotFound as exc:
        raise _nf(exc) from exc
    names = sorted({k for r in runs for k, v in r.metrics.items() if isinstance(v, (int, float)) and not isinstance(v, bool)})
    return {
        "metrics": names,
        "runs": [
            {
                "id": r.id,
                "experiment_id": r.experiment_id,
                "algorithm": r.algorithm,
                "params": r.params,
                "metrics": {k: r.metrics.get(k) for k in names},
            }
            for r in runs
        ],
    }


@router.get("/experiments/{experiment_id}")
async def get_experiment(experiment_id: str, state: AppState = StateDep, principal: Principal = Reader) -> dict[str, Any]:
    try:
        exp, runs = TrainingService(state).get_experiment(principal.tenant_id, experiment_id)
    except NotFound as exc:
        raise _nf(exc) from exc
    jobs = [
        j
        for j in JobService(state).list(principal.tenant_id)
        if j.type == "training.run" and j.params.get("experiment_id") == experiment_id
    ]
    return {"experiment": exp, "runs": runs, "job": jobs[0] if jobs else None}


@router.get("/runs/{run_id}", response_model=RunOut)
async def get_run(run_id: str, state: AppState = StateDep, principal: Principal = Reader) -> RunOut:
    try:
        return TrainingService(state).get_run(principal.tenant_id, run_id)
    except NotFound as exc:
        raise _nf(exc) from exc


@router.post("/runs/{run_id}/explain")
async def explain(run_id: str, body: ExplainBody, state: AppState = StateDep, principal: Principal = Reader) -> dict[str, Any]:
    """XAI-002 / XAI-003 what-if: predictions and SHAP contributions for arbitrary inputs."""
    svc = TrainingService(state)
    try:
        bundle = await asyncio.to_thread(svc.load_bundle, principal.tenant_id, run_id)
        return await asyncio.to_thread(bundle.explain, body.instances)
    except NotFound as exc:
        raise _nf(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/runs/{run_id}/fairness")
async def fairness(run_id: str, body: FairnessBody, state: AppState = StateDep, principal: Principal = Reader) -> dict[str, Any]:
    """XAI-004: selection rate, TPR / FPR and precision per group of each protected attribute on the held-out test set,
    with demographic parity, equalized odds and the four-fifths rule. Any dataset column can be a protected attribute."""
    svc = TrainingService(state)
    try:
        run = svc.get_run(principal.tenant_id, run_id)
        exp, _ = svc.get_experiment(principal.tenant_id, run.experiment_id)
        guard_dataset(state, principal, exp.dataset_id)
        return await asyncio.to_thread(
            svc.fairness, principal.tenant_id, principal.user_id, run_id, body.protected, body.positive_class, body.min_group_size
        )
    except NotFound as exc:
        raise _nf(exc) from exc
    except HoldoutMissing as exc:
        raise HTTPException(status_code=409, detail={"code": "holdout_missing", "message": str(exc)}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/runs/{run_id}/projection")
async def run_projection(
    run_id: str, body: ProjectionRequest | None = None, state: AppState = StateDep, principal: Principal = Reader
) -> dict[str, Any]:
    """FE-005a: a 2-D UMAP / t-SNE embedding of (≤ 5k) rows of the run's dataset through the run's fitted
    preprocessing, coloured by the model's predictions. Visualization only."""
    body = body or ProjectionRequest()
    svc = TrainingService(state)
    try:
        run = svc.get_run(principal.tenant_id, run_id)
        exp, _ = svc.get_experiment(principal.tenant_id, run.experiment_id)
        guard_dataset(state, principal, exp.dataset_id)
        bundle = await asyncio.to_thread(svc.load_bundle, principal.tenant_id, run_id)
        if bundle.problem_type == "forecasting":
            raise HTTPException(
                status_code=409, detail={"code": "projection_unsupported", "message": "forecasting runs have no row projection"}
            )
        record = state.store.get(principal.tenant_id, exp.dataset_id, exp.dataset_version)
        frame = await asyncio.to_thread(load_table, state.store, record)
        return await asyncio.to_thread(project_run, bundle, frame, body)
    except (NotFound, DatasetNotFound) as exc:
        raise _nf(exc) from exc
    except TypeError as exc:
        raise HTTPException(status_code=409, detail={"code": "projection_unsupported", "message": str(exc)}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/datasets/{dataset_id}/projection")
async def dataset_projection(
    dataset_id: str,
    body: ProjectionRequest | None = None,
    version: int | None = None,
    state: AppState = StateDep,
    principal: Principal = Reader,
) -> dict[str, Any]:
    """FE-005a: a 2-D UMAP (or t-SNE / PCA) embedding of a sample (≤ 5k rows) of a dataset. PII columns are left out
    unless listed in ``features``. Visualization only."""
    body = body or ProjectionRequest()
    guard_dataset(state, principal, dataset_id)
    try:
        record = state.store.get(principal.tenant_id, dataset_id, version)
        frame = await asyncio.to_thread(load_table, state.store, record)
    except DatasetNotFound as exc:
        raise _nf(exc) from exc
    fields = {f.name: f for f in record.schema_.entities[0].fields} if record.schema_ and record.schema_.entities else {}
    try:
        return await asyncio.to_thread(project_dataset, frame, body, fields)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/runs/{run_id}/onnx")
async def export_onnx(run_id: str, state: AppState = StateDep, principal: Principal = Reader) -> Response:
    """MDL-NFR-004: download the run's pipeline as ONNX. 409 with the reason when the pipeline isn't convertible."""
    try:
        data = await asyncio.to_thread(TrainingService(state).export_onnx, principal.tenant_id, principal.user_id, run_id)
    except NotFound as exc:
        raise _nf(exc) from exc
    except OnnxUnsupported as exc:
        raise HTTPException(status_code=409, detail={"code": "onnx_unsupported", "message": str(exc)}) from exc
    return Response(data, media_type="application/octet-stream", headers={"Content-Disposition": f'attachment; filename="{run_id}.onnx"'})


@router.post("/runs/{run_id}/explanation-text")
async def explanation_text(run_id: str, state: AppState = StateDep, principal: Principal = Reader) -> dict[str, str]:
    """XAI-005: a plain-English summary of the model, from aggregate explanations only (no raw rows)."""
    try:
        run = TrainingService(state).get_run(principal.tenant_id, run_id)
    except NotFound as exc:
        raise _nf(exc) from exc
    summary = {
        "algorithm": run.algorithm,
        "metrics": {k: v for k, v in run.metrics.items() if isinstance(v, (int, float))},
        "top_features": (run.artifacts.get("shap_summary") or run.artifacts.get("permutation_importance") or [])[:8],
        "warnings": run.artifacts.get("warnings", []),
    }
    request = LLMRequest(
        system=DEFAULT_PROMPTS["model.explain"].system,  # LPA-008: tenant overrides are applied by the router
        messages=[Message(role="user", content=f"<model>{json.dumps(summary, default=str)}</model>")],
        task="model.explain",
        template=DEFAULT_PROMPTS["model.explain"].ref,
        max_tokens=2000,
    )
    try:
        response = await state.router(principal.tenant_id, "model.explain").complete(request, actor=principal.user_id)
    except LLMUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"text": response.text}


# -- registry -------------------------------------------------------------------------------------


@router.post("/models", status_code=201)
async def register_model(body: RegisterBody, state: AppState = StateDep, principal: Principal = Trainer) -> dict[str, Any]:
    try:
        out = TrainingService(state).register(
            principal.tenant_id, principal.user_id, name=body.name, run_id=body.run_id, description=body.description
        )
    except NotFound as exc:
        raise _nf(exc) from exc
    from ..jobs.core import notify

    notify(state, principal.tenant_id, None, "model.registered", f"{body.name} v{out['version']} registered", out)
    return out


@router.post("/models/upload", status_code=201)
async def upload_model(
    file: UploadFile = File(...),
    signature: str = Form(...),
    name: str = Form(..., min_length=1, max_length=200, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$"),
    description: str | None = Form(None, max_length=2000),
    dataset_id: str | None = Form(None),
    state: AppState = StateDep,
    principal: Principal = Trainer,
) -> dict[str, Any]:
    """TRN-010 / SEC-010: register an uploaded **ONNX** model (≤ 200 MB) with a JSON ``signature``. The file is checked,
    loaded in onnxruntime and dry-run on a synthetic row; pickle / joblib are never accepted. ``dataset_id`` (optional)
    supplies reference rows for drift monitoring and explanations; otherwise synthetic rows from the signature are used."""
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"model file exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
    try:
        sig = UploadSignature.model_validate_json(signature)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"invalid signature: {exc}") from exc
    guard_dataset(state, principal, dataset_id)
    try:
        out = await asyncio.to_thread(
            CustomModelService(state).upload,
            principal.tenant_id,
            principal.user_id,
            name=name,
            description=description,
            data=data,
            signature=sig,
            dataset_id=dataset_id,
            filename=file.filename,
        )
    except DatasetNotFound as exc:
        raise _nf(exc) from exc
    except UploadRejected as exc:
        state.audit.record(principal.tenant_id, principal.user_id, "model.upload_rejected", reason=str(exc)[:300])
        raise HTTPException(status_code=422, detail={"code": "model_rejected", "message": str(exc)}) from exc
    from ..jobs.core import notify

    notify(state, principal.tenant_id, None, "model.registered", f"{name} v{out['version']} uploaded", out)
    return out


@router.get("/models")
async def list_models(state: AppState = StateDep, principal: Principal = Reader) -> list[dict[str, Any]]:
    return TrainingService(state).list_models(principal.tenant_id)


@router.get("/models/{model_id}")
async def get_model(model_id: str, state: AppState = StateDep, principal: Principal = Reader) -> dict[str, Any]:
    try:
        return TrainingService(state).get_model(principal.tenant_id, model_id)
    except NotFound as exc:
        raise _nf(exc) from exc


@router.post("/models/{model_id}/versions/{version}/stage")
async def set_stage(
    model_id: str, version: int, body: StageBody, state: AppState = StateDep, principal: Principal = require(Permission.DEPLOY)
) -> dict[str, Any]:
    try:
        return TrainingService(state).set_stage(principal.tenant_id, principal.user_id, model_id, version, body.stage)
    except NotFound as exc:
        raise _nf(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# -- training templates (CFG-007) -------------------------------------------------------------------------


@router.get("/training-templates")
async def list_templates(state: AppState = StateDep, principal: Principal = Reader) -> list[dict[str, Any]]:
    return TemplateService(state).list(principal.tenant_id)


@router.post("/training-templates", status_code=201)
async def create_template(body: TemplateCreate, state: AppState = StateDep, principal: Principal = Trainer) -> dict[str, Any]:
    """CFG-007: save a TrainingConfig (target optional) as a named template."""
    try:
        return TemplateService(state).create(
            principal.tenant_id, principal.user_id, name=body.name, description=body.description, config=body.config
        )
    except TemplateConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/training-templates/{template_id}")
async def get_template(template_id: str, state: AppState = StateDep, principal: Principal = Reader) -> dict[str, Any]:
    try:
        return TemplateService(state).get(principal.tenant_id, template_id)
    except NotFound as exc:
        raise _nf(exc) from exc


@router.patch("/training-templates/{template_id}")
async def patch_template(
    template_id: str, body: TemplatePatch, state: AppState = StateDep, principal: Principal = Trainer
) -> dict[str, Any]:
    try:
        return TemplateService(state).update(
            principal.tenant_id, principal.user_id, template_id, description=body.description, config=body.config
        )
    except NotFound as exc:
        raise _nf(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/training-templates/{template_id}", status_code=204)
async def delete_template(template_id: str, state: AppState = StateDep, principal: Principal = Trainer) -> None:
    try:
        TemplateService(state).delete(principal.tenant_id, principal.user_id, template_id)
    except NotFound as exc:
        raise _nf(exc) from exc


@router.post("/training-templates/{template_id}/apply", status_code=202)
async def apply_template(
    template_id: str, body: TemplateApply, state: AppState = StateDep, principal: Principal = Trainer
) -> dict[str, Any]:
    """CFG-007: create an experiment (and its training job) from a template plus ``overrides`` (e.g. the target)."""
    guard_dataset(state, principal, body.dataset_id)
    try:
        config = TemplateService(state).resolve(principal.tenant_id, template_id, body.overrides)
        exp = TrainingService(state).create_experiment(
            principal.tenant_id,
            principal.user_id,
            name=body.name,
            dataset_id=body.dataset_id,
            dataset_version=body.dataset_version,
            config=config,
        )
    except (NotFound, DatasetNotFound) as exc:
        raise _nf(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    job = JobService(state).submit(principal.tenant_id, "training.run", {"experiment_id": exp.id}, principal.user_id, max_attempts=2)
    return {"experiment": exp.model_dump(mode="json"), "job": job.model_dump(mode="json"), "template_id": template_id}
