"""Saved, parameterized analytics (USR-005, USR-006) and shared query helpers for dashboards."""

from __future__ import annotations

import math
import re
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy import select

from ..datasets_io import main_table, renames, sandbox_tables
from ..db.models import Analytic
from .sql_sandbox import QueryResult, UnsafeQueryError, open_sandbox, run_query, validate_select

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState

PARAM_RE = re.compile(r"(?<![:\w]):([A-Za-z_]\w*)")
AGGREGATIONS = {"sum", "avg", "count", "min", "max", "median", "count_distinct"}


class Parameter(BaseModel):
    name: str = Field(pattern=r"^[A-Za-z_]\w*$")
    type: Literal["string", "number", "date"] = "string"
    default: Any = None


class ChartSpec(BaseModel):
    type: str = "table"
    x: str | None = None
    y: str | None = None
    series: str | None = None
    aggregation: str | None = None


class AnalyticCreate(BaseModel):
    dataset_id: str
    name: str = Field(min_length=1, max_length=200)
    sql: str = Field(min_length=1, max_length=20_000)
    chart: ChartSpec = Field(default_factory=ChartSpec)
    parameters: list[Parameter] = Field(default_factory=list, max_length=20)


class AnalyticOut(AnalyticCreate):
    id: str
    created_by: str
    created_at: Any


