"""Custom model upload (TRN-010) in safe formats only (SEC-010).

Only **ONNX** files are accepted. They are parsed as protobuf (never unpickled), checked with ``onnx.checker``,
refused when they reference external data files or custom operator domains, loaded in onnxruntime and dry-run on a
synthetic row built from the declared signature. Pickle / joblib payloads are rejected outright.

An uploaded model becomes an ordinary registry version: it gets a run (algorithm ``onnx_upload``) whose artifact is
the ONNX file itself plus a Parquet background sample, and :class:`UploadedBundle` adapts it to the ``ModelBundle``
interface, so the normal endpoint, batch, drift and explanation paths serve it.

Signature (JSON)::

    {"problem_type": "binary" | "multiclass" | "regression",
     "target": "churn", "classes": ["no", "yes"],
     "features": [{"name": "age", "type": "number", "min": 18, "max": 90},
                  {"name": "plan", "type": "string", "categories": ["basic", "pro"]}],
     "input": "auto" | "per_feature" | "tensor",
     "outputs": {"label": "label", "probabilities": "probabilities", "value": "variable"}}

Inputs are either one ``[N, 1]`` tensor per feature named after it (``per_feature``, what the platform's own ONNX
export produces) or a single numeric ``[N, F]`` tensor with the features in signature order (``tensor``).
Classifier labels may be class values or class indices.
"""

from __future__ import annotations

import hashlib
import io
import logging
import warnings
from typing import TYPE_CHECKING, Any, Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field, model_validator

from ..export_utils import jsonable
from .local_explain import LIME_MAX_INSTANCES, force_plot
from .service import ModelBundle

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState

log = logging.getLogger("app.training.custom_models")

MAX_UPLOAD_BYTES = 200 * 1024 * 1024
ALGORITHM_ID = "onnx_upload"
ALLOWED_DOMAINS = {"", "ai.onnx", "ai.onnx.ml"}
BACKGROUND_ROWS = 100
KERNEL_BACKGROUND = 20


class UploadRejected(ValueError):
    """The upload is not an acceptable model; the message says why."""


