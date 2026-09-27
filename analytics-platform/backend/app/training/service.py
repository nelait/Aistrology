"""Experiments, runs, model artifacts and the model registry (EXP-001/007/008, MDL-NFR-004/005)."""

from __future__ import annotations

import io
import threading
from collections import OrderedDict
from typing import TYPE_CHECKING, Any

import joblib
import numpy as np
import pandas as pd
from pydantic import BaseModel
from sqlalchemy import func, select

from ..datasets_io import load_table
from ..db.models import Experiment, ModelVersion, RegisteredModel, Run
from ..export_utils import jsonable
from .algorithms import ALGORITHMS
from .trainer import TrainingConfig, aggregate_to_original, shap_values, train, transformed_feature_names

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState

CODE_VERSION = "ap-train-1"
STAGES = ("none", "staging", "production", "archived")


class NotFound(LookupError):
    pass


class RunOut(BaseModel):
    id: str
    experiment_id: str
    status: str
    algorithm: str | None
    params: dict[str, Any]
    metrics: dict[str, Any]
    artifacts: dict[str, Any]
    duration_seconds: float | None
    created_at: Any

    @classmethod
    def of(cls, r: Run, *, with_artifacts: bool = True) -> RunOut:
        return cls(
            id=r.id,
            experiment_id=r.experiment_id,
            status=r.status,
            algorithm=r.algorithm,
            params=r.params,
            metrics=r.metrics,
            artifacts=r.artifacts if with_artifacts else {k: v for k, v in r.artifacts.items() if k in ("is_best", "warnings")},
            duration_seconds=r.duration_seconds,
            created_at=r.created_at,
        )


class ExperimentOut(BaseModel):
    id: str
    name: str
    dataset_id: str
    dataset_version: int
    config: dict[str, Any]
    created_by: str
    created_at: Any

    @classmethod
    def of(cls, e: Experiment) -> ExperimentOut:
        return cls(
            id=e.id,
            name=e.name,
            dataset_id=e.dataset_id,
            dataset_version=e.dataset_version,
            config=e.config,
            created_by=e.created_by,
            created_at=e.created_at,
        )


