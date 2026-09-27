/** Dashboard spec helpers (DSH-*, WDG-*, WCFG-*). */
import type { DashboardPage, DashboardSpec, DatasetRecord, FilterValue, Threshold, Widget, WidgetType } from "./types";
import { uid } from "./data";
import { generateSql, quoteIdent, type BuilderAggregation } from "./sql";

export const REFRESH_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Off" },
  { value: 30, label: "30 s" },
  { value: 60, label: "1 min" },
  { value: 300, label: "5 min" },
  { value: 900, label: "15 min" },
  { value: 3600, label: "1 h" },
  { value: 21600, label: "6 h" },
  { value: 86400, label: "24 h" },
];

export const DATE_PRESETS: { value: string; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "last_7_days", label: "Last 7 days" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "last_90_days", label: "Last 90 days" },
  { value: "last_365_days", label: "Last 12 months" },
  { value: "ytd", label: "Year to date" },
  { value: "custom", label: "Custom…" },
];

export const WIDGET_TYPES: { type: WidgetType; label: string; description: string }[] = [
  { type: "chart", label: "Chart", description: "Any chart type from an analytic or SQL" },
  { type: "kpi", label: "KPI", description: "Headline number with trend and target" },
  { type: "table", label: "Table", description: "Sortable, filterable table with conditional formatting" },
  { type: "text", label: "Text", description: "Markdown notes and headings" },
  { type: "image", label: "Image", description: "Logo, screenshot or diagram" },
  { type: "filter", label: "Filter", description: "Dropdown, multi-select, slider or date control" },
  { type: "prediction", label: "Prediction", description: "Form that calls a model endpoint" },
  { type: "alert", label: "Alert", description: "Red / amber / green threshold status" },
];

const DEFAULT_SIZE: Record<WidgetType, { w: number; h: number }> = {
  chart: { w: 6, h: 8 },
  kpi: { w: 3, h: 4 },
  table: { w: 12, h: 8 },
  text: { w: 4, h: 4 },
  image: { w: 3, h: 4 },
  filter: { w: 3, h: 3 },
  prediction: { w: 4, h: 8 },
  alert: { w: 3, h: 4 },
};

export function emptySpec(): DashboardSpec {
  return {
    pages: [{ id: uid("p"), title: "Overview", widgets: [] }],
    filters: [],
    date_range: null,
    theme: { mode: "light", primary: "#2a78d6" },
    refresh_seconds: null,
  };
}

/**
 * SQL equivalent of the server-side query for widgets configured with a dataset but no custom SQL. Used
 * only for unsaved previews; saved widgets get their data from the widget-data endpoint.
 */
export function autoSql(w: Widget): string | null {
  const c = w.config;
  if (w.type === "chart" && c.chart) {
    const dims = [c.chart.x, c.chart.series].filter((x): x is string => !!x);
    const agg = (c.chart.aggregation ?? (c.chart.y ? "sum" : "count")) as BuilderAggregation;
    return generateSql({ dimensions: dims, measures: [{ column: c.chart.y && agg !== "count" ? c.chart.y : "*", aggregation: c.chart.y && agg === "count" ? "count" : agg, alias: c.chart.y ?? "count" }], filters: [], limit: 5000 });
  }
  if ((w.type === "kpi" || w.type === "alert") && c.kpi) {
    const agg = c.kpi.aggregation ?? "sum";
    const measure = agg === "count" ? "COUNT(*)" : `${agg.toUpperCase()}(${quoteIdent(c.kpi.value)})`;
    return `SELECT ${measure} AS value FROM data`;
  }
  if (w.type === "table") {
    const cols = c.columns?.length ? c.columns.map(quoteIdent).join(", ") : "*";
    const order = c.sort?.column ? ` ORDER BY ${quoteIdent(c.sort.column)} ${c.sort.desc ? "DESC" : "ASC"}` : "";
    return `SELECT ${cols} FROM data${order} LIMIT ${c.page_size ?? 500}`;
  }
  return null;
}

/** Fill in missing optional parts of a spec coming from the API. */
export function normalizeSpec(spec: Partial<DashboardSpec> | null | undefined): DashboardSpec {
  const base = emptySpec();
  const pages = spec?.pages?.length ? spec.pages : base.pages;
  return {
    ...base,
    ...spec,
    pages: pages.map((p) => ({ ...p, widgets: (p.widgets ?? []).map((w) => ({ ...w, config: w.config ?? {}, layout: w.layout ?? { x: 0, y: 0, w: 4, h: 4 } })) })),
    filters: spec?.filters ?? [],
  };
}