class UploadFeature(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: Literal["number", "integer", "string", "boolean"] = "number"
    categories: list[str] | None = Field(default=None, max_length=1000)
    min: float | None = None
    max: float | None = None


class UploadOutputs(BaseModel):
    label: str | None = None
    probabilities: str | None = None
    value: str | None = None


class UploadSignature(BaseModel):
    problem_type: Literal["binary", "multiclass", "regression"]
    target: str | None = Field(default=None, max_length=200)
    classes: list[Any] | None = Field(default=None, max_length=1000)
    features: list[UploadFeature] = Field(min_length=1, max_length=2000)
    input: Literal["auto", "per_feature", "tensor"] = "auto"
    outputs: UploadOutputs = Field(default_factory=UploadOutputs)

    @model_validator(mode="after")
    def _check(self) -> UploadSignature:
        names = [f.name for f in self.features]
        if len(set(names)) != len(names):
            raise ValueError("feature names must be unique")
        if self.problem_type == "regression":
            if self.classes:
                raise ValueError("regression models have no classes")
        else:
            if not self.classes or len(self.classes) < 2:
                raise ValueError("classification models need classes (at least two)")
            if self.problem_type == "binary" and len(self.classes) != 2:
                raise ValueError("binary models need exactly two classes")
            if len({str(c) for c in self.classes}) != len(self.classes):
                raise ValueError("class values must be unique")
        return self

    def bundle_signature(self) -> dict[str, Any]:
        """The ``ModelBundle`` signature: numeric features are ``numeric``, strings / booleans ``categorical``."""
        features = []
        for f in self.features:
            if f.type in ("number", "integer"):
                entry: dict[str, Any] = {"name": f.name, "dtype": "float64" if f.type == "number" else "int64", "group": "numeric"}
                entry.update(min=f.min, max=f.max)
            else:
                entry = {"name": f.name, "dtype": "bool" if f.type == "boolean" else "object", "group": "categorical"}
                if f.categories:
                    entry["categories"] = [str(c) for c in f.categories][:100]
            features.append({**entry, "pii": False})
        return {
            "target": self.target,
            "problem_type": self.problem_type,
            "classes": list(self.classes) if self.classes else None,
            "features": features,
            "source": "upload",
        }


# -- validation ------------------------------------------------------------------------------------------------------


def _subgraphs(graph) -> list:
    out = [graph]
    for node in graph.node:
        for attr in node.attribute:
            if attr.g is not None and attr.HasField("g"):
                out += _subgraphs(attr.g)
            for g in attr.graphs:
                out += _subgraphs(g)
    return out


def validate_onnx(data: bytes) -> Any:
    """Parse and check ONNX bytes; raise :class:`UploadRejected` for anything unsafe or malformed."""
    import onnx

    if not data:
        raise UploadRejected("the file is empty")
    if len(data) > MAX_UPLOAD_BYTES:
        raise UploadRejected(f"the file exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
    if data[:1] == b"\x80" and len(data) > 1 and data[1] <= 5:
        raise UploadRejected("pickle / joblib files are never accepted (SEC-010); export the model to ONNX")
    if data[:2] == b"PK":
        raise UploadRejected("zip archives (skops, joblib bundles) are not accepted here; upload an ONNX file")
    try:
        model = onnx.load_model_from_string(data)
    except Exception as exc:  # noqa: BLE001 - any parse error means "not ONNX"
        raise UploadRejected(f"not a valid ONNX model: {type(exc).__name__}") from exc
    if not model.graph.node:
        raise UploadRejected("not a valid ONNX model: the graph has no nodes")
    for graph in _subgraphs(model.graph):
        for tensor in graph.initializer:
            if tensor.data_location == onnx.TensorProto.EXTERNAL or tensor.external_data:
                raise UploadRejected("models with external data files are not accepted; embed the weights in the ONNX file")
        for node in graph.node:
            if node.domain not in ALLOWED_DOMAINS:
                raise UploadRejected(f"custom operator domain {node.domain!r} is not allowed")
    for opset in model.opset_import:
        if opset.domain not in ALLOWED_DOMAINS:
            raise UploadRejected(f"custom operator set {opset.domain!r} is not allowed")
    try:
        onnx.checker.check_model(model)
    except Exception as exc:  # noqa: BLE001
        raise UploadRejected(f"ONNX checker failed: {str(exc)[:300]}") from exc
    return model


# -- runtime adapter ------------------------------------------------------------------------------------------------


def _session(data: bytes):
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    return ort.InferenceSession(data, sess_options=options, providers=["CPUExecutionProvider"])


_NUMPY_TYPES = {
    "tensor(float)": np.float32,
    "tensor(double)": np.float64,
    "tensor(int64)": np.int64,
    "tensor(int32)": np.int32,
    "tensor(bool)": np.bool_,
}


class OnnxPipeline:
    """``predict`` (class indices / values) over an onnxruntime session; see :class:`OnnxProbaPipeline`."""

    def __init__(self, data: bytes, signature: dict[str, Any], input_mode: str = "auto", outputs: dict[str, str | None] | None = None):
        self.signature = signature
        self.session = _session(data)
        self.features = [f["name"] for f in signature["features"]]
        self.classes = signature.get("classes")
        inputs = self.session.get_inputs()
        names = [i.name for i in inputs]
        if input_mode == "auto":
            if set(names) == set(self.features):
                input_mode = "per_feature"
            elif len(inputs) == 1:
                input_mode = "tensor"
            else:
                raise UploadRejected(
                    f"model inputs {names} don't match the signature features; use one input per feature or one [N, F] tensor"
                )
        if input_mode == "per_feature" and set(names) != set(self.features):
            raise UploadRejected(f"per-feature inputs must be named after the features; the model has {names}")
        if input_mode == "tensor":
            if len(inputs) != 1:
                raise UploadRejected("tensor input mode needs exactly one model input")
            if inputs[0].type not in ("tensor(float)", "tensor(double)"):
                raise UploadRejected(f"the tensor input must be float or double, not {inputs[0].type}")
            width = inputs[0].shape[-1] if inputs[0].shape else None
            if isinstance(width, int) and width != len(self.features):
                raise UploadRejected(f"the model's input has {width} columns but the signature declares {len(self.features)} features")
            if any(f["group"] != "numeric" and f["dtype"] != "bool" for f in signature["features"]):
                raise UploadRejected("tensor input mode supports numeric and boolean features only")
        self.input_mode = input_mode
        self.inputs = {i.name: i.type for i in inputs}
        out_names = [o.name for o in self.session.get_outputs()]
        wanted = outputs or {}
        if self.classes:
            self.label_output = wanted.get("label") or next((n for n in out_names if "label" in n.lower()), out_names[0])
            self.proba_output = wanted.get("probabilities") or next(
                (n for n in out_names if "prob" in n.lower() and n != self.label_output), None
            )
            if self.proba_output is None and len(out_names) > 1 and not wanted.get("label"):
                self.proba_output = next(n for n in out_names if n != self.label_output)
        else:
            self.label_output = wanted.get("value") or out_names[0]
            self.proba_output = None
        for name in (self.label_output, self.proba_output):
            if name is not None and name not in out_names:
                raise UploadRejected(f"output {name!r} is not an output of the model ({out_names})")

    def _feed(self, X: pd.DataFrame) -> dict[str, np.ndarray]:
        if self.input_mode == "tensor":
            ((name, typ),) = self.inputs.items()
            cols = [
                pd.to_numeric(X[f].astype(object).replace({True: 1, False: 0}), errors="coerce").to_numpy(dtype=float)
                for f in self.features
            ]
            return {name: np.column_stack(cols).astype(_NUMPY_TYPES[typ])}
        feed = {}
        for name, typ in self.inputs.items():
            s = X[name]
            if typ == "tensor(string)":
                arr = s.astype(object).where(s.notna(), "").astype(str).to_numpy(dtype=object)
            elif typ in ("tensor(int64)", "tensor(int32)"):
                arr = pd.to_numeric(s, errors="coerce").fillna(0).to_numpy().astype(_NUMPY_TYPES[typ])
            elif typ == "tensor(bool)":
                arr = s.fillna(False).astype(bool).to_numpy()
            elif typ in _NUMPY_TYPES:
                arr = (
                    pd.to_numeric(s.astype(object).replace({True: 1, False: 0}), errors="coerce")
                    .to_numpy(dtype=float)
                    .astype(_NUMPY_TYPES[typ])
                )
            else:
                raise UploadRejected(f"unsupported input type {typ} for {name!r}")
            feed[name] = arr.reshape(-1, 1)
        return feed

    def _run(self, X: pd.DataFrame, names: list[str]) -> list[Any]:
        return self.session.run(names, self._feed(X))

    def _to_index(self, labels: Any) -> np.ndarray:
        values = np.asarray(labels).reshape(-1)
        lookup = {str(c): i for i, c in enumerate(self.classes)}
        as_str = [str(v.decode() if isinstance(v, bytes) else v) for v in values]
        if all(v in lookup for v in as_str):
            return np.array([lookup[v] for v in as_str], dtype=int)
        try:
            ints = values.astype(float)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"model returned labels outside the declared classes: {sorted(set(as_str))[:5]}") from exc
        if np.all(ints == np.round(ints)) and np.all((ints >= 0) & (ints < len(self.classes))):
            return ints.astype(int)
        raise ValueError(f"model returned labels outside the declared classes: {sorted(set(as_str))[:5]}")

    def _proba_matrix(self, raw: Any, n: int) -> np.ndarray:
        if isinstance(raw, list) and raw and isinstance(raw[0], dict):  # ZipMap output: [{class: p}, ...]
            keys = list(raw[0].keys())
            lookup = {str(c): i for i, c in enumerate(self.classes)}
            order = [next((k for k in keys if str(k) == str(c)), None) for c in self.classes]
            if any(o is None for o in order):
                order = [k for k in keys if isinstance(k, (int, np.integer))] if len(keys) == len(self.classes) else order
            if any(o is None for o in order) or not lookup:
                raise ValueError("probability output keys don't match the declared classes")
            return np.array([[row[k] for k in order] for row in raw], dtype=float)
        arr = np.asarray(raw, dtype=float).reshape(n, -1)
        if arr.shape[1] == 1 and len(self.classes) == 2:
            arr = np.column_stack([1 - arr[:, 0], arr[:, 0]])
        if arr.shape[1] != len(self.classes):
            raise ValueError(f"probability output has {arr.shape[1]} columns but there are {len(self.classes)} classes")
        return arr

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        (out,) = self._run(X, [self.label_output])
        if self.classes:
            return self._to_index(out)
        return np.asarray(out, dtype=float).reshape(len(X), -1)[:, 0]


class OnnxProbaPipeline(OnnxPipeline):
    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        (out,) = self._run(X, [self.proba_output])
        return self._proba_matrix(out, len(X))


def build_pipeline(data: bytes, signature: dict[str, Any], input_mode: str = "auto", outputs: dict | None = None) -> OnnxPipeline:
    probe = OnnxPipeline(data, signature, input_mode, outputs)
    if probe.proba_output is not None:
        pipe = OnnxProbaPipeline.__new__(OnnxProbaPipeline)
        pipe.__dict__.update(probe.__dict__)
        return pipe
    return probe


def synthetic_frame(signature: dict[str, Any], n: int, seed: int = 0) -> pd.DataFrame:
    """Rows drawn from the signature: numbers in [min, max] (row 0 is the midpoint), categories, booleans."""
    rng = np.random.default_rng(seed)
    out: dict[str, Any] = {}
    for f in signature["features"]:
        if f["group"] == "numeric":
            lo = f.get("min") if f.get("min") is not None else (f["max"] - 1 if f.get("max") is not None else -1.0)
            hi = f.get("max") if f.get("max") is not None else lo + 2.0
            values = rng.uniform(lo, hi, n)
            values[0] = (lo + hi) / 2
            out[f["name"]] = np.round(values) if f["dtype"] == "int64" else values
        elif f["dtype"] == "bool":
            out[f["name"]] = rng.random(n) < 0.5
        else:
            cats = f.get("categories") or ["a"]
            out[f["name"]] = [cats[i] for i in rng.integers(0, len(cats), n)]
            out[f["name"]][0] = cats[0]
    return pd.DataFrame(out)


# -- bundle adapter ---------------------------------------------------------------------------------------------------


class UploadedBundle(ModelBundle):
    """A ``ModelBundle`` over an uploaded ONNX model. Explanations use SHAP's model-agnostic KernelExplainer on a
    small background sample (categoricals are label-coded for the explainer)."""

    def explain(self, instances: list[dict[str, Any]]) -> dict[str, Any]:
        import shap

        X = self.frame(instances)
        names = self.feature_names
        cats = {
            f["name"]: list(pd.unique(pd.concat([self.background[f["name"]], X[f["name"]]]).astype(str)))
            for f in self.signature["features"]
            if f["group"] != "numeric"
        }

        def encode(frame: pd.DataFrame) -> np.ndarray:
            cols = []
            for c in names:
                if c in cats:
                    cols.append(frame[c].astype(str).map({v: i for i, v in enumerate(cats[c])}).fillna(0).to_numpy(dtype=float))
                else:
                    cols.append(pd.to_numeric(frame[c], errors="coerce").to_numpy(dtype=float))
            return np.column_stack(cols)

        def decode(Z: np.ndarray) -> pd.DataFrame:
            data_ = {}
            for j, c in enumerate(names):
                if c in cats:
                    idx = np.clip(np.round(Z[:, j]).astype(int), 0, len(cats[c]) - 1)
                    data_[c] = [cats[c][i] for i in idx]
                else:
                    data_[c] = Z[:, j]
            return self.frame(pd.DataFrame(data_).to_dict(orient="records"))

        classes = self.signature.get("classes")
        positive = len(classes) - 1 if classes else None

        def f(Z: np.ndarray) -> np.ndarray:
            frame = decode(Z)
            if classes and hasattr(self.pipeline, "predict_proba"):
                return self.pipeline.predict_proba(frame)[:, positive]
            return np.asarray(self.pipeline.predict(frame), dtype=float)

        bg = encode(self.background.head(KERNEL_BACKGROUND))
        bg = np.where(np.isnan(bg), np.nanmedian(bg, axis=0), bg)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            explainer = shap.KernelExplainer(f, bg)
            values = np.asarray(explainer.shap_values(encode(X), nsamples=min(200, 2 * len(names) + 64), silent=True))
        base = float(np.asarray(explainer.expected_value).reshape(-1)[0])
        shap_rows = [{n: float(v) for n, v in zip(names, row)} for row in values.reshape(len(X), len(names))]
        out = {**self.predict(instances), "shap": shap_rows, "base_value": base}
        out["force_plot"] = [force_plot(base, row, instances[i]) for i, row in enumerate(shap_rows)]
        out["lime"] = self.lime(instances[:LIME_MAX_INSTANCES])
        return out


def uploaded_bundle(data: bytes, meta: dict[str, Any], background: pd.DataFrame, reference: dict | None = None) -> UploadedBundle:
    pipeline = build_pipeline(data, meta["signature"], meta.get("input_mode", "auto"), meta.get("outputs"))
    return UploadedBundle(pipeline, meta["signature"], background, ALGORITHM_ID, reference)


# -- service ----------------------------------------------------------------------------------------------------------


class CustomModelService:
    def __init__(self, state: AppState):
        self.state = state

    def upload(
        self,
        tenant_id: str,
        actor: str,
        *,
        name: str,
        description: str | None,
        data: bytes,
        signature: UploadSignature,
        dataset_id: str | None = None,
        project_id: str | None = None,
        filename: str | None = None,
    ) -> dict[str, Any]:
        from ..datasets_io import load_table
        from ..db.models import Experiment, Run
        from ..projects import default_project_id
        from .drift_profile import build_reference
        from .service import TrainingService

        validate_onnx(data)
        sig = signature.bundle_signature()
        outputs = signature.outputs.model_dump()
        try:
            pipeline = build_pipeline(data, sig, signature.input, outputs)
        except UploadRejected:
            raise
        except Exception as exc:  # noqa: BLE001 - onnxruntime refuses the graph
            raise UploadRejected(f"onnxruntime could not load the model: {str(exc)[:300]}") from exc
        # Dry inference on a synthetic row built from the signature.
        probe = synthetic_frame(sig, 1)
        try:
            pred = pipeline.predict(probe)
            if len(np.asarray(pred).reshape(-1)) != 1:
                raise ValueError("the model must return one prediction per row")
            if hasattr(pipeline, "predict_proba"):
                proba = pipeline.predict_proba(probe)
                if proba.shape != (1, len(sig["classes"])):
                    raise ValueError(f"probabilities have shape {proba.shape}")
        except Exception as exc:  # noqa: BLE001
            raise UploadRejected(f"dry inference on a synthetic row failed: {str(exc)[:300]}") from exc
        # Reference / background data: the given dataset, or synthetic rows saved as a small reference dataset.
        if dataset_id:
            record = self.state.store.get(tenant_id, dataset_id)
            frame = load_table(self.state.store, record)
            missing = [f["name"] for f in sig["features"] if f["name"] not in frame.columns]
            if missing:
                raise UploadRejected(f"the reference dataset lacks the features {missing[:10]}")
            background = frame[[f["name"] for f in sig["features"]]].sample(min(BACKGROUND_ROWS, len(frame)), random_state=0)
        else:
            background = synthetic_frame(sig, BACKGROUND_ROWS)
            record = self.state.store.save_frames(
                tenant_id,
                actor,
                f"{name} (uploaded model reference)",
                {"reference": background},
                None,
                source="model_upload",
                project_id=project_id or default_project_id(self.state, tenant_id),
            )
        background = background.reset_index(drop=True)
        try:
            pipeline.predict(background.head(20))
        except Exception as exc:  # noqa: BLE001
            raise UploadRejected(f"inference on the reference data failed: {str(exc)[:300]}") from exc
        sha = hashlib.sha256(data).hexdigest()
        meta = {"signature": sig, "input_mode": pipeline.input_mode, "outputs": outputs, "sha256": sha, "bytes": len(data)}
        with self.state.db.session(tenant_id) as s:
            exp = Experiment(
                tenant_id=tenant_id,
                name=f"upload: {name}",
                dataset_id=record.id,
                dataset_version=record.version,
                config={"source": "upload", "problem_type": sig["problem_type"], "target": sig["target"]},
                created_by=actor,
            )
            s.add(exp)
            s.flush()
            run = Run(
                tenant_id=tenant_id,
                experiment_id=exp.id,
                status="succeeded",
                algorithm=ALGORITHM_ID,
                params={"sha256": sha, "bytes": len(data), "input_mode": pipeline.input_mode, "filename": filename},
                metrics={"problem_type": sig["problem_type"]},
                artifacts=jsonable({"is_best": True, "warnings": [], "upload": meta}),
                code_version="ap-upload-1",
                duration_seconds=0.0,
            )
            s.add(run)
            s.flush()
            run_id = run.id
        model_key = f"models/runs/{run_id}/model.onnx"
        self.state.objects.put_bytes(tenant_id, model_key, data)
        buf = io.BytesIO()
        background.to_parquet(buf, index=False)
        self.state.objects.put_bytes(tenant_id, f"models/runs/{run_id}/background.parquet", buf.getvalue())
        try:
            ref = build_reference(background, sig, [pipeline], 0)
            reference = {"rows": ref["rows"], "features": ref["features"], "prediction": ref["predictions"][0]}
        except Exception:  # noqa: BLE001
            reference = None
        with self.state.db.session(tenant_id) as s:
            r = s.get(Run, run_id)
            r.model_key = model_key
            r.artifacts = jsonable({**r.artifacts, "reference": reference})
        self.state.audit.record(tenant_id, actor, "model.upload", run_id=run_id, sha256=sha, bytes=len(data), format="onnx")
        out = TrainingService(self.state).register(tenant_id, actor, name=name, run_id=run_id, description=description)
        return {**out, "run_id": run_id, "sha256": sha, "input_mode": pipeline.input_mode, "reference_dataset_id": record.id}


def load_uploaded(state: AppState, tenant_id: str, model_key: str, artifacts: dict[str, Any]):
    """Rebuild an uploaded model from its ONNX bytes and Parquet background (no pickle involved)."""
    data = state.objects.get_bytes(tenant_id, model_key)
    background = pd.read_parquet(io.BytesIO(state.objects.get_bytes(tenant_id, model_key.rsplit("/", 1)[0] + "/background.parquet")))
    return uploaded_bundle(data, artifacts["upload"], background, artifacts.get("reference"))
