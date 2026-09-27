"""Dashboards and widgets (DSH-*, WDG-*, WCFG-*, SHR-*)."""

from __future__ import annotations

import copy
import hashlib
import html
import json
import threading
import time
import uuid
from typing import TYPE_CHECKING, Any, Literal

import jwt
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..analytics.saved import AnalyticsService, ChartSpec, chart_sql, quote_ident, run_on_dataset
from ..analytics.sql_sandbox import UnsafeQueryError
from ..auth.rbac import Role
from ..db.models import Dashboard
from ..export_utils import jsonable

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState
    from ..auth.service import Principal

WidgetType = Literal["chart", "kpi", "table", "text", "filter", "image", "prediction", "alert", "iframe"]


class Layout(BaseModel):
    x: int = Field(default=0, ge=0, le=48)
    y: int = Field(default=0, ge=0, le=10_000)
    w: int = Field(default=6, ge=1, le=48)
    h: int = Field(default=4, ge=1, le=100)


class Widget(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:8], pattern=r"^[A-Za-z0-9_-]{1,40}$")
    type: WidgetType
    title: str = Field(default="", max_length=200)
    layout: Layout = Field(default_factory=Layout)
    config: dict[str, Any] = Field(default_factory=dict)


class Page(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:8])
    title: str = Field(default="Page", max_length=100)
    widgets: list[Widget] = Field(default_factory=list, max_length=100)


class GlobalFilter(BaseModel):
    id: str
    column: str
    kind: Literal["dropdown", "multiselect", "slider", "date"] = "multiselect"
    default: Any = None


class DashboardSpec(BaseModel):
    pages: list[Page] = Field(default_factory=lambda: [Page(title="Overview")], min_length=1, max_length=20)
    filters: list[GlobalFilter] = Field(default_factory=list, max_length=30)
    date_range: dict[str, Any] | None = None
    theme: dict[str, Any] = Field(default_factory=lambda: {"mode": "light"})
    refresh_seconds: int | None = Field(default=None, ge=5, le=86_400)

    def widget(self, widget_id: str) -> Widget | None:
        return next((w for p in self.pages for w in p.widgets if w.id == widget_id), None)


class DashboardOut(BaseModel):
    id: str
    name: str
    spec: DashboardSpec
    owner_id: str
    shares: dict[str, str]
    archived: bool
    your_role: str
    created_at: Any
    updated_at: Any


class NotFound(LookupError):
    pass


class Forbidden(PermissionError):
    pass


TEMPLATES: dict[str, dict[str, Any]] = {
    "kpi-overview": {
        "name": "KPI overview",
        "description": "Headline KPIs, a trend line and a breakdown table.",
        "spec": {
            "pages": [
                {
                    "id": "overview",
                    "title": "Overview",
                    "widgets": [
                        {
                            "id": "kpi1",
                            "type": "kpi",
                            "title": "Total",
                            "layout": {"x": 0, "y": 0, "w": 3, "h": 2},
                            "config": {"kpi": {"value": "{measure}", "aggregation": "sum"}},
                        },
                        {
                            "id": "kpi2",
                            "type": "kpi",
                            "title": "Rows",
                            "layout": {"x": 3, "y": 0, "w": 3, "h": 2},
                            "config": {"kpi": {"value": "{measure}", "aggregation": "count"}},
                        },
                        {
                            "id": "trend",
                            "type": "chart",
                            "title": "By {dimension}",
                            "layout": {"x": 0, "y": 2, "w": 8, "h": 4},
                            "config": {"chart": {"type": "bar", "x": "{dimension}", "y": "{measure}", "aggregation": "sum"}},
                        },
                        {"id": "table", "type": "table", "title": "Detail", "layout": {"x": 0, "y": 6, "w": 12, "h": 5}, "config": {}},
                    ],
                }
            ],
            "filters": [{"id": "f1", "column": "{dimension}", "kind": "multiselect"}],
        },
    },
    "blank": {"name": "Blank", "description": "An empty dashboard.", "spec": {"pages": [{"id": "p1", "title": "Page 1", "widgets": []}]}},
}


def _fill(obj: Any, values: dict[str, str]) -> Any:
    if isinstance(obj, str):
        for k, v in values.items():
            obj = obj.replace("{" + k + "}", v)
        return obj
    if isinstance(obj, list):
        return [_fill(v, values) for v in obj]
    if isinstance(obj, dict):
        return {k: _fill(v, values) for k, v in obj.items()}
    return obj