class NotFound(LookupError):
    pass


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def literal(value: Any) -> str:
    """A safe SQL literal for filter values (strings are escaped; only scalars are accepted)."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise UnsafeQueryError("non-finite number in filter")
        return repr(value)
    if isinstance(value, str):
        if len(value) > 1000:
            raise UnsafeQueryError("filter value too long")
        return "'" + value.replace("'", "''") + "'"
    raise UnsafeQueryError(f"unsupported filter value {type(value).__name__}")


def where_clause(filters: dict[str, Any], columns: set[str]) -> str:
    """Global dashboard filters → SQL WHERE (DSH-004, DSH-005, WCFG-002). Columns must exist."""
    clauses = []
    for column, value in filters.items():
        if column not in columns:
            raise UnsafeQueryError(f"unknown filter column {column!r}")
        col = quote_ident(column)
        if value is None or value == [] or value == {}:
            continue
        if isinstance(value, list):
            if len(value) > 1000:
                raise UnsafeQueryError("too many filter values")
            clauses.append(f"{col} IN ({', '.join(literal(v) for v in value)})")
        elif isinstance(value, dict):
            if value.get("min") is not None:
                clauses.append(f"{col} >= {literal(value['min'])}")
            if value.get("max") is not None:
                clauses.append(f"{col} <= {literal(value['max'])}")
        else:
            clauses.append(f"{col} = {literal(value)}")
    return " AND ".join(clauses)


def bind_params(sql: str, parameters: list[Parameter], values: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """``:name`` placeholders → DuckDB ``$name`` with typed values (never string-interpolated)."""
    declared = {p.name: p for p in parameters}
    bound: dict[str, Any] = {}
    for name in set(PARAM_RE.findall(sql)):
        if name not in declared:
            raise UnsafeQueryError(f"undeclared parameter :{name}")
        p = declared[name]
        value = values.get(name, p.default)
        if value is None:
            raise UnsafeQueryError(f"parameter :{name} needs a value")
        if p.type == "number":
            try:
                value = float(value)
            except (TypeError, ValueError) as exc:
                raise UnsafeQueryError(f"parameter :{name} must be a number") from exc
        else:
            value = str(value)
        bound[name] = value
    return PARAM_RE.sub(lambda m: f"${m.group(1)}", sql), bound


def run_on_dataset(
    state: AppState,
    tenant_id: str,
    dataset_id: str,
    sql: str,
    *,
    filters: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
    row_limit: int = 5000,
) -> QueryResult:
    record = state.store.get(tenant_id, dataset_id)
    con = open_sandbox(sandbox_tables(state.store, record), renames=renames(record))
    try:
        if filters:
            table = main_table(record).name
            columns = {r[0] for r in con.execute(f"DESCRIBE {quote_ident(table)}").fetchall()}
            where = where_clause(filters, columns)
            if where:
                con.execute(f"CREATE OR REPLACE VIEW data AS SELECT * FROM {quote_ident(table)} WHERE {where}")
        return run_query(con, sql, row_limit=row_limit, params=params)
    finally:
        con.close()


class AnalyticsService:
    def __init__(self, state: AppState):
        self.state = state

    def create(self, tenant_id: str, actor: str, body: AnalyticCreate) -> AnalyticOut:
        self.state.store.get(tenant_id, body.dataset_id)
        sql, _ = bind_params(
            body.sql,
            body.parameters,
            {p.name: p.default if p.default is not None else (0 if p.type == "number" else "") for p in body.parameters},
        )
        validate_select(sql)
        with self.state.db.session(tenant_id) as s:
            a = Analytic(
                tenant_id=tenant_id,
                dataset_id=body.dataset_id,
                name=body.name,
                sql=body.sql,
                chart=body.chart.model_dump(),
                parameters=[p.model_dump() for p in body.parameters],
                created_by=actor,
            )
            s.add(a)
            s.flush()
            out = self._out(a)
        self.state.audit.record(tenant_id, actor, "analytic.create", analytic_id=out.id)
        return out

    @staticmethod
    def _out(a: Analytic) -> AnalyticOut:
        return AnalyticOut(
            id=a.id,
            dataset_id=a.dataset_id,
            name=a.name,
            sql=a.sql,
            chart=ChartSpec.model_validate(a.chart),
            parameters=[Parameter.model_validate(p) for p in a.parameters],
            created_by=a.created_by,
            created_at=a.created_at,
        )

    def get(self, tenant_id: str, analytic_id: str) -> AnalyticOut:
        with self.state.db.session(tenant_id) as s:
            a = s.get(Analytic, analytic_id)
            if a is None or a.tenant_id != tenant_id:
                raise NotFound(analytic_id)
            return self._out(a)

    def list(self, tenant_id: str, dataset_id: str | None = None) -> list[AnalyticOut]:
        with self.state.db.session(tenant_id) as s:
            q = select(Analytic).where(Analytic.tenant_id == tenant_id).order_by(Analytic.created_at.desc())
            if dataset_id:
                q = q.where(Analytic.dataset_id == dataset_id)
            return [self._out(a) for a in s.execute(q).scalars()]

    def delete(self, tenant_id: str, actor: str, analytic_id: str) -> None:
        with self.state.db.session(tenant_id) as s:
            a = s.get(Analytic, analytic_id)
            if a is None or a.tenant_id != tenant_id:
                raise NotFound(analytic_id)
            s.delete(a)
        self.state.audit.record(tenant_id, actor, "analytic.delete", analytic_id=analytic_id)

    def run(
        self, tenant_id: str, analytic_id: str, params: dict[str, Any], filters: dict[str, Any] | None = None, row_limit: int = 5000
    ) -> QueryResult:
        a = self.get(tenant_id, analytic_id)
        sql, bound = bind_params(a.sql, a.parameters, params)
        return run_on_dataset(self.state, tenant_id, a.dataset_id, sql, filters=filters, params=bound, row_limit=row_limit)


def chart_sql(chart: ChartSpec, columns: set[str]) -> str:
    """Generate SQL for a chart config (query-builder style) with validated columns and aggregation."""
    for col in (chart.x, chart.y, chart.series):
        if col is not None and col not in columns:
            raise UnsafeQueryError(f"unknown column {col!r}")
    agg = (chart.aggregation or "sum").lower()
    if agg not in AGGREGATIONS:
        raise UnsafeQueryError(f"unsupported aggregation {agg!r}")
    if chart.type in ("histogram", "box"):
        col = chart.y or chart.x
        if not col:
            raise UnsafeQueryError("histogram/box charts need a column")
        return f"SELECT {quote_ident(col)} FROM data WHERE {quote_ident(col)} IS NOT NULL LIMIT 10000"
    if chart.type == "scatter":
        if not (chart.x and chart.y):
            raise UnsafeQueryError("scatter charts need x and y")
        extra = f", {quote_ident(chart.series)}" if chart.series else ""
        return f"SELECT {quote_ident(chart.x)}, {quote_ident(chart.y)}{extra} FROM data LIMIT 5000"
    if not chart.x:
        raise UnsafeQueryError("charts need an x column")
    if agg == "count" or not chart.y:
        measure = "count(*)"
    elif agg == "count_distinct":
        measure = f"count(DISTINCT {quote_ident(chart.y)})"
    else:
        measure = f"{agg}({quote_ident(chart.y)})"
    dims = [quote_ident(chart.x)] + ([quote_ident(chart.series)] if chart.series else [])
    return f"SELECT {', '.join(dims)}, {measure} AS value FROM data GROUP BY {', '.join(str(i + 1) for i in range(len(dims)))} ORDER BY 1 LIMIT 1000"