export function nextY(page: DashboardPage): number {
  return page.widgets.reduce((m, w) => Math.max(m, w.layout.y + w.layout.h), 0);
}

export function newWidget(type: WidgetType, page: DashboardPage): Widget {
  const size = DEFAULT_SIZE[type];
  const config: Widget["config"] = {};
  if (type === "chart") config.chart = { type: "bar" };
  if (type === "text") config.text = "## Heading\n\nWrite **Markdown** here.";
  if (type === "alert") config.thresholds = [
    { op: ">=", value: 100, color: "red" },
    { op: ">=", value: 50, color: "amber" },
    { op: "<", value: 50, color: "green" },
  ];
  return { id: uid("w"), type, title: WIDGET_TYPES.find((t) => t.type === type)?.label ?? type, layout: { x: 0, y: nextY(page), ...size }, config };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Convert a date preset (or custom range) to a `{min, max}` filter value. */
export function dateRangeValue(preset: string, custom?: { from?: string; to?: string }, now = new Date()): { min?: string; max?: string } | null {
  const days: Record<string, number> = { last_7_days: 7, last_30_days: 30, last_90_days: 90, last_365_days: 365 };
  if (preset === "all" || !preset) return null;
  if (preset === "custom") {
    if (!custom?.from && !custom?.to) return null;
    return { min: custom?.from || undefined, max: custom?.to || undefined };
  }
  if (preset === "ytd") return { min: `${now.getUTCFullYear()}-01-01`, max: iso(now) };
  if (days[preset]) {
    const from = new Date(now.getTime() - days[preset] * 86400_000);
    return { min: iso(from), max: iso(now) };
  }
  return null;
}

export interface CrossFilter {
  column: string;
  value: string;
  sourceWidgetId: string;
}

function isEmptyFilter(v: FilterValue | null | undefined): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return v.min === undefined && v.max === undefined;
  return false;
}

/** Combine global filters, the date range and cross-filters into the widget-data request body. */
export function buildFilters(
  globalValues: Record<string, FilterValue | null>,
  dateRange: { column: string; value: { min?: string; max?: string } | null } | null,
  cross: CrossFilter[],
  forWidgetId?: string,
): Record<string, FilterValue> {
  const out: Record<string, FilterValue> = {};
  for (const [k, v] of Object.entries(globalValues)) if (!isEmptyFilter(v)) out[k] = v as FilterValue;
  if (dateRange?.value && dateRange.column) out[dateRange.column] = dateRange.value;
  for (const c of cross) if (c.sourceWidgetId !== forWidgetId) out[c.column] = c.value;
  return out;
}

export type Rag = "red" | "amber" | "green";

export function ragOf(color: string): Rag | null {
  const c = color.toLowerCase();
  if (["red", "critical", "#e34948", "#f00", "#ff0000"].includes(c)) return "red";
  if (["amber", "orange", "yellow", "warning", "#eda100"].includes(c)) return "amber";
  if (["green", "ok", "good", "#008300", "#0f0", "#00ff00"].includes(c)) return "green";
  return null;
}

export function evaluateThresholds(value: number | null, thresholds: Threshold[] | undefined): Threshold | null {
  if (value === null || !thresholds) return null;
  for (const t of thresholds) {
    const ok =
      t.op === ">" ? value > t.value : t.op === ">=" ? value >= t.value : t.op === "<" ? value < t.value : t.op === "<=" ? value <= t.value : t.op === "==" ? value === t.value : value !== t.value;
    if (ok) return t;
  }
  return null;
}

export function datasetForColumn(datasets: DatasetRecord[] | undefined, spec: DashboardSpec, column: string): string | null {
  const ids = spec.pages.flatMap((p) => p.widgets.map((w) => w.config.dataset_id ?? w.config.filter?.dataset_id)).filter((x): x is string => !!x);
  for (const id of ids) {
    const d = datasets?.find((x) => x.id === id);
    if (d?.schema?.entities?.[0]?.fields.some((f) => f.name === column)) return id;
  }
  return null;
}