class DashboardService:
    _cache: dict[str, tuple[float, dict[str, Any]]] = {}
    _cache_lock = threading.Lock()
    CACHE_TTL = 60.0  # WCFG-005 default

    def __init__(self, state: AppState):
        self.state = state

    # -- access (SHR-002) ---------------------------------------------------------------------------
    @staticmethod
    def role_for(d: Dashboard, principal: Principal) -> str | None:
        if principal.role == Role.ADMIN.value or d.owner_id == principal.user_id:
            return "owner"
        role = d.shares.get(principal.user_id) or d.shares.get("*")
        if role == "editor" and principal.role == Role.VIEWER.value:
            return "viewer"  # tenant viewers can never edit
        return role

    def _load(self, s, principal: Principal, dashboard_id: str, need: str = "viewer") -> tuple[Dashboard, str]:
        d = s.get(Dashboard, dashboard_id)
        if d is None or d.tenant_id != principal.tenant_id:
            raise NotFound(dashboard_id)
        role = self.role_for(d, principal)
        if role is None:
            raise NotFound(dashboard_id)  # don't reveal existence
        if need == "editor" and role not in ("owner", "editor"):
            raise Forbidden("editor access required")
        if need == "owner" and role != "owner":
            raise Forbidden("owner access required")
        return d, role

    @staticmethod
    def _out(d: Dashboard, role: str) -> DashboardOut:
        return DashboardOut(
            id=d.id,
            name=d.name,
            spec=DashboardSpec.model_validate(d.spec),
            owner_id=d.owner_id,
            shares=dict(d.shares),
            archived=d.archived,
            your_role=role,
            created_at=d.created_at,
            updated_at=d.updated_at,
        )

    # -- CRUD (DSH-001) -----------------------------------------------------------------------------
    def create(self, principal: Principal, name: str, spec: DashboardSpec) -> DashboardOut:
        with self.state.db.session(principal.tenant_id) as s:
            d = Dashboard(
                tenant_id=principal.tenant_id, name=name, spec=spec.model_dump(mode="json"), owner_id=principal.user_id, shares={}
            )
            s.add(d)
            s.flush()
            out = self._out(d, "owner")
        self.state.audit.record(principal.tenant_id, principal.user_id, "dashboard.create", dashboard_id=out.id)
        return out

    def from_template(self, principal: Principal, template: str, name: str, values: dict[str, str]) -> DashboardOut:
        if template not in TEMPLATES:
            raise NotFound(template)
        spec = DashboardSpec.model_validate(_fill(copy.deepcopy(TEMPLATES[template]["spec"]), values))
        dataset_id = values.get("dataset_id")
        if dataset_id:
            for page in spec.pages:
                for w in page.widgets:
                    w.config.setdefault("dataset_id", dataset_id)
            for f in spec.filters:
                f.id = f.id or f.column
        return self.create(principal, name, spec)

    def get(self, principal: Principal, dashboard_id: str) -> DashboardOut:
        with self.state.db.session(principal.tenant_id) as s:
            d, role = self._load(s, principal, dashboard_id)
            return self._out(d, role)

    def list(self, principal: Principal, archived: bool = False) -> list[DashboardOut]:
        with self.state.db.session(principal.tenant_id) as s:
            rows = s.execute(
                select(Dashboard)
                .where(Dashboard.tenant_id == principal.tenant_id, Dashboard.archived.is_(archived))
                .order_by(Dashboard.updated_at.desc())
            ).scalars()
            return [self._out(d, role) for d in rows if (role := self.role_for(d, principal))]

    def update(self, principal: Principal, dashboard_id: str, name: str | None, spec: DashboardSpec | None) -> DashboardOut:
        with self.state.db.session(principal.tenant_id) as s:
            d, role = self._load(s, principal, dashboard_id, "editor")
            if name is not None:
                d.name = name
            if spec is not None:
                d.spec = spec.model_dump(mode="json")
            out = self._out(d, role)
        self.state.audit.record(principal.tenant_id, principal.user_id, "dashboard.update", dashboard_id=dashboard_id)
        return out

    def clone(self, principal: Principal, dashboard_id: str) -> DashboardOut:
        src = self.get(principal, dashboard_id)
        return self.create(principal, f"{src.name} (copy)", src.spec)

    def set_archived(self, principal: Principal, dashboard_id: str, archived: bool) -> DashboardOut:
        with self.state.db.session(principal.tenant_id) as s:
            d, role = self._load(s, principal, dashboard_id, "owner")
            d.archived = archived
            return self._out(d, role)

    def delete(self, principal: Principal, dashboard_id: str) -> None:
        with self.state.db.session(principal.tenant_id) as s:
            d, _ = self._load(s, principal, dashboard_id, "owner")
            s.delete(d)
        self.state.audit.record(principal.tenant_id, principal.user_id, "dashboard.delete", dashboard_id=dashboard_id)

    def share(self, principal: Principal, dashboard_id: str, user_id: str, role: str | None) -> DashboardOut:
        """SHR-001/002: share with a user (or ``*`` for everyone in the tenant); role None revokes."""
        with self.state.db.session(principal.tenant_id) as s:
            d, my_role = self._load(s, principal, dashboard_id, "owner")
            shares = dict(d.shares)
            if role is None:
                shares.pop(user_id, None)
            else:
                shares[user_id] = role
            d.shares = shares
            out = self._out(d, my_role)
        self.state.audit.record(
            principal.tenant_id, principal.user_id, "dashboard.share", dashboard_id=dashboard_id, user_id=user_id, role=role
        )
        return out

    # -- widget data --------------------------------------------------------------------------------
    def widget_data(self, principal: Principal, dashboard_id: str, widget_id: str, filters: dict[str, Any]) -> dict[str, Any]:
        dash = self.get(principal, dashboard_id)
        return self._widget_data(principal.tenant_id, dash, widget_id, filters)

    def _widget_data(self, tenant_id: str, dash: DashboardOut, widget_id: str, filters: dict[str, Any]) -> dict[str, Any]:
        widget = dash.spec.widget(widget_id)
        if widget is None:
            raise NotFound(widget_id)
        if widget.type in ("text", "image", "iframe", "prediction"):
            return {"columns": [], "rows": [], "static": True}
        cfg = widget.config
        analytic_id = cfg.get("analytic_id")
        dataset_id = cfg.get("dataset_id")
        if analytic_id:
            dataset_id = AnalyticsService(self.state).get(tenant_id, analytic_id).dataset_id
        if not dataset_id:
            raise UnsafeQueryError("widget has no data source (set dataset_id or analytic_id)")
        record = self.state.store.get(tenant_id, dataset_id)
        cache_key = hashlib.sha256(
            json.dumps([tenant_id, dash.id, widget.model_dump(mode="json"), record.version, filters], sort_keys=True, default=str).encode()
        ).hexdigest()
        ttl = float(cfg.get("cache_ttl_seconds", self.CACHE_TTL))
        with self._cache_lock:
            hit = self._cache.get(cache_key)
            if hit and time.monotonic() - hit[0] < ttl:
                return {**hit[1], "cached": True}
        widget_filters = {**filters}
        if widget.type == "filter":
            widget_filters.pop(cfg.get("filter", {}).get("column"), None)  # a filter control shouldn't filter its own options
        result = self._compute(tenant_id, dataset_id, widget, cfg, analytic_id, widget_filters, record)
        result["dataset_version"] = record.version
        with self._cache_lock:
            self._cache[cache_key] = (time.monotonic(), result)
            if len(self._cache) > 5000:
                self._cache.clear()
        return result

    def _compute(self, tenant_id, dataset_id, widget, cfg, analytic_id, filters, record) -> dict[str, Any]:
        columns = {f.name for f in record.schema_.entities[0].fields} if record.schema_ and record.schema_.entities else set()

        # Global filters apply only to columns this widget's dataset actually has (dashboards can mix datasets).
        applicable = {k: v for k, v in filters.items() if k in columns}

        def run(sql: str, limit: int = 5000, params: dict | None = None) -> dict[str, Any]:
            r = run_on_dataset(self.state, tenant_id, dataset_id, sql, filters=applicable, params=params, row_limit=limit)
            return {"columns": r.columns, "rows": r.rows, "truncated": r.truncated}

        if analytic_id:
            r = AnalyticsService(self.state).run(tenant_id, analytic_id, cfg.get("params", {}), filters=applicable)
            return {"columns": r.columns, "rows": r.rows, "truncated": r.truncated}
        if cfg.get("sql"):
            return run(cfg["sql"])
        if widget.type == "chart":
            return run(chart_sql(ChartSpec.model_validate(cfg.get("chart", {})), columns))
        if widget.type in ("kpi", "alert"):
            kpi = cfg.get("kpi", {})
            value = kpi.get("value")
            agg = kpi.get("aggregation", "sum")
            if agg not in ("sum", "avg", "count", "min", "max", "median"):
                raise UnsafeQueryError(f"unsupported aggregation {agg!r}")
            if agg != "count" and value not in columns:
                raise UnsafeQueryError(f"unknown column {value!r}")
            measure = "count(*)" if agg == "count" else f"{agg}({quote_ident(value)})"
            out = run(f"SELECT {measure} AS value FROM data")
            out["value"] = out["rows"][0][0] if out["rows"] else None
            trend = kpi.get("trend")
            if trend:
                grain = kpi.get("grain", "month")
                if trend not in columns:
                    raise UnsafeQueryError(f"unknown column {trend!r}")
                if grain not in ("day", "week", "month", "quarter", "year"):
                    raise UnsafeQueryError(f"unsupported grain {grain!r}")
                spark = run(
                    f"SELECT date_trunc('{grain}', CAST({quote_ident(trend)} AS TIMESTAMP)) AS period, {measure} AS value FROM data GROUP BY 1 ORDER BY 1",
                    500,
                )
                out["sparkline"] = spark["rows"]
            if kpi.get("target") is not None and out["value"] is not None:
                out["target"] = kpi["target"]
                out["vs_target"] = out["value"] / kpi["target"] - 1 if kpi["target"] else None
            thresholds = cfg.get("thresholds") or []
            out["status"] = _threshold_status(out["value"], thresholds)
            return out
        if widget.type == "table":
            cols = cfg.get("columns") or []
            for c in cols:
                if c not in columns:
                    raise UnsafeQueryError(f"unknown column {c!r}")
            select_list = ", ".join(quote_ident(c) for c in cols) if cols else "*"
            order = cfg.get("sort")
            order_sql = ""
            if order:
                if order.get("column") not in columns:
                    raise UnsafeQueryError("unknown sort column")
                order_sql = f" ORDER BY {quote_ident(order['column'])} {'DESC' if order.get('desc') else 'ASC'}"
            return run(f"SELECT {select_list} FROM data{order_sql}", int(cfg.get("page_size", 500)))
        if widget.type == "filter":
            f = cfg.get("filter", {})
            col = f.get("column")
            if col not in columns:
                raise UnsafeQueryError(f"unknown column {col!r}")
            if f.get("kind") in ("slider", "date"):
                return run(f"SELECT min({quote_ident(col)}) AS min, max({quote_ident(col)}) AS max FROM data")
            return run(f"SELECT DISTINCT {quote_ident(col)} AS value FROM data WHERE {quote_ident(col)} IS NOT NULL ORDER BY 1", 1000)
        raise UnsafeQueryError(f"unsupported widget type {widget.type}")

    # -- export (DSH-009) -----------------------------------------------------------------------
    def export_html(self, principal: Principal, dashboard_id: str, filters: dict[str, Any]) -> str:
        dash = self.get(principal, dashboard_id)
        data = {}
        for page in dash.spec.pages:
            for w in page.widgets:
                try:
                    data[w.id] = self._widget_data(principal.tenant_id, dash, w.id, filters)
                except (UnsafeQueryError, LookupError) as exc:
                    data[w.id] = {"error": str(exc)}
        return render_html(dash, jsonable(data))

    # -- embedding (SHR-003) ------------------------------------------------------------------------
    def embed_token(self, principal: Principal, dashboard_id: str, ttl_minutes: int) -> str:
        self.get(principal, dashboard_id)
        now = int(time.time())
        return jwt.encode(
            {
                "iss": "analytics-platform",
                "aud": "embed",
                "tid": principal.tenant_id,
                "dsh": dashboard_id,
                "iat": now,
                "exp": now + ttl_minutes * 60,
            },
            self.state.auth.signing_key(),
            algorithm="HS256",
        )

    def resolve_embed(self, token: str) -> tuple[str, DashboardOut]:
        try:
            claims = jwt.decode(token, self.state.auth.signing_key(), algorithms=["HS256"], audience="embed", issuer="analytics-platform")
        except jwt.PyJWTError as exc:
            raise Forbidden("invalid or expired embed token") from exc
        with self.state.db.session(claims["tid"]) as s:
            d = s.get(Dashboard, claims["dsh"])
            if d is None or d.tenant_id != claims["tid"] or d.archived:
                raise NotFound(claims["dsh"])
            return claims["tid"], self._out(d, "viewer")

    def embed_widget_data(self, token: str, widget_id: str, filters: dict[str, Any]) -> dict[str, Any]:
        tenant_id, dash = self.resolve_embed(token)
        return self._widget_data(tenant_id, dash, widget_id, filters)


