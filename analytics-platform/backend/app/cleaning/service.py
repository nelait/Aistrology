"""Cleaning pipelines: edit with undo/redo, preview on a sample, apply as a new dataset version (PIP-001 … PIP-007)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pandas as pd
from pydantic import BaseModel, TypeAdapter
from sqlalchemy import select

from ..datasets_io import load_table, main_table
from ..db.models import Pipeline
from ..export_utils import frame_records
from ..ingestion.inference import infer_schema
from .steps import Step, StepError, StepStats, pipeline_hash, run_steps

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState

PREVIEW_SAMPLE_ROWS = 100_000  # ANA-NFR-003
_steps_adapter = TypeAdapter(list[Step])


class PipelineOut(BaseModel):
    id: str
    name: str
    dataset_id: str | None
    is_template: bool
    steps: list[dict[str, Any]]
    can_undo: bool
    can_redo: bool
    hash: str

    @classmethod
    def of(cls, p: Pipeline) -> PipelineOut:
        steps = _steps_adapter.validate_python(p.steps)
        return cls(
            id=p.id,
            name=p.name,
            dataset_id=p.dataset_id,
            is_template=p.is_template,
            steps=list(p.steps),
            can_undo=bool(p.steps),
            can_redo=bool(p.redo_stack),
            hash=pipeline_hash(steps),
        )


class ColumnDelta(BaseModel):
    column: str
    nulls_before: int | None
    nulls_after: int | None
    distinct_before: int | None
    distinct_after: int | None
    mean_before: float | None = None
    mean_after: float | None = None


class PreviewOut(BaseModel):
    sample_rows: int
    rows: list[dict[str, Any]]
    columns: list[str]
    step_stats: list[StepStats]
    column_deltas: list[ColumnDelta]


class PipelineNotFound(LookupError):
    pass


def _mean(s: pd.Series | None) -> float | None:
    if s is None or not pd.api.types.is_numeric_dtype(s) or pd.api.types.is_bool_dtype(s):
        return None
    v = s.mean()
    return None if pd.isna(v) else float(v)


class PipelineService:
    def __init__(self, state: AppState):
        self.state = state

    # -- persistence ------------------------------------------------------------------
    def _get(self, s, tenant_id: str, pipeline_id: str) -> Pipeline:
        p = s.get(Pipeline, pipeline_id)
        if p is None or p.tenant_id != tenant_id:
            raise PipelineNotFound(pipeline_id)
        return p

    def create(
        self, tenant_id: str, actor: str, *, name: str, dataset_id: str | None, steps: list[Any], is_template: bool = False
    ) -> PipelineOut:
        if dataset_id:
            self.state.store.get(tenant_id, dataset_id)
        with self.state.db.session(tenant_id) as s:
            p = Pipeline(
                tenant_id=tenant_id,
                name=name,
                dataset_id=dataset_id,
                is_template=is_template,
                steps=[st.model_dump(mode="json") for st in steps],
                created_by=actor,
            )
            s.add(p)
            s.flush()
            out = PipelineOut.of(p)
        self.state.audit.record(tenant_id, actor, "pipeline.create", pipeline_id=out.id, dataset_id=dataset_id, template=is_template)
        return out

    def get(self, tenant_id: str, pipeline_id: str) -> PipelineOut:
        with self.state.db.session(tenant_id) as s:
            return PipelineOut.of(self._get(s, tenant_id, pipeline_id))

    def steps(self, tenant_id: str, pipeline_id: str) -> list[Any]:
        with self.state.db.session(tenant_id) as s:
            return _steps_adapter.validate_python(self._get(s, tenant_id, pipeline_id).steps)

    def list(self, tenant_id: str, *, dataset_id: str | None = None, templates: bool = False) -> list[PipelineOut]:
        with self.state.db.session(tenant_id) as s:
            q = (
                select(Pipeline)
                .where(Pipeline.tenant_id == tenant_id, Pipeline.is_template == templates)
                .order_by(Pipeline.created_at.desc())
            )
            if dataset_id:
                q = q.where(Pipeline.dataset_id == dataset_id)
            return [PipelineOut.of(p) for p in s.execute(q).scalars()]

    # -- editing (PIP-002) --------------------------------------------------------------
    def add_step(self, tenant_id: str, actor: str, pipeline_id: str, step: Any, *, validate: bool = True) -> PipelineOut:
        with self.state.db.session(tenant_id) as s:
            p = self._get(s, tenant_id, pipeline_id)
            dataset_id = p.dataset_id
            existing = _steps_adapter.validate_python(p.steps)
        if validate and dataset_id:
            # Fail fast: the step must apply cleanly to a small sample of the current result.
            sample = load_table(self.state.store, self.state.store.get(tenant_id, dataset_id), limit=1000)
            run_steps(sample, [*existing, step], collect_stats=False)
        with self.state.db.session(tenant_id) as s:
            p = self._get(s, tenant_id, pipeline_id)
            p.steps = [*p.steps, step.model_dump(mode="json")]
            p.redo_stack = []
            out = PipelineOut.of(p)
        self.state.audit.record(tenant_id, actor, "pipeline.step.add", pipeline_id=pipeline_id, op=step.op, index=len(out.steps))
        return out

    def undo(self, tenant_id: str, actor: str, pipeline_id: str) -> PipelineOut:
        with self.state.db.session(tenant_id) as s:
            p = self._get(s, tenant_id, pipeline_id)
            if not p.steps:
                raise StepError("nothing to undo")
            p.redo_stack, p.steps = [*p.redo_stack, p.steps[-1]], p.steps[:-1]
            out = PipelineOut.of(p)
        self.state.audit.record(tenant_id, actor, "pipeline.step.undo", pipeline_id=pipeline_id)
        return out

    def redo(self, tenant_id: str, actor: str, pipeline_id: str) -> PipelineOut:
        with self.state.db.session(tenant_id) as s:
            p = self._get(s, tenant_id, pipeline_id)
            if not p.redo_stack:
                raise StepError("nothing to redo")
            p.steps, p.redo_stack = [*p.steps, p.redo_stack[-1]], p.redo_stack[:-1]
            out = PipelineOut.of(p)
        self.state.audit.record(tenant_id, actor, "pipeline.step.redo", pipeline_id=pipeline_id)
        return out

    # -- preview (PIP-003, PIP-005) -----------------------------------------------------
    def preview(self, tenant_id: str, pipeline_id: str, candidate: Any | None = None, rows: int = 50) -> PreviewOut:
        with self.state.db.session(tenant_id) as s:
            p = self._get(s, tenant_id, pipeline_id)
            if not p.dataset_id:
                raise StepError("templates can't be previewed; instantiate one on a dataset first")
            dataset_id = p.dataset_id
            steps = _steps_adapter.validate_python(p.steps)
        record = self.state.store.get(tenant_id, dataset_id)
        sample = load_table(self.state.store, record, limit=PREVIEW_SAMPLE_ROWS)
        if candidate is not None:
            steps = [*steps, candidate]
        result, stats = run_steps(sample, steps)
        before = sample if candidate is None else run_steps(sample, steps[:-1], collect_stats=False)[0]
        deltas = []
        for col in dict.fromkeys([*before.columns, *result.columns]):
            b, a = before.get(col), result.get(col)
            if b is not None and a is not None and b.equals(a):
                continue
            deltas.append(
                ColumnDelta(
                    column=col,
                    nulls_before=int(b.isna().sum()) if b is not None else None,
                    nulls_after=int(a.isna().sum()) if a is not None else None,
                    distinct_before=int(b.astype(str).nunique()) if b is not None else None,
                    distinct_after=int(a.astype(str).nunique()) if a is not None else None,
                    mean_before=_mean(b),
                    mean_after=_mean(a),
                )
            )
        return PreviewOut(
            sample_rows=len(sample),
            rows=frame_records(result.head(rows)),
            columns=[str(c) for c in result.columns],
            step_stats=stats,
            column_deltas=deltas,
        )

    # -- templates (PIP-004) ------------------------------------------------------------
    def save_as_template(self, tenant_id: str, actor: str, pipeline_id: str, name: str) -> PipelineOut:
        return self.create(tenant_id, actor, name=name, dataset_id=None, steps=self.steps(tenant_id, pipeline_id), is_template=True)

    def instantiate(self, tenant_id: str, actor: str, template_id: str, dataset_id: str, name: str | None = None) -> PipelineOut:
        with self.state.db.session(tenant_id) as s:
            t = self._get(s, tenant_id, template_id)
            if not t.is_template:
                raise StepError("not a template")
            template_name = t.name
        steps = self.steps(tenant_id, template_id)
        record = self.state.store.get(tenant_id, dataset_id)
        # Compatibility check: run on a small sample of the target dataset.
        run_steps(load_table(self.state.store, record, limit=1000), steps, collect_stats=False)
        return self.create(tenant_id, actor, name=name or f"{template_name} on {record.name}", dataset_id=dataset_id, steps=steps)

    # -- apply (PIP-007) ----------------------------------------------------------------
    def apply(self, tenant_id: str, actor: str, pipeline_id: str, progress=None) -> dict[str, Any]:
        """Run the full pipeline and store the result as the dataset's next immutable version."""
        with self.state.db.session(tenant_id) as s:
            p = self._get(s, tenant_id, pipeline_id)
            dataset_id = p.dataset_id
            steps = _steps_adapter.validate_python(p.steps)
        if not dataset_id:
            raise StepError("templates can't be applied directly")
        record = self.state.store.get(tenant_id, dataset_id)
        table = main_table(record)
        frame = load_table(self.state.store, record)
        result, stats = run_steps(frame, steps, on_step=(lambda i, n: progress(0.1 + 0.7 * i / n, f"step {i}/{n}")) if progress else None)
        inferred = infer_schema(result.head(60_000), entity_name=table.name)
        new = self.state.store.save_frames(
            tenant_id,
            actor,
            record.name,
            {table.name: result},
            inferred.schema_,
            dataset_id=dataset_id,
            pipeline_id=pipeline_id,
            pipeline_hash=pipeline_hash(steps),
        )
        self.state.audit.record(
            tenant_id,
            actor,
            "pipeline.apply",
            pipeline_id=pipeline_id,
            dataset_id=dataset_id,
            from_version=record.version,
            to_version=new.version,
            pipeline_hash=pipeline_hash(steps),
            rows_before=len(frame),
            rows_after=len(result),
        )
        return {
            "dataset_id": dataset_id,
            "version": new.version,
            "parent_version": record.version,
            "rows": len(result),
            "step_stats": [st.model_dump() for st in stats],
        }