class ModelBundle:
    """A trained pipeline plus what serving and explanations need."""

    def __init__(self, pipeline, signature: dict[str, Any], background: pd.DataFrame, algorithm: str):
        self.pipeline = pipeline
        self.signature = signature
        self.background = background
        self.algorithm = algorithm

    @property
    def problem_type(self) -> str:
        return self.signature["problem_type"]

    @property
    def feature_names(self) -> list[str]:
        return [f["name"] for f in self.signature["features"]]

    def groups(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {"numeric": [], "categorical": [], "datetime": [], "dropped": []}
        for f in self.signature["features"]:
            out.setdefault(f["group"], []).append(f["name"])
        return out

    def frame(self, instances: list[dict[str, Any]]) -> pd.DataFrame:
        """Validate and coerce request instances into the training schema."""
        if not instances:
            raise ValueError("instances must not be empty")
        missing_everywhere = [f for f in self.feature_names if all(f not in row for row in instances)]
        used = [f["name"] for f in self.signature["features"] if f["group"] != "dropped"]
        required_missing = [f for f in missing_everywhere if f in used]
        if required_missing:
            raise ValueError(f"missing features: {', '.join(required_missing)}")
        frame = pd.DataFrame([{f: row.get(f) for f in self.feature_names} for row in instances])
        for f in self.signature["features"]:
            col = f["name"]
            if f["group"] == "numeric":
                frame[col] = pd.to_numeric(frame[col], errors="coerce").astype(float)
            elif f["group"] == "categorical" and f["dtype"].startswith(("int", "float")):
                frame[col] = pd.to_numeric(frame[col], errors="coerce")
            elif f["group"] == "categorical" and f["dtype"] == "bool":
                frame[col] = frame[col].astype("boolean")
        return frame

    def predict(self, instances: list[dict[str, Any]]) -> dict[str, Any]:
        X = self.frame(instances)
        out: dict[str, Any] = {}
        pred = self.pipeline.predict(X)
        classes = self.signature.get("classes")
        if classes:
            out["predictions"] = [jsonable(classes[int(i)]) for i in pred]
            if hasattr(self.pipeline, "predict_proba"):
                out["probabilities"] = np.round(self.pipeline.predict_proba(X), 6).tolist()
                out["classes"] = [jsonable(c) for c in classes]
        else:
            out["predictions"] = [float(v) for v in pred]
        return out

    def explain(self, instances: list[dict[str, Any]]) -> dict[str, Any]:
        """XAI-002 / XAI-003: per-instance SHAP contributions on source features."""
        X = self.frame(instances)
        values, base = shap_values(self.pipeline, ALGORITHMS[self.algorithm], X, self.background, self.problem_type)
        per_feature = aggregate_to_original(values, transformed_feature_names(self.pipeline), self.groups())
        return {
            **self.predict(instances),
            "shap": [{k: float(v) for k, v in row.items()} for row in per_feature.to_dict(orient="records")],
            "base_value": base,
        }


class TrainingService:
    _cache: OrderedDict[tuple[str, str], ModelBundle] = OrderedDict()
    _cache_lock = threading.Lock()
    CACHE_SIZE = 32

    def __init__(self, state: AppState):
        self.state = state

    # -- experiments -----------------------------------------------------------------------
    def create_experiment(
        self, tenant_id: str, actor: str, *, name: str, dataset_id: str, dataset_version: int | None, config: TrainingConfig
    ) -> ExperimentOut:
        record = self.state.store.get(tenant_id, dataset_id, dataset_version)
        frame_cols = [f.name for f in record.schema_.entities[0].fields] if record.schema_ and record.schema_.entities else None
        if frame_cols is not None and config.target not in frame_cols:
            raise ValueError(f"target {config.target!r} is not a column of the dataset")
        with self.state.db.session(tenant_id) as s:
            exp = Experiment(
                tenant_id=tenant_id,
                name=name,
                dataset_id=dataset_id,
                dataset_version=record.version,
                config=config.model_dump(mode="json"),
                created_by=actor,
            )
            s.add(exp)
            s.flush()
            out = ExperimentOut.of(exp)
        self.state.audit.record(tenant_id, actor, "experiment.create", experiment_id=out.id, dataset_id=dataset_id, version=record.version)
        return out

    def get_experiment(self, tenant_id: str, experiment_id: str) -> tuple[ExperimentOut, list[RunOut]]:
        with self.state.db.session(tenant_id) as s:
            exp = s.get(Experiment, experiment_id)
            if exp is None or exp.tenant_id != tenant_id:
                raise NotFound(experiment_id)
            runs = s.execute(select(Run).where(Run.experiment_id == experiment_id).order_by(Run.created_at)).scalars()
            return ExperimentOut.of(exp), [RunOut.of(r, with_artifacts=False) for r in runs]

    def list_experiments(self, tenant_id: str) -> list[ExperimentOut]:
        with self.state.db.session(tenant_id) as s:
            rows = s.execute(select(Experiment).where(Experiment.tenant_id == tenant_id).order_by(Experiment.created_at.desc())).scalars()
            return [ExperimentOut.of(e) for e in rows]

    def get_run(self, tenant_id: str, run_id: str) -> RunOut:
        with self.state.db.session(tenant_id) as s:
            run = s.get(Run, run_id)
            if run is None or run.tenant_id != tenant_id:
                raise NotFound(run_id)
            return RunOut.of(run)

    # -- training (job) ----------------------------------------------------------------------
    def run_experiment(self, tenant_id: str, actor: str, experiment_id: str, job_id: str | None = None, progress=None) -> dict[str, Any]:
        with self.state.db.session(tenant_id) as s:
            exp = s.get(Experiment, experiment_id)
            if exp is None or exp.tenant_id != tenant_id:
                raise NotFound(experiment_id)
            config = TrainingConfig.model_validate(exp.config)
            dataset_id, version = exp.dataset_id, exp.dataset_version
        record = self.state.store.get(tenant_id, dataset_id, version)
        frame = load_table(self.state.store, record)
        if progress:
            progress(0.02, f"loaded {len(frame):,} rows")
        result = train(frame, config, record.schema_, progress=progress)
        run_ids = []
        for i, res in enumerate(result.results):
            artifacts = dict(res.artifacts)
            artifacts["leaderboard"] = res.trials
            artifacts["is_best"] = i == result.best_index
            artifacts["warnings"] = result.warnings
            with self.state.db.session(tenant_id) as s:
                run = Run(
                    tenant_id=tenant_id,
                    experiment_id=experiment_id,
                    job_id=job_id,
                    status="succeeded",
                    algorithm=res.algorithm,
                    params=jsonable(res.params),
                    metrics=jsonable({**res.metrics, "problem_type": result.problem_type}),
                    artifacts=jsonable(artifacts),
                    code_version=CODE_VERSION,
                    duration_seconds=res.duration_seconds,
                )
                s.add(run)
                s.flush()
                run_id = run.id
            key = f"models/runs/{run_id}/model.joblib"
            buf = io.BytesIO()
            # Platform-trained artifacts only; stored encrypted with the tenant key (MDL-NFR-004, SEC-010).
            joblib.dump(
                {"pipeline": res.pipeline, "signature": result.signature, "background": result.background, "algorithm": res.algorithm}, buf
            )
            self.state.objects.put_bytes(tenant_id, key, buf.getvalue())
            with self.state.db.session(tenant_id) as s:
                s.get(Run, run_id).model_key = key
            run_ids.append(run_id)
        best = run_ids[result.best_index]
        self.state.audit.record(
            tenant_id,
            actor,
            "experiment.trained",
            experiment_id=experiment_id,
            runs=len(run_ids),
            best_run=best,
            algorithm=result.results[result.best_index].algorithm,
        )
        return {
            "experiment_id": experiment_id,
            "problem_type": result.problem_type,
            "best_run_id": best,
            "run_ids": run_ids,
            "leaderboard": [
                {
                    "run_id": rid,
                    "algorithm": r.algorithm,
                    "cv_score": r.cv_score,
                    "test": {k: v for k, v in r.metrics.items() if isinstance(v, (int, float))},
                }
                for rid, r in zip(run_ids, result.results)
            ],
            "warnings": result.warnings,
        }

    # -- artifacts -------------------------------------------------------------------------------
    def load_bundle(self, tenant_id: str, run_id: str) -> ModelBundle:
        key = (tenant_id, run_id)
        with self._cache_lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
        run = self.get_run(tenant_id, run_id)
        with self.state.db.session(tenant_id) as s:
            model_key = s.get(Run, run_id).model_key
        if not model_key:
            raise NotFound(f"run {run.id} has no model artifact")
        raw = joblib.load(io.BytesIO(self.state.objects.get_bytes(tenant_id, model_key)))
        bundle = ModelBundle(raw["pipeline"], raw["signature"], raw["background"], raw["algorithm"])
        with self._cache_lock:
            self._cache[key] = bundle
            while len(self._cache) > self.CACHE_SIZE:
                self._cache.popitem(last=False)
        return bundle

    # -- registry (EXP-008) ------------------------------------------------------------------------
    def register(self, tenant_id: str, actor: str, *, name: str, run_id: str, description: str | None = None) -> dict[str, Any]:
        run = self.get_run(tenant_id, run_id)
        bundle = self.load_bundle(tenant_id, run_id)
        with self.state.db.session(tenant_id) as s:
            model = s.execute(
                select(RegisteredModel).where(RegisteredModel.tenant_id == tenant_id, RegisteredModel.name == name)
            ).scalar_one_or_none()
            if model is None:
                model = RegisteredModel(tenant_id=tenant_id, name=name, description=description)
                s.add(model)
                s.flush()
            next_version = (s.execute(select(func.max(ModelVersion.version)).where(ModelVersion.model_id == model.id)).scalar() or 0) + 1
            mv = ModelVersion(
                tenant_id=tenant_id,
                model_id=model.id,
                version=next_version,
                run_id=run_id,
                signature={**bundle.signature, "algorithm": run.algorithm, "metrics": run.metrics},
            )
            s.add(mv)
            s.flush()
            out = {"model_id": model.id, "name": name, "version": next_version, "model_version_id": mv.id, "stage": mv.stage}
        self.state.audit.record(tenant_id, actor, "model.register", **out, run_id=run_id)
        return out

    def list_models(self, tenant_id: str) -> list[dict[str, Any]]:
        with self.state.db.session(tenant_id) as s:
            models = (
                s.execute(select(RegisteredModel).where(RegisteredModel.tenant_id == tenant_id).order_by(RegisteredModel.name))
                .scalars()
                .all()
            )
            out = []
            for m in models:
                versions = (
                    s.execute(select(ModelVersion).where(ModelVersion.model_id == m.id).order_by(ModelVersion.version)).scalars().all()
                )
                out.append(
                    {
                        "id": m.id,
                        "name": m.name,
                        "description": m.description,
                        "latest_version": versions[-1].version if versions else None,
                        "production_version": next((v.version for v in versions if v.stage == "production"), None),
                    }
                )
            return out

    def get_model(self, tenant_id: str, model_id: str) -> dict[str, Any]:
        with self.state.db.session(tenant_id) as s:
            m = s.get(RegisteredModel, model_id)
            if m is None or m.tenant_id != tenant_id:
                raise NotFound(model_id)
            versions = (
                s.execute(select(ModelVersion).where(ModelVersion.model_id == model_id).order_by(ModelVersion.version)).scalars().all()
            )
            return {
                "model": {"id": m.id, "name": m.name, "description": m.description, "created_at": m.created_at},
                "versions": [
                    {
                        "id": v.id,
                        "version": v.version,
                        "stage": v.stage,
                        "run_id": v.run_id,
                        "metrics": v.signature.get("metrics", {}),
                        "algorithm": v.signature.get("algorithm"),
                        "signature": {k: v.signature[k] for k in ("target", "problem_type", "classes", "features") if k in v.signature},
                        "created_at": v.created_at,
                    }
                    for v in versions
                ],
            }

    def set_stage(self, tenant_id: str, actor: str, model_id: str, version: int, stage: str) -> dict[str, Any]:
        if stage not in STAGES:
            raise ValueError(f"stage must be one of {STAGES}")
        with self.state.db.session(tenant_id) as s:
            versions = (
                s.execute(select(ModelVersion).where(ModelVersion.model_id == model_id, ModelVersion.tenant_id == tenant_id))
                .scalars()
                .all()
            )
            target = next((v for v in versions if v.version == version), None)
            if target is None:
                raise NotFound(f"{model_id} v{version}")
            if stage == "production":
                # One production version at a time; the previous one is archived (rollback = promote it again).
                for v in versions:
                    if v.stage == "production" and v.version != version:
                        v.stage = "archived"
            target.stage = stage
        self.state.audit.record(tenant_id, actor, "model.stage", model_id=model_id, version=version, stage=stage)
        return self.get_model(tenant_id, model_id)

    def resolve_version(self, tenant_id: str, model_version_id: str) -> ModelVersion:
        with self.state.db.session(tenant_id) as s:
            mv = s.get(ModelVersion, model_version_id)
            if mv is None or mv.tenant_id != tenant_id:
                raise NotFound(model_version_id)
            s.expunge(mv)
            return mv