def _threshold_status(value: Any, thresholds: list[dict[str, Any]]) -> str | None:
    """WDG-008: first matching threshold wins; returns its color (e.g. red/amber/green)."""
    if value is None:
        return None
    ops = {
        ">": lambda a, b: a > b,
        ">=": lambda a, b: a >= b,
        "<": lambda a, b: a < b,
        "<=": lambda a, b: a <= b,
        "==": lambda a, b: a == b,
    }
    for t in thresholds:
        op = ops.get(t.get("op", ">"))
        if op and t.get("value") is not None and op(value, t["value"]):
            return t.get("color", "red")
    return "green" if thresholds else None


def render_html(dash: DashboardOut, data: dict[str, Any]) -> str:
    """DSH-009a: a standalone, interactive HTML snapshot (ECharts from a CDN, data embedded)."""
    payload = json.dumps({"spec": dash.spec.model_dump(mode="json"), "data": data}).replace("</", "<\\/")
    title = html.escape(dash.name)
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
<style>
body{{font-family:system-ui,sans-serif;margin:0;background:#f6f7f9;color:#111}}
header{{padding:16px 24px;background:#fff;border-bottom:1px solid #e5e7eb}}
.grid{{display:grid;grid-template-columns:repeat(12,1fr);gap:12px;padding:16px}}
.card{{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px;overflow:auto}}
.card h3{{margin:0 0 8px;font-size:14px;color:#374151}}
.kpi{{font-size:32px;font-weight:600}} table{{border-collapse:collapse;width:100%;font-size:12px}}
td,th{{border-bottom:1px solid #eee;padding:4px 6px;text-align:left}} .err{{color:#b91c1c}}
</style></head><body>
<header><h1 style="margin:0;font-size:20px">{title}</h1><small>Snapshot exported from Analytics Platform</small></header>
<main id="root"></main>
<script>
const D = {payload};
const root = document.getElementById('root');
for (const page of D.spec.pages) {{
  const h = document.createElement('h2'); h.textContent = page.title; h.style.margin = '16px 24px 0'; root.appendChild(h);
  const grid = document.createElement('div'); grid.className = 'grid'; root.appendChild(grid);
  for (const w of page.widgets) {{
    const card = document.createElement('div'); card.className = 'card';
    card.style.gridColumn = `span ${{Math.min(12, w.layout.w)}}`; card.style.minHeight = `${{w.layout.h * 60}}px`;
    const t = document.createElement('h3'); t.textContent = w.title || ''; card.appendChild(t);
    const d = D.data[w.id] || {{}};
    if (d.error) {{ const e = document.createElement('div'); e.className = 'err'; e.textContent = d.error; card.appendChild(e); }}
    else if (w.type === 'text') {{ const p = document.createElement('div'); p.textContent = (w.config.text || ''); card.appendChild(p); }}
    else if (w.type === 'kpi' || w.type === 'alert') {{ const k = document.createElement('div'); k.className = 'kpi'; k.textContent = d.value ?? '—'; if (d.status) k.style.color = d.status; card.appendChild(k); }}
    else if (w.type === 'chart' && d.rows) {{
      const el = document.createElement('div'); el.style.height = `${{w.layout.h * 55}}px`; card.appendChild(el);
      const type = (w.config.chart || {{}}).type || 'bar';
      const chart = echarts.init(el);
      if (type === 'pie') chart.setOption({{tooltip:{{}}, series:[{{type:'pie', data:d.rows.map(r => ({{name:String(r[0]), value:r[r.length-1]}}))}}]}});
      else chart.setOption({{tooltip:{{trigger:'axis'}}, xAxis:{{type:'category', data:d.rows.map(r => String(r[0]))}}, yAxis:{{type:'value'}},
        series:[{{type: ['line','area'].includes(type) ? 'line' : (type === 'scatter' ? 'scatter' : 'bar'), areaStyle: type === 'area' ? {{}} : undefined, data:d.rows.map(r => r[r.length-1])}}]}});
    }} else if (d.rows) {{
      const tbl = document.createElement('table'); const head = tbl.insertRow();
      for (const c of d.columns) {{ const th = document.createElement('th'); th.textContent = c; head.appendChild(th); }}
      for (const r of d.rows.slice(0, 200)) {{ const tr = tbl.insertRow(); for (const v of r) tr.insertCell().textContent = v ?? ''; }}
      card.appendChild(tbl);
    }}
    grid.appendChild(card);
  }}
}}
</script></body></html>"""
