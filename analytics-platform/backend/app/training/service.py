"""Experiments, runs, model artifacts, the model registry and training templates (EXP-001/007/008, MDL-NFR-004/005,
CFG-007)."""

from __future__ import annotations

import io
import logging
import threading
from collections import OrderedDict
from typing import TYPE_CHECKING, Any

import joblib
import numpy as np
import pandas as pd
from pydantic import BaseModel
from sqlalchemy import func, select

from ..datasets_io import load_table
from ..db.models import Experiment, ModelVersion, RegisteredModel, Run, TrainingTemplate
from ..export_utils import jsonable
from .algorithms import get_algorithm
from .local_explain import LIME_MAX_INSTANCES, force_plot, lime_explain
from .trainer import TrainingConfig, aggregate_to_original, shap_values, train, transformed_feature_names

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState

CODE_VERSION = "ap-train-1"
log = logging.getLogger("app.training.service")
STAGES = ("none", "staging", "production", "archived")


class NotFound(LookupError):
    pass


class HoldoutMissing(RuntimeError):
    """The run predates stored test-set predictions (XAI-004)."""


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

    def __init__(self, pipeline, signature: dict[str, Any], background: pd.DataFrame, algorithm: str, reference: dict | None = None):
        self.pipeline = pipeline
        self.signature = signature
        self.background = background
        self.algorithm = algorithm
        self._reference = reference

    @property
    def reference(self) -> dict[str, Any] | None:
        """API-011 reference profile; artifacts from before drift monitoring derive one from the background sample."""
        if self._reference is None and self.problem_type != "forecasting" and len(self.background):
            from .drift_profile import build_reference

            try:
                ref = build_reference(self.background, self.signature, [self.pipeline], 0)
                self._reference = {"rows": ref["rows"], "features": ref["features"], "prediction": ref["predictions"][0]}
            except Exception:  # noqa: BLE001
                self._reference = {"rows": 0, "features": {}, "prediction": None}
        return self._reference

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

    def forecast(self, horizon: int | None = None, history: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        """TRN-007 serving: future timestamps, point forecasts and prediction intervals."""
        from .forecasting import parse_history

        if self.problem_type != "forecasting":
            raise ValueError("this model is not a forecasting model; send instances")
        h = int(horizon or self.signature.get("horizon") or 1)
        if not 1 <= h <= 1000:
            raise ValueError("horizon must be between 1 and 1000")
        recent = parse_history(history, self.signature["time_column"], self.signature["target"]) if history else None
        if recent is not None and len(recent) > 5000:
            raise ValueError("at most 5000 history rows")
        return {"horizon": h, **self.pipeline.forecast(h, recent)}

    def predict(self, instances: list[dict[str, Any]]) -> dict[str, Any]:
        if self.problem_type == "forecasting":
            first = instances[0] if instances else {}
            return self.forecast(first.get("horizon"), first.get("history"))
        X = self.frame(instances)
        out: dict[str, Any] = {}
        pred = self.pipeline.predict(X)
        classes = self.signature.get("classes")
        if self.problem_type == "clustering":
            out["predictions"] = [int(v) for v in pred]  # cluster ids; -1 = DBSCAN noise
        elif self.problem_type == "anomaly":
            # TRN-008: {is_anomaly, score}; higher scores are more anomalous, flagged above the fitted threshold.
            scores = np.asarray(self.pipeline.score_samples(X), dtype=float)
            threshold = float(self.pipeline[-1].threshold_)
            out["predictions"] = [{"is_anomaly": bool(v > threshold), "score": round(float(v), 6)} for v in scores]
            out["threshold"] = round(threshold, 6)
        elif classes:
            out["predictions"] = [jsonable(classes[int(i)]) for i in pred]
            if hasattr(self.pipeline, "predict_proba"):
                out["probabilities"] = np.round(self.pipeline.predict_proba(X), 6).tolist()
                out["classes"] = [jsonable(c) for c in classes]
        else:
            out["predictions"] = [float(v) for v in pred]
        return out

    def explain(self, instances: list[dict[str, Any]]) -> dict[str, Any]:
        """XAI-002 / XAI-002a / XAI-003: per-instance SHAP contributions on source features, SHAP force-plot data and a
        LIME-style local surrogate (first ``LIME_MAX_INSTANCES`` instances)."""
        if self.problem_type in ("clustering", "forecasting", "anomaly"):
            raise ValueError(f"explanations are not available for {self.problem_type} models")
        X = self.frame(instances)
        values, base = shap_values(self.pipeline, get_algorithm(self.algorithm), X, self.background, self.problem_type)
        per_feature = aggregate_to_original(values, transformed_feature_names(self.pipeline), self.groups())
        shap_rows = [{k: float(v) for k, v in row.items()} for row in per_feature.to_dict(orient="records")]
        out = {**self.predict(instances), "shap": shap_rows, "base_value": base}
        out["force_plot"] = [force_plot(base, row, instances[i]) for i, row in enumerate(shap_rows)]
        out["lime"] = self.lime(instances[:LIME_MAX_INSTANCES])
        return out

    def lime(self, instances: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """XAI-002a: weighted linear local surrogates. Classifiers explain the probability of the predicted class."""
        used = [f["name"] for f in self.signature["features"] if f["group"] != "dropped"]
        classes = self.signature.get("classes")
        out = []
        for i, instance in enumerate(instances):
            target_index: int | None = None
            if classes:
                target_index = int(self.pipeline.predict(self.frame([instance]))[0])

            def predict(rows, _t=target_index):
                X = self.frame(rows)
                if _t is not None and hasattr(self.pipeline, "predict_proba"):
                    return self.pipeline.predict_proba(X)[:, _t]
                return self.pipeline.predict(X)

            try:
                result = lime_explain(instance, self.background, used, predict, seed=i)
            except ValueError as exc:
                result = {"error": str(exc)}
            if classes and target_index is not None:
                result["explained_class"] = jsonable(classes[target_index])
            out.append(result)
        return out


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
        if frame_cols is not None and config.target and config.target not in frame_cols:
            raise ValueError(f"target {config.target!r} is not a column of the dataset")
        if frame_cols is not None and config.forecast and config.forecast.time_column not in frame_cols:
            raise ValueError(f"time column {config.forecast.time_column!r} is not a column of the dataset")
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
            reference = None
            if result.reference is not None:
                preds = result.reference.get("predictions") or []
                reference = {
                    "rows": result.reference.get("rows"),
                    "features": result.reference.get("features") or {},
                    "prediction": preds[i] if i < len(preds) else None,
                }
            joblib.dump(
                {
                    "pipeline": res.pipeline,
                    "signature": result.signature,
                    "background": result.background,
                    "algorithm": res.algorithm,
                    "reference": reference,
                },
                buf,
            )
            self.state.objects.put_bytes(tenant_id, key, buf.getvalue())
            holdout_attributes = self._save_holdout(tenant_id, run_id, result, res)
            with self.state.db.session(tenant_id) as s:
                run = s.get(Run, run_id)
                run.model_key = key
                if holdout_attributes is not None:
                    run.artifacts = {**run.artifacts, "fairness_attributes": holdout_attributes}
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

    def _save_holdout(self, tenant_id: str, run_id: str, result, res) -> list[str] | None:
        """XAI-004: persist the held-out labels, this run's predictions and candidate protected attributes."""
        holdout = result.holdout
        if not holdout or res.holdout_predictions is None:
            return None
        attrs = holdout["attributes"]
        table = pd.DataFrame({f"a:{c}": attrs[c].to_numpy() for c in attrs.columns})
        table["__row"] = np.asarray(holdout["rows"], dtype=int)
        table["__y_true"] = np.asarray(holdout["y_true"], dtype=int)
        table["__y_pred"] = np.asarray(res.holdout_predictions, dtype=int)
        buf = io.BytesIO()
        try:
            for c in table.columns:
                if table[c].dtype == object:
                    table[c] = table[c].astype(object).where(table[c].notna(), None).map(lambda v: v if v is None else str(v))
            table.to_parquet(buf, index=False)
        except Exception as exc:  # noqa: BLE001 - fairness data is best-effort
            log.warning("holdout artifact for run %s failed: %s", run_id, exc)
            return None
        self.state.objects.put_bytes(tenant_id, f"models/runs/{run_id}/holdout.parquet", buf.getvalue())
        return list(attrs.columns)

    def fairness(
        self,
        tenant_id: str,
        actor: str,
        run_id: str,
        protected: list[str],
        positive_class: Any = None,
        min_group_size: int = 10,
    ) -> dict[str, Any]:
        """XAI-004: group fairness metrics of a classification run on its held-out test set.

        Attributes come from the stored holdout artifact; any other dataset column (e.g. a PII column not kept at
        training time) is read from the run's dataset version by row position.
        """
        from ..storage.datasets import DatasetNotFound
        from .fairness import fairness_report

        run = self.get_run(tenant_id, run_id)
        problem = run.metrics.get("problem_type")
        if problem not in ("binary", "multiclass"):
            raise ValueError("fairness analysis needs a classification run")
        with self.state.db.session(tenant_id) as s:
            exp = s.get(Experiment, run.experiment_id)
            dataset_id, version, config = exp.dataset_id, exp.dataset_version, dict(exp.config)
        try:
            raw = self.state.objects.get_bytes(tenant_id, f"models/runs/{run_id}/holdout.parquet")
        except LookupError as exc:
            raise HoldoutMissing("this run has no stored test-set predictions; retrain it to enable fairness analysis") from exc
        table = pd.read_parquet(io.BytesIO(raw))
        attributes = pd.DataFrame({c[2:]: table[c] for c in table.columns if c.startswith("a:")})
        missing = [p for p in protected if p not in attributes.columns]
        if missing:
            try:
                record = self.state.store.get(tenant_id, dataset_id, version)
                frame = load_table(self.state.store, record)
            except DatasetNotFound as exc:
                raise ValueError(f"attributes {missing} were not stored with the run and its dataset is gone") from exc
            unknown = [p for p in missing if p not in frame.columns]
            if unknown:
                raise ValueError(f"protected attributes must be dataset columns; unknown: {', '.join(unknown)}")
            target = config.get("target")
            if target in frame.columns:
                frame = frame[frame[target].notna()].reset_index(drop=True)
            rows = table["__row"].to_numpy()
            if len(frame) <= int(rows.max(initial=0)):
                raise ValueError("the dataset no longer matches the run's test rows")
            for p in missing:
                attributes[p] = frame[p].iloc[rows].reset_index(drop=True)
        if config.get("target") in protected:
            raise ValueError("the target can't be a protected attribute")
        classes = run.metrics.get("classes") or self.load_bundle(tenant_id, run_id).signature.get("classes") or []
        if positive_class is None:
            if problem == "binary":
                positive_index = 1
            else:
                counts = np.bincount(table["__y_true"].to_numpy(), minlength=len(classes))
                positive_index = int(np.argmin(np.where(counts > 0, counts, np.iinfo(np.int64).max)))
        else:
            lookup = {str(c): i for i, c in enumerate(classes)}
            if str(positive_class) not in lookup:
                raise ValueError(f"positive_class must be one of {classes}")
            positive_index = lookup[str(positive_class)]
        reports = fairness_report(
            table["__y_true"].to_numpy(),
            table["__y_pred"].to_numpy(),
            attributes,
            protected,
            positive_index,
            min_group_size=min_group_size,
        )
        self.state.audit.record(tenant_id, actor, "model.fairness", run_id=run_id, protected=protected)
        return {
            "run_id": run_id,
            "positive_class": jsonable(classes[positive_index]) if classes else positive_index,
            "n_test": int(len(table)),
            "min_group_size": min_group_size,
            "attributes": reports,
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
        if model_key.endswith(".onnx"):
            # TRN-010 / SEC-010: uploaded models are ONNX + Parquet only; they never go through joblib.
            from .custom_models import load_uploaded

            bundle = load_uploaded(self.state, tenant_id, model_key, run.artifacts)
        else:
            raw = joblib.load(io.BytesIO(self.state.objects.get_bytes(tenant_id, model_key)))
            bundle = ModelBundle(raw["pipeline"], raw["signature"], raw["background"], raw["algorithm"], raw.get("reference"))
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
                # API-011: the training reference profile travels with the version for drift monitoring.
                signature=jsonable(
                    {**bundle.signature, "algorithm": run.algorithm, "metrics": run.metrics, "reference_profile": bundle.reference}
                ),
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
                        "signature": {
                            k: v.signature[k]
                            for k in (
                                "target",
                                "problem_type",
                                "classes",
                                "features",
                                "time_column",
                                "frequency",
                                "horizon",
                                "label_column",
                                "positive_label",
                                "source",
                            )
                            if k in v.signature
                        },
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

    # -- ONNX export (MDL-NFR-004) ---------------------------------------------------------------------
    def export_onnx(self, tenant_id: str, actor: str, run_id: str) -> bytes:
        from .onnx_export import export_onnx

        bundle = self.load_bundle(tenant_id, run_id)
        if bundle.algorithm == "onnx_upload":  # TRN-010: an uploaded model downloads as the file that was uploaded
            with self.state.db.session(tenant_id) as s:
                data = self.state.objects.get_bytes(tenant_id, s.get(Run, run_id).model_key)
        else:
            data = export_onnx(bundle.pipeline, bundle.signature, bundle.algorithm)
        self.state.audit.record(tenant_id, actor, "model.export_onnx", run_id=run_id, bytes=len(data))
        return data


# -- training configuration templates (CFG-007) ----------------------------------------------------------------

_PLACEHOLDER_TARGET = "__template_target__"


class TemplateConflict(ValueError):
    pass


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in override.items():
        out[key] = deep_merge(out[key], value) if isinstance(value, dict) and isinstance(out.get(key), dict) else value
    return out


def validate_template_config(config: dict[str, Any]) -> dict[str, Any]:
    """A template may leave out the target (it is dataset-specific); everything else must be a valid TrainingConfig."""
    probe = dict(config)
    if not probe.get("target") and probe.get("problem_type") != "clustering":
        probe["target"] = _PLACEHOLDER_TARGET
    TrainingConfig.model_validate(probe)
    return config


def _template_out(t: TrainingTemplate) -> dict[str, Any]:
    return {
        "id": t.id,
        "name": t.name,
        "description": t.description,
        "config": t.config,
        "created_by": t.created_by,
        "created_at": t.created_at,
    }


class TemplateService:
    """CFG-007: save named TrainingConfig templates per tenant, list them and apply them to a dataset."""

    def __init__(self, state: AppState):
        self.state = state

    def create(self, tenant_id: str, actor: str, *, name: str, description: str | None, config: dict[str, Any]) -> dict[str, Any]:
        config = validate_template_config(config)
        with self.state.db.session(tenant_id) as s:
            exists = s.execute(
                select(TrainingTemplate).where(TrainingTemplate.tenant_id == tenant_id, TrainingTemplate.name == name)
            ).scalar_one_or_none()
            if exists is not None:
                raise TemplateConflict(f"template {name!r} already exists")
            t = TrainingTemplate(tenant_id=tenant_id, name=name, description=description, config=config, created_by=actor)
            s.add(t)
            s.flush()
            out = _template_out(t)
        self.state.audit.record(tenant_id, actor, "training_template.create", template_id=out["id"], name=name)
        return out

    def list(self, tenant_id: str) -> list[dict[str, Any]]:
        with self.state.db.session(tenant_id) as s:
            rows = s.execute(select(TrainingTemplate).where(TrainingTemplate.tenant_id == tenant_id).order_by(TrainingTemplate.name))
            return [_template_out(t) for t in rows.scalars()]

    def get(self, tenant_id: str, template_id: str) -> dict[str, Any]:
        with self.state.db.session(tenant_id) as s:
            t = s.get(TrainingTemplate, template_id)
            if t is None or t.tenant_id != tenant_id:
                raise NotFound(template_id)
            return _template_out(t)

    def update(self, tenant_id: str, actor: str, template_id: str, *, description: str | None, config: dict[str, Any] | None) -> dict:
        if config is not None:
            validate_template_config(config)
        with self.state.db.session(tenant_id) as s:
            t = s.get(TrainingTemplate, template_id)
            if t is None or t.tenant_id != tenant_id:
                raise NotFound(template_id)
            if description is not None:
                t.description = description
            if config is not None:
                t.config = config
            out = _template_out(t)
        self.state.audit.record(tenant_id, actor, "training_template.update", template_id=template_id)
        return out

    def delete(self, tenant_id: str, actor: str, template_id: str) -> None:
        with self.state.db.session(tenant_id) as s:
            t = s.get(TrainingTemplate, template_id)
            if t is None or t.tenant_id != tenant_id:
                raise NotFound(template_id)
            s.delete(t)
        self.state.audit.record(tenant_id, actor, "training_template.delete", template_id=template_id)

    def resolve(self, tenant_id: str, template_id: str, overrides: dict[str, Any]) -> TrainingConfig:
        """The template's config with ``overrides`` deep-merged on top (the target usually comes from the overrides)."""
        template = self.get(tenant_id, template_id)
        return TrainingConfig.model_validate(deep_merge(template["config"], overrides))
