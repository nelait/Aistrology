"""The allowlist of schedulable job types and their parameter validators.

Only these job types can be scheduled. Each needs a permission (checked when the schedule is saved and again
at every run, against the owner's current role) and validates its parameters for the caller, including
project access to any dataset it touches (AUTH-003).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field, ValidationError

from ..auth.rbac import Permission
from ..jobs.scheduler import ScheduleError, schedulable
from . import deliveries

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState
    from ..auth.service import Principal


def _model(model: type[BaseModel], params: dict[str, Any]) -> BaseModel:
    try:
        return model.model_validate(params)
    except ValidationError as exc:
        raise ScheduleError(exc.errors(include_url=False, include_context=False)[0]["msg"]) from exc


def _dataset(state: AppState, principal: Principal, dataset_id: str):
    from ..projects import ProjectAccessDenied, check_dataset
    from ..storage.datasets import DatasetNotFound

    try:
        check_dataset(state, principal, dataset_id)
        return state.store.get(principal.tenant_id, dataset_id)
    except (DatasetNotFound, ProjectAccessDenied) as exc:
        raise ScheduleError("dataset not found") from exc


schedulable("analytics.scheduled_run", Permission.CREATE_ANALYTICS, "Run a saved analytic and deliver the result (USR-007)")(
    deliveries.validate_analytic_run
)
schedulable("dashboard.deliver", Permission.EDIT_DASHBOARDS, "Email / post a dashboard snapshot (SHR-004)")(
    deliveries.validate_dashboard_delivery
)


class DriftParams(BaseModel):
    endpoint: str | None = Field(default=None, max_length=100)
    hours: int = Field(default=24, ge=1, le=24 * 90)


@schedulable("serving.drift_check", Permission.DEPLOY, "Check endpoint drift and alert (API-011)")
def _drift(state: AppState, principal: Principal, params: dict[str, Any]) -> dict[str, Any]:
    body = _model(DriftParams, params)
    if body.endpoint:
        from ..serving.service import ServingService
        from ..training.service import NotFound

        try:
            ServingService(state).get(principal.tenant_id, body.endpoint)
        except NotFound as exc:
            raise ScheduleError("endpoint not found") from exc
    return body.model_dump(exclude_none=True)


class DatasetParams(BaseModel):
    dataset_id: str = Field(min_length=1, max_length=40)


@schedulable("stream.compact", Permission.WRITE_DATA, "Compact a stream's buffered records into a new version (ING-008)")
def _compact(state: AppState, principal: Principal, params: dict[str, Any]) -> dict[str, Any]:
    from ..streams import is_stream

    body = _model(DatasetParams, params)
    _dataset(state, principal, body.dataset_id)
    if not is_stream(state, principal.tenant_id, body.dataset_id):
        raise ScheduleError("dataset is not a stream")
    return body.model_dump()


@schedulable("dataset.profile", Permission.WRITE_DATA, "Re-profile the latest version of a dataset")
def _profile(state: AppState, principal: Principal, params: dict[str, Any]) -> dict[str, Any]:
    body = _model(DatasetParams, params)
    _dataset(state, principal, body.dataset_id)
    return body.model_dump()


class PipelineParams(BaseModel):
    pipeline_id: str = Field(min_length=1, max_length=40)


@schedulable("pipeline.apply", Permission.EDIT_PIPELINES, "Re-apply a cleaning pipeline")
def _pipeline(state: AppState, principal: Principal, params: dict[str, Any]) -> dict[str, Any]:
    from ..db.models import Pipeline

    body = _model(PipelineParams, params)
    with state.db.session(principal.tenant_id) as s:
        pipeline = s.get(Pipeline, body.pipeline_id)
        if pipeline is None or pipeline.tenant_id != principal.tenant_id or pipeline.is_template or not pipeline.dataset_id:
            raise ScheduleError("pipeline not found")
        dataset_id = pipeline.dataset_id
    _dataset(state, principal, dataset_id)
    return body.model_dump()
