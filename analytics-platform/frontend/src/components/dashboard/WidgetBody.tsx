"use client";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { EChartsType } from "echarts/core";
import { api, type FilterValue, type TabularResult, type Widget } from "@/lib/api";
import { sparkline, STATUS } from "@/lib/chartOptions";
import { columnsOf, toNumber, toRecords } from "@/lib/data";
import { autoSql, evaluateThresholds, ragOf } from "@/lib/dashboard";
import { formatNumber, formatPercent } from "@/lib/format";
import { coerce } from "@/lib/signature";
import { quoteIdent } from "@/lib/sql";
import { useTheme } from "@/lib/theme";
import { ChartView } from "../charts/ChartView";
import { EChart } from "../charts/EChart";
import { DataGrid } from "../DataGrid";
import { Markdown } from "../Markdown";
import { useEndpointFields } from "../useEndpointFields";
import { SignatureInput } from "../SignatureInput";
import { Button, SelectField, Spinner, TextField } from "../ui";

export interface WidgetDataArgs {
  dashboardId: string;
  widget: Widget;
  /** The widget's config matches the last saved spec: use the server-side widget-data endpoint. */
  saved: boolean;
  filters: Record<string, FilterValue>;
  refreshMs: number;
  enabled: boolean;
}

async function previewData(widget: Widget): Promise<TabularResult> {
  const c = widget.config;
  if (c.analytic_id) return api.analytics.run(c.analytic_id, {});
  const sql = c.sql || autoSql(widget);
  if (c.dataset_id && sql) {
    const r = await api.datasets.query(c.dataset_id, sql, 5000);
    // mimic the server's KPI shape
    if ((widget.type === "kpi" || widget.type === "alert") && !c.sql) return { ...r, value: toNumber(r.rows[0]?.[0]) };
    return r;
  }
  return { columns: [], rows: [] };
}

function hasSource(w: Widget): boolean {
  const c = w.config;
  return !!(c.analytic_id || (c.dataset_id && (c.sql || autoSql(w))));
}

export function needsData(w: Widget): boolean {
  return ["chart", "kpi", "table", "alert"].includes(w.type);
}

export function useWidgetData({ dashboardId, widget, saved, filters, refreshMs, enabled }: WidgetDataArgs) {
  return useQuery({
    queryKey: saved ? ["widget-data", dashboardId, widget.id, filters] : ["widget-preview", widget.id, JSON.stringify(widget.config)],
    queryFn: ({ signal }) => (saved ? api.dashboards.widgetData(dashboardId, widget.id, filters, signal) : previewData(widget)),
    enabled: enabled && needsData(widget) && hasSource(widget),
    refetchInterval: refreshMs > 0 ? refreshMs : false,
    placeholderData: (prev) => prev,
    meta: { errorPrefix: widget.title },
  });
}

// -- KPI (WDG-002) ------------------------------------------------------------------------

function Kpi({ widget, result }: { widget: Widget; result: TabularResult }) {
  const { dark } = useTheme();
  const rows = toRecords(result);
  const cols = columnsOf(rows, result.columns);
  const valueCol = widget.config.kpi?.value || cols.find((c) => toNumber(rows[0]?.[c]) !== null) || cols[0];
  const server = result.value !== undefined;
  const values = rows.map((r) => toNumber(r[valueCol])).filter((v): v is number => v !== null);
  const value = server ? toNumber(result.value) : values.length === 1 ? values[0] : values.length ? values.reduce((a, b) => a + b, 0) : null;
  // Server KPIs return a sparkline of [period, value]; custom SQL KPIs draw the value column over the rows.
  const trend = server ? (result.sparkline ?? []).map((p) => toNumber(p[1])).filter((v): v is number => v !== null) : values.length > 1 ? values : [];
  const trendCol = widget.config.kpi?.trend ?? valueCol;
  const target = result.target ?? widget.config.kpi?.target;
  const delta = result.vs_target !== undefined && result.vs_target !== null ? result.vs_target : value !== null && target ? (value - target) / Math.abs(target) : null;
  const change = trend.length >= 2 && trend[trend.length - 2] ? (trend[trend.length - 1] - trend[trend.length - 2]) / Math.abs(trend[trend.length - 2]) : null;
  return (
    <div className="flex h-full flex-col justify-center gap-1">
      <p className="text-3xl font-semibold tabular-nums">{formatNumber(value)}</p>
      <p className="text-xs text-[var(--text-2)]">{server ? `${widget.config.kpi?.aggregation ?? "sum"} of ${widget.config.kpi?.value}` : valueCol}</p>
      <div className="flex flex-wrap gap-3 text-xs">
        {change !== null && (
          <span className={change >= 0 ? "text-green-800 dark:text-green-300" : "text-red-700 dark:text-red-400"}>
            <span aria-hidden="true">{change >= 0 ? "▲" : "▼"}</span> {formatPercent(Math.abs(change))} vs previous
          </span>
        )}
        {delta !== null && (
          <span className={delta >= 0 ? "text-green-800 dark:text-green-300" : "text-amber-800 dark:text-amber-300"}>
            {delta >= 0 ? "✓ " : "⚠ "}
            {formatPercent(Math.abs(delta))} {delta >= 0 ? "above" : "below"} target ({formatNumber(target)})
          </span>
        )}
      </div>
      {trend.length > 1 && (
        <div className="h-10">
          <EChart option={sparkline(trend, dark)} height={40} ariaLabel={`Trend of ${trendCol}`} />
        </div>
      )}
    </div>
  );
}

