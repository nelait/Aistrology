"""GraphQL API (API-003): ``POST /graphql``.

Read queries over datasets, experiments / runs, registered models, endpoints and dashboards, plus a ``predict``
mutation. Authentication is the REST API's (``get_principal``: bearer token, API key, OAuth client token; rate limits
and IP policy included); every resolver checks the same RBAC permission as its REST counterpart, results are scoped
to the caller's tenant, and datasets (and the experiments built on them) follow project visibility (AUTH-003).
GraphiQL is served only in development mode (``AP_DEV_AUTH=1``).
"""

from __future__ import annotations

import asyncio
from typing import Any

import strawberry
from fastapi import Depends, Request
from strawberry.fastapi import GraphQLRouter
from strawberry.scalars import JSON
from strawberry.types import Info

from ..auth.rbac import Permission, has_permission
from ..auth.service import Principal
from ..export_utils import jsonable
from ..projects import visible_projects
from .deps import SCOPED_METHODS, AppState, get_principal, get_state

MAX_LIST = 500


class GraphQLPermissionError(PermissionError):
    pass


def _ctx(info: Info) -> tuple[AppState, Principal]:
    return info.context["state"], info.context["principal"]


def _require(principal: Principal, permission: Permission) -> None:
    if not has_permission(principal.role, permission, principal.scopes if principal.method in SCOPED_METHODS else None):
        raise GraphQLPermissionError(f"missing permission {permission.value}")


def _visible_dataset_ids(state: AppState, principal: Principal) -> set[str] | None:
    allowed = visible_projects(state, principal)
    if allowed is None:
        return None
    return {d.id for d in state.store.list(principal.tenant_id, allowed)}


@strawberry.type
class DatasetType:
    id: str
    name: str
    version: int
    latest_version: int
    project_id: str | None
    source: str
    created_at: str
    created_by: str
    size_bytes: int
    row_count: int | None
    columns: list[str]


@strawberry.type
class RunType:
    id: str
    experiment_id: str
    status: str
    algorithm: str | None
    params: JSON
    metrics: JSON
    duration_seconds: float | None
    is_best: bool


@strawberry.type
class ExperimentType:
    id: str
    name: str
    dataset_id: str
    dataset_version: int
    config: JSON
    created_by: str
    created_at: str
    runs: list[RunType]


@strawberry.type
class ModelVersionType:
    id: str
    version: int
    stage: str
    run_id: str
    algorithm: str | None
    metrics: JSON
    signature: JSON


@strawberry.type
class ModelType:
    id: str
    name: str
    description: str | None
    versions: list[ModelVersionType]


@strawberry.type
class EndpointType:
    id: str
    name: str
    status: str
    url: str
    routes: JSON
    created_at: str


@strawberry.type
class DashboardType:
    id: str
    name: str
    owner_id: str
    archived: bool
    your_role: str
    spec: JSON
    updated_at: str


def _dataset(d) -> DatasetType:
    table = d.tables[0] if d.tables else None
    columns = [f.name for f in d.schema_.entities[0].fields] if d.schema_ and d.schema_.entities else []
    return DatasetType(
        id=d.id,
        name=d.name,
        version=d.version,
        latest_version=d.latest_version,
        project_id=d.project_id,
        source=d.source,
        created_at=str(d.created_at),
        created_by=d.created_by,
        size_bytes=d.size_bytes,
        row_count=table.row_count if table else None,
        columns=columns,
    )


def _run(r) -> RunType:
    return RunType(
        id=r.id,
        experiment_id=r.experiment_id,
        status=r.status,
        algorithm=r.algorithm,
        params=jsonable(r.params),
        metrics=jsonable(r.metrics),
        duration_seconds=r.duration_seconds,
        is_best=bool(r.artifacts.get("is_best")),
    )


def _model(state: AppState, tenant_id: str, model_id: str) -> ModelType:
    from ..training.service import TrainingService

    m = TrainingService(state).get_model(tenant_id, model_id)
    return ModelType(
        id=m["model"]["id"],
        name=m["model"]["name"],
        description=m["model"]["description"],
        versions=[
            ModelVersionType(
                id=v["id"],
                version=v["version"],
                stage=v["stage"],
                run_id=v["run_id"],
                algorithm=v.get("algorithm"),
                metrics=jsonable(v["metrics"]),
                signature=jsonable(v["signature"]),
            )
            for v in m["versions"]
        ],
    )


def _endpoint(e) -> EndpointType:
    return EndpointType(id=e.id, name=e.name, status=e.status, url=e.url, routes=jsonable(e.routes), created_at=str(e.created_at))


@strawberry.type
class Query:
    @strawberry.field(description="Datasets visible to the caller (project visibility applies).")
    def datasets(self, info: Info, project_id: str | None = None, limit: int = 100) -> list[DatasetType]:
        state, principal = _ctx(info)
        _require(principal, Permission.READ_DATA)
        allowed = visible_projects(state, principal)
        if project_id is not None:
            allowed = {project_id} if allowed is None or project_id in allowed else set()
        return [_dataset(d) for d in state.store.list(principal.tenant_id, allowed)[: min(limit, MAX_LIST)]]

    @strawberry.field
    def dataset(self, info: Info, id: str) -> DatasetType | None:  # noqa: A002
        from ..projects import ProjectAccessDenied, check_dataset
        from ..storage.datasets import DatasetNotFound

        state, principal = _ctx(info)
        _require(principal, Permission.READ_DATA)
        try:
            check_dataset(state, principal, id)
            return _dataset(state.store.get(principal.tenant_id, id))
        except (DatasetNotFound, ProjectAccessDenied):
            return None

    @strawberry.field(description="Experiments on datasets the caller can see, newest first, with their runs.")
    def experiments(self, info: Info, dataset_id: str | None = None, limit: int = 50) -> list[ExperimentType]:
        from ..training.service import TrainingService

        state, principal = _ctx(info)
        _require(principal, Permission.READ_DATA)
        svc = TrainingService(state)
        visible = _visible_dataset_ids(state, principal)
        out = []
        for e in svc.list_experiments(principal.tenant_id):
            if (dataset_id and e.dataset_id != dataset_id) or (visible is not None and e.dataset_id not in visible):
                continue
            _, runs = svc.get_experiment(principal.tenant_id, e.id)
            out.append(
                ExperimentType(
                    id=e.id,
                    name=e.name,
                    dataset_id=e.dataset_id,
                    dataset_version=e.dataset_version,
                    config=jsonable(e.config),
                    created_by=e.created_by,
                    created_at=str(e.created_at),
                    runs=[_run(r) for r in runs],
                )
            )
            if len(out) >= min(limit, MAX_LIST):
                break
        return out

    @strawberry.field
    def run(self, info: Info, id: str) -> RunType | None:  # noqa: A002
        from ..training.service import NotFound, TrainingService

        state, principal = _ctx(info)
        _require(principal, Permission.READ_DATA)
        svc = TrainingService(state)
        try:
            run = svc.get_run(principal.tenant_id, id)
            exp, _ = svc.get_experiment(principal.tenant_id, run.experiment_id)
        except NotFound:
            return None
        visible = _visible_dataset_ids(state, principal)
        return _run(run) if visible is None or exp.dataset_id in visible else None

    @strawberry.field
    def models(self, info: Info) -> list[ModelType]:
        from ..training.service import TrainingService

        state, principal = _ctx(info)
        _require(principal, Permission.READ_DATA)
        return [_model(state, principal.tenant_id, m["id"]) for m in TrainingService(state).list_models(principal.tenant_id)[:MAX_LIST]]

    @strawberry.field
    def model(self, info: Info, id: str) -> ModelType | None:  # noqa: A002
        from ..training.service import NotFound

        state, principal = _ctx(info)
        _require(principal, Permission.READ_DATA)
        try:
            return _model(state, principal.tenant_id, id)
        except NotFound:
            return None

    @strawberry.field
    def endpoints(self, info: Info) -> list[EndpointType]:
        from ..serving.service import ServingService

        state, principal = _ctx(info)
        _require(principal, Permission.READ_DATA)
        return [_endpoint(e) for e in ServingService(state).list(principal.tenant_id)]

    @strawberry.field
    def endpoint(self, info: Info, name: str) -> EndpointType | None:
        from ..serving.service import ServingService
        from ..training.service import NotFound

        state, principal = _ctx(info)
        _require(principal, Permission.READ_DATA)
        try:
            return _endpoint(ServingService(state).get(principal.tenant_id, name))
        except NotFound:
            return None

    @strawberry.field(description="Dashboards the caller owns or that are shared with them.")
    def dashboards(self, info: Info, archived: bool = False) -> list[DashboardType]:
        from ..dashboards.service import DashboardService

        state, principal = _ctx(info)
        _require(principal, Permission.VIEW)
        return [
            DashboardType(
                id=d.id,
                name=d.name,
                owner_id=d.owner_id,
                archived=d.archived,
                your_role=d.your_role,
                spec=jsonable(d.spec.model_dump(mode="json")),
                updated_at=str(d.updated_at),
            )
            for d in DashboardService(state).list(principal, archived)
        ]


@strawberry.type
class Mutation:
    @strawberry.mutation(description="Real-time inference on an endpoint (same limits and logging as REST predict).")
    async def predict(
        self,
        info: Info,
        endpoint: str,
        instances: list[JSON] | None = None,
        horizon: int | None = None,
        explain: bool = False,
    ) -> JSON:
        from ..serving.service import ServingService

        state, principal = _ctx(info)
        _require(principal, Permission.PREDICT)
        rows: list[dict[str, Any]] = []
        for row in instances or []:
            if not isinstance(row, dict):
                raise ValueError("each instance must be an object")
            rows.append(row)
        out = await asyncio.to_thread(
            ServingService(state).predict, principal.tenant_id, endpoint, rows, explain=explain, caller=principal.user_id, horizon=horizon
        )
        return jsonable(out)


schema = strawberry.Schema(query=Query, mutation=Mutation)


async def _context(request: Request, state: AppState = Depends(get_state), principal: Principal = Depends(get_principal)) -> dict:
    return {"request": request, "state": state, "principal": principal}


def graphql_router(dev: bool = False) -> GraphQLRouter:
    return GraphQLRouter(schema, path="/graphql", context_getter=_context, graphql_ide="graphiql" if dev else None)