// -- Alert (WDG-008) ----------------------------------------------------------------------

const RAG_STYLE = {
  red: { color: STATUS.critical, icon: "✕", label: "Critical" },
  amber: { color: STATUS.warning, icon: "⚠", label: "Warning" },
  green: { color: STATUS.good, icon: "✓", label: "OK" },
} as const;

function Alert({ widget, result }: { widget: Widget; result: TabularResult }) {
  const rows = toRecords(result);
  const cols = columnsOf(rows, result.columns);
  const col = widget.config.value_column || widget.config.kpi?.value || cols.find((c) => toNumber(rows[0]?.[c]) !== null) || cols[0];
  const value = result.value !== undefined ? toNumber(result.value) : toNumber(rows[0]?.[col]);
  const hit = evaluateThresholds(value, widget.config.thresholds);
  const rag = hit ? ragOf(hit.color) : result.status ? ragOf(result.status) : null;
  const style = rag ? RAG_STYLE[rag] : null;
  return (
    <div className="flex h-full items-center gap-3" role="status">
      <span
        aria-hidden="true"
        className="grid h-12 w-12 shrink-0 place-items-center rounded-full text-xl font-bold text-white"
        style={{ backgroundColor: style?.color ?? hit?.color ?? "#8a8983" }}
      >
        {style?.icon ?? "•"}
      </span>
      <div>
        <p className="text-2xl font-semibold tabular-nums">{formatNumber(value)}</p>
        <p className="text-sm">
          <strong>{style?.label ?? (hit ? hit.color : "No threshold matched")}</strong>
          {hit && (
            <span className="text-[var(--text-2)]">
              {" "}
              · {col} {hit.op} {hit.value}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

// -- Filter control (WDG-006) ----------------------------------------------------------------

export function FilterControl({ widget, value, onChange }: { widget: Widget; value: FilterValue | null | undefined; onChange: (v: FilterValue | null) => void }) {
  const f = widget.config.filter;
  const col = f?.column ?? "";
  const kind = f?.kind ?? "dropdown";
  const options = useQuery({
    queryKey: ["filter-options", f?.dataset_id, col, kind],
    queryFn: () =>
      kind === "slider"
        ? api.datasets.query(f!.dataset_id, `SELECT MIN(${quoteIdent(col)}) AS lo, MAX(${quoteIdent(col)}) AS hi FROM data`, 1)
        : api.datasets.query(f!.dataset_id, `SELECT DISTINCT ${quoteIdent(col)} AS v FROM data WHERE ${quoteIdent(col)} IS NOT NULL ORDER BY 1 LIMIT 500`, 500),
    enabled: !!f?.dataset_id && !!col && kind !== "date",
    staleTime: 5 * 60_000,
  });
  if (!f?.column) return <p className="text-sm text-[var(--text-2)]">Configure the column to filter.</p>;
  const values = (options.data?.rows ?? []).map((r) => String(r[0]));

  if (kind === "dropdown")
    return (
      <SelectField label={col} value={typeof value === "string" || typeof value === "number" ? String(value) : ""} onChange={(e) => onChange(e.target.value || null)} options={values.map((v) => ({ value: v, label: v }))} placeholder="All" />
    );
  if (kind === "multiselect") {
    const sel = Array.isArray(value) ? value.map(String) : [];
    return (
      <fieldset className="flex h-full min-h-0 flex-col">
        <legend className="text-xs font-medium text-[var(--text-2)]">{col}</legend>
        <ul className="min-h-0 flex-1 overflow-auto text-sm">
          {values.map((v) => (
            <li key={v}>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="accent-brand-600" checked={sel.includes(v)} onChange={() => onChange(sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v])} />
                {v}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    );
  }
  if (kind === "slider") {
    const lo = toNumber(options.data?.rows?.[0]?.[0]) ?? 0;
    const hi = toNumber(options.data?.rows?.[0]?.[1]) ?? 100;
    const cur = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const max = toNumber(cur.max) ?? hi;
    const min = toNumber(cur.min) ?? lo;
    const step = (hi - lo) / 100 || 1;
    return (
      <div className="space-y-2">
        <label className="block text-xs font-medium text-[var(--text-2)]">
          {col} ≥ {formatNumber(min)}
          <input type="range" className="w-full accent-brand-600" min={lo} max={hi} step={step} value={min} onChange={(e) => onChange({ min: Number(e.target.value), max })} />
        </label>
        <label className="block text-xs font-medium text-[var(--text-2)]">
          {col} ≤ {formatNumber(max)}
          <input type="range" className="w-full accent-brand-600" min={lo} max={hi} step={step} value={max} onChange={(e) => onChange({ min, max: Number(e.target.value) })} />
        </label>
      </div>
    );
  }
  const cur = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return (
    <div className="grid grid-cols-2 gap-2">
      <TextField label={`${col} from`} type="date" value={String(cur.min ?? "")} onChange={(e) => onChange({ ...cur, min: e.target.value || undefined })} />
      <TextField label="to" type="date" value={String(cur.max ?? "")} onChange={(e) => onChange({ ...cur, max: e.target.value || undefined })} />
    </div>
  );
}

// -- Prediction (WDG-007) ------------------------------------------------------------------

function Prediction({ widget }: { widget: Widget }) {
  const endpoint = widget.config.endpoint;
  const { fields, loading } = useEndpointFields(endpoint);
  const [values, setValues] = useState<Record<string, string>>({});
  const predict = useMutation({
    mutationFn: () => api.endpoints.predict(endpoint!, [Object.fromEntries(fields.map((f) => [f.name, coerce(values[f.name] ?? "", f.type)]))], true),
    meta: { errorPrefix: "Prediction failed" },
  });
  if (!endpoint) return <p className="text-sm text-[var(--text-2)]">Choose an endpoint in the widget settings.</p>;
  if (loading) return <Spinner />;
  const expl = predict.data?.shap?.[0] ?? predict.data?.explanations?.[0];
  return (
    <form
      className="flex h-full flex-col gap-2 overflow-auto"
      onSubmit={(e) => {
        e.preventDefault();
        predict.mutate();
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map((f) => (
          <SignatureInput key={f.name} field={f} value={values[f.name] ?? ""} onChange={(v) => setValues((x) => ({ ...x, [f.name]: v }))} />
        ))}
      </div>
      <Button type="submit" size="sm" variant="primary" loading={predict.isPending} className="self-start">
        Predict
      </Button>
      {predict.data && (
        <div aria-live="polite" className="text-sm">
          <p>
            Prediction: <strong>{String(predict.data.predictions[0])}</strong>
          </p>
          {expl && (
            <ul className="text-xs text-[var(--text-2)]">
              {Object.entries(expl)
                .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
                .slice(0, 5)
                .map(([k, v]) => (
                  <li key={k}>
                    {k}: {v >= 0 ? "+" : ""}
                    {formatNumber(v)}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}

function safeImage(url: string | undefined): string | null {
  if (!url) return null;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(url)) return url;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

// -- Body dispatcher -------------------------------------------------------------------

export interface WidgetBodyProps extends WidgetDataArgs {
  onCrossFilter?: (column: string, value: string) => void;
  onChartReady?: (chart: EChartsType | null) => void;
  filterValue?: FilterValue | null;
  onFilterChange?: (v: FilterValue | null) => void;
}

export function WidgetBody(props: WidgetBodyProps) {
  const { widget, onCrossFilter, onChartReady, filterValue, onFilterChange, saved } = props;
  const q = useWidgetData(props);
  const result = q.data;
  const rows = useMemo(() => toRecords(result), [result]);

  switch (widget.type) {
    case "text":
      return <Markdown source={widget.config.text ?? ""} />;
    case "image": {
      const src = safeImage(widget.config.image_url);
      // eslint-disable-next-line @next/next/no-img-element
      return src ? <img src={src} alt={widget.title} className="h-full w-full object-contain" loading="lazy" referrerPolicy="no-referrer" /> : <p className="text-sm text-[var(--text-2)]">Set an http(s) image URL.</p>;
    }
    case "filter":
      return <FilterControl widget={widget} value={filterValue} onChange={(v) => onFilterChange?.(v)} />;
    case "prediction":
      return <Prediction widget={widget} />;
    default:
      break;
  }

  if (!hasSource(widget)) return <p className="text-sm text-[var(--text-2)]">Choose a data source and fields in the widget settings.</p>;
  if (q.isLoading) return <Spinner label="Loading data…" />;
  if (q.isError) return <p role="alert" className="text-sm text-red-700 dark:text-red-400">{q.error instanceof Error ? q.error.message : "Failed to load"}</p>;
  if (!result) return null;

  const body = (() => {
    switch (widget.type) {
      case "chart":
        return <ChartView rows={rows} columns={result.columns} spec={widget.config.chart ?? { type: "bar" }} height="100%" title={widget.title} toolbar={false} onPointClick={onCrossFilter} onReady={onChartReady} />;
      case "kpi":
        return <Kpi widget={widget} result={result} />;
      case "table":
        return <DataGrid columns={columnsOf(rows, result.columns)} rows={rows} pageSize={10} dense conditionalFormat={widget.config.conditional_format} caption={widget.title} exportName={widget.title} maxHeight="100%" />;
      case "alert":
        return <Alert widget={widget} result={result} />;
      default:
        return null;
    }
  })();
  return (
    <div className="flex h-full min-h-0 flex-col">
      {!saved && <p className="mb-1 text-[10px] text-amber-800 dark:text-amber-300">Unsaved preview — dashboard filters apply after saving.</p>}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}
