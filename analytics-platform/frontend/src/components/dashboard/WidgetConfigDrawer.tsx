"use client";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ConditionalFormat, type Threshold, type Widget, type WidgetConfig } from "@/lib/api";
import { schemaColumns } from "@/lib/data";
import { ChartConfig } from "../analytics/ChartConfig";
import { Markdown } from "../Markdown";
import { CUSTOM_HTML_EXAMPLE, configuredAllowlist, validateIframeUrl } from "@/lib/embed";
import { appOrigins } from "./EmbedWidgets";
import { SqlEditor } from "../SqlEditor";
import { Button, Modal, MultiSelect, SelectField, TextArea, TextField, toOptions } from "../ui";

const OPS: Threshold["op"][] = [">", ">=", "<", "<=", "==", "!="];
/** the server evaluates alert thresholds with these operators */
const THRESHOLD_OPS: Threshold["op"][] = [">", ">=", "<", "<=", "=="];
const COLORS = [
  { value: "red", label: "Red (critical)" },
  { value: "amber", label: "Amber (warning)" },
  { value: "green", label: "Green (ok)" },
];

/** Per-widget configuration (WCFG-001, WCFG-003). */
export function WidgetConfigDrawer({ widget, onChange, onClose }: { widget: Widget | null; onChange: (w: Widget) => void; onClose: () => void }) {
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api.datasets.list() });
  const analytics = useQuery({ queryKey: ["analytics"], queryFn: api.analytics.list });
  const endpoints = useQuery({ queryKey: ["endpoints"], queryFn: api.endpoints.list, enabled: widget?.type === "prediction", meta: { silent: true } });

  const c = widget?.config ?? {};
  const datasetId = c.dataset_id ?? (c.analytic_id ? analytics.data?.find((a) => a.id === c.analytic_id)?.dataset_id : undefined) ?? c.filter?.dataset_id;
  const columns = useMemo(() => schemaColumns(datasets.data?.find((d) => d.id === datasetId)?.schema), [datasets.data, datasetId]);
  const colNames = columns.map((x) => x.name);

  if (!widget) return <Modal open={false} onClose={onClose} title="" side>{null}</Modal>;
  const set = (patch: Partial<WidgetConfig>) => onChange({ ...widget, config: { ...widget.config, ...patch } });
  const setKpi = (patch: Partial<NonNullable<WidgetConfig["kpi"]>>) => set({ kpi: { value: c.kpi?.value ?? "", ...c.kpi, ...patch } });
  const needsSource = ["chart", "kpi", "table", "alert", "custom_html"].includes(widget.type);
  const sourceKind = c.analytic_id ? "analytic" : c.sql !== undefined ? "sql" : "auto";

  return (
    <Modal open={!!widget} onClose={onClose} title={`Configure ${widget.type} widget`} side footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="space-y-4">
        <TextField label="Title" value={widget.title} onChange={(e) => onChange({ ...widget, title: e.target.value })} />

        {needsSource && (
          <fieldset className="space-y-2 rounded-md border border-[var(--border)] p-3">
            <legend className="px-1 text-xs font-semibold">Data source</legend>
            <SelectField
              label="Source"
              value={sourceKind}
              onChange={(e) =>
                e.target.value === "analytic"
                  ? set({ sql: undefined, analytic_id: analytics.data?.[0]?.id })
                  : e.target.value === "sql"
                    ? set({ analytic_id: undefined, sql: c.sql ?? "SELECT *\nFROM data\nLIMIT 100" })
                    : set({ analytic_id: undefined, sql: undefined })
              }
              options={[
                { value: "auto", label: "Dataset (query built from the fields below)" },
                { value: "sql", label: "Dataset + custom SQL" },
                { value: "analytic", label: "Saved analytic" },
              ]}
            />
            {sourceKind === "analytic" ? (
              <SelectField
                label="Analytic"
                value={c.analytic_id ?? ""}
                onChange={(e) => {
                  const a = analytics.data?.find((x) => x.id === e.target.value);
                  set({ analytic_id: e.target.value || undefined, chart: widget.type === "chart" && a ? a.chart : c.chart });
                }}
                options={(analytics.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
                placeholder="Choose…"
              />
            ) : (
              <>
                <SelectField label="Dataset" value={c.dataset_id ?? ""} onChange={(e) => set({ dataset_id: e.target.value || undefined })} options={(datasets.data ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="Choose…" />
                {c.dataset_id && sourceKind === "sql" && <SqlEditor value={c.sql ?? ""} onChange={(sql) => set({ sql })} columns={columns} height={160} label="Widget SQL" />}
              </>
            )}
            <p className="text-xs text-[var(--text-2)]">Global filters and cross-filters are applied server-side to columns with matching names.</p>
          </fieldset>
        )}

        {widget.type === "chart" && <ChartConfig spec={c.chart ?? { type: "bar" }} onChange={(chart) => set({ chart })} columns={colNames} />}

        {(widget.type === "kpi" || widget.type === "alert") && (
          <div className="grid grid-cols-2 gap-2">
            <SelectField className="col-span-2" label="Value column" value={c.kpi?.value ?? ""} onChange={(e) => setKpi({ value: e.target.value })} options={toOptions(colNames)} placeholder={sourceKind === "auto" ? "Choose…" : "(first numeric)"} />
            {sourceKind === "auto" && (
              <SelectField label="Aggregation" value={c.kpi?.aggregation ?? "sum"} onChange={(e) => setKpi({ aggregation: e.target.value as "sum" })} options={toOptions(["sum", "avg", "count", "min", "max", "median"])} />
            )}
            {widget.type === "kpi" && (
              <TextField label="Target" type="number" value={c.kpi?.target ?? ""} onChange={(e) => setKpi({ target: e.target.value === "" ? null : Number(e.target.value) })} />
            )}
            {widget.type === "kpi" && sourceKind === "auto" && (
              <>
                <SelectField
                  label="Trend date column"
                  value={c.kpi?.trend ?? ""}
                  onChange={(e) => setKpi({ trend: e.target.value || null })}
                  options={toOptions(columns.filter((x) => x.type === "date" || x.type === "datetime").map((x) => x.name))}
                  placeholder="(no sparkline)"
                />
                <SelectField label="Trend grain" value={c.kpi?.grain ?? "month"} disabled={!c.kpi?.trend} onChange={(e) => setKpi({ grain: e.target.value as "month" })} options={toOptions(["day", "week", "month", "quarter", "year"])} />
              </>
            )}
            {widget.type === "kpi" && sourceKind !== "auto" && <p className="col-span-2 text-xs text-[var(--text-2)]">With custom SQL or an analytic, multiple rows are drawn as a sparkline of the value column.</p>}
          </div>
        )}

        {widget.type === "table" && sourceKind === "auto" && (
          <div className="grid gap-2">
            <MultiSelect label="Columns" hint="Empty = all" options={toOptions(colNames)} value={c.columns ?? []} onChange={(v) => set({ columns: v.length ? v : undefined })} maxHeight={140} ordered />
            <div className="grid grid-cols-3 gap-2">
              <SelectField label="Sort by" value={c.sort?.column ?? ""} onChange={(e) => set({ sort: e.target.value ? { column: e.target.value, desc: c.sort?.desc } : undefined })} options={toOptions(colNames)} placeholder="(none)" />
              <SelectField
                label="Direction"
                disabled={!c.sort}
                value={c.sort?.desc ? "desc" : "asc"}
                onChange={(e) => c.sort && set({ sort: { ...c.sort, desc: e.target.value === "desc" } })}
                options={[
                  { value: "asc", label: "Ascending" },
                  { value: "desc", label: "Descending" },
                ]}
              />
              <TextField label="Max rows" type="number" min={1} max={10000} value={c.page_size ?? 500} onChange={(e) => set({ page_size: Number(e.target.value) || 500 })} />
            </div>
          </div>
        )}

        {widget.type === "table" && (
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold">Conditional formatting</legend>
            {(c.conditional_format ?? []).map((r, i) => {
              const upd = (p: Partial<ConditionalFormat>) => set({ conditional_format: (c.conditional_format ?? []).map((x, j) => (j === i ? { ...x, ...p } : x)) });
              return (
                <div key={i} className="grid grid-cols-[1fr_4.5rem_1fr_3rem_auto] items-end gap-1">
                  <SelectField label="Column" value={r.column} onChange={(e) => upd({ column: e.target.value })} options={toOptions(colNames)} />
                  <SelectField label="Op" value={r.op} onChange={(e) => upd({ op: e.target.value as Threshold["op"] })} options={toOptions(OPS)} />
                  <TextField label="Value" value={String(r.value)} onChange={(e) => upd({ value: e.target.value === "" || isNaN(Number(e.target.value)) ? e.target.value : Number(e.target.value) })} />
                  <TextField label="Color" type="color" value={r.color} onChange={(e) => upd({ color: e.target.value })} />
                  <Button size="sm" variant="ghost" aria-label={`Remove rule ${i + 1}`} onClick={() => set({ conditional_format: (c.conditional_format ?? []).filter((_, j) => j !== i) })}>
                    ✕
                  </Button>
                </div>
              );
            })}
            <Button size="sm" onClick={() => set({ conditional_format: [...(c.conditional_format ?? []), { column: colNames[0] ?? "", op: ">", value: 0, color: "#e34948" }] })}>
              + Add rule
            </Button>
          </fieldset>
        )}

        {widget.type === "alert" && (
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold">Thresholds (first match wins)</legend>
            {(c.thresholds ?? []).map((t, i) => {
              const upd = (p: Partial<Threshold>) => set({ thresholds: (c.thresholds ?? []).map((x, j) => (j === i ? { ...x, ...p } : x)) });
              return (
                <div key={i} className="grid grid-cols-[4.5rem_1fr_1fr_auto] items-end gap-1">
                  <SelectField label="Op" value={t.op} onChange={(e) => upd({ op: e.target.value as Threshold["op"] })} options={toOptions(THRESHOLD_OPS)} />
                  <TextField label="Value" type="number" value={t.value} onChange={(e) => upd({ value: Number(e.target.value) })} />
                  <SelectField label="Status" value={t.color} onChange={(e) => upd({ color: e.target.value })} options={COLORS} />
                  <Button size="sm" variant="ghost" aria-label={`Remove threshold ${i + 1}`} onClick={() => set({ thresholds: (c.thresholds ?? []).filter((_, j) => j !== i) })}>
                    ✕
                  </Button>
                </div>
              );
            })}
            <Button size="sm" onClick={() => set({ thresholds: [...(c.thresholds ?? []), { op: ">", value: 0, color: "red" }] })}>
              + Add threshold
            </Button>
          </fieldset>
        )}

        {widget.type === "text" && (
          <>
            <TextArea label="Markdown" mono rows={10} value={c.text ?? ""} onChange={(e) => set({ text: e.target.value })} hint="Headings, **bold**, *italic*, lists, links, `code`. HTML is not rendered." />
            <div className="rounded-md border border-[var(--border)] p-3">
              <Markdown source={c.text ?? ""} />
            </div>
          </>
        )}

        {widget.type === "iframe" && <IframeConfig url={c.iframe_url ?? ""} onChange={(iframe_url) => set({ iframe_url })} />}

        {widget.type === "custom_html" && <CustomHtmlConfig html={c.custom_html?.html ?? ""} onChange={(html) => set({ custom_html: { html } })} />}

        {widget.type === "image" && <TextField label="Image URL" type="url" value={c.image_url ?? ""} onChange={(e) => set({ image_url: e.target.value })} placeholder="https://…" hint="The widget title is used as alt text." />}

        {widget.type === "filter" && (
          <div className="grid gap-2">
            <SelectField
              label="Dataset (for values)"
              value={c.filter?.dataset_id ?? ""}
              onChange={(e) => set({ filter: { column: c.filter?.column ?? "", kind: c.filter?.kind ?? "dropdown", dataset_id: e.target.value } })}
              options={(datasets.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
              placeholder="Choose…"
            />
            <SelectField
              label="Column"
              value={c.filter?.column ?? ""}
              onChange={(e) => set({ filter: { dataset_id: c.filter?.dataset_id ?? "", kind: c.filter?.kind ?? "dropdown", column: e.target.value } })}
              options={toOptions(colNames)}
              placeholder="Choose…"
            />
            <SelectField
              label="Control"
              value={c.filter?.kind ?? "dropdown"}
              onChange={(e) => set({ filter: { dataset_id: c.filter?.dataset_id ?? "", column: c.filter?.column ?? "", kind: e.target.value as "dropdown" } })}
              options={[
                { value: "dropdown", label: "Dropdown" },
                { value: "multiselect", label: "Multi-select" },
                { value: "slider", label: "Range slider" },
                { value: "date", label: "Date range" },
              ]}
            />
          </div>
        )}

        {widget.type === "prediction" && (
          <SelectField label="Endpoint" value={c.endpoint ?? ""} onChange={(e) => set({ endpoint: e.target.value || undefined })} options={(endpoints.data ?? []).map((e) => ({ value: e.name, label: e.name }))} placeholder="Choose…" />
        )}

        <fieldset className="grid grid-cols-4 gap-2">
          <legend className="mb-1 text-xs font-semibold">Position & size (grid units)</legend>
          {(["x", "y", "w", "h"] as const).map((k) => (
            <TextField key={k} label={k} type="number" min={k === "w" || k === "h" ? 1 : 0} max={k === "x" || k === "w" ? 12 : undefined} value={widget.layout[k]} onChange={(e) => onChange({ ...widget, layout: { ...widget.layout, [k]: Math.max(k === "w" || k === "h" ? 1 : 0, Number(e.target.value) || 0) } })} />
          ))}
        </fieldset>
      </div>
    </Modal>
  );
}

function IframeConfig({ url, onChange }: { url: string; onChange: (v: string) => void }) {
  const check = url ? validateIframeUrl(url, { blockedOrigins: appOrigins(), allowlist: configuredAllowlist() }) : null;
  const allowlist = configuredAllowlist();
  return (
    <div className="space-y-2">
      <TextField
        label="Page URL"
        type="url"
        value={url}
        onChange={(e) => onChange(e.target.value)}
        placeholder="https://…"
        error={check && !check.ok ? check.error : null}
        hint="https only. The page runs in a sandboxed iframe (no top-level navigation) and gets no referrer."
      />
      {check?.ok && check.warning && (
        <p role="alert" className="text-xs text-amber-800 dark:text-amber-300">
          ⚠ {check.warning}
        </p>
      )}
      <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
        Only domains allowlisted by your organization can be embedded
        {allowlist.length ? ` (${allowlist.join(", ")})` : ""}; the embedded site must also allow framing (X-Frame-Options / frame-ancestors), otherwise the widget stays blank.
      </p>
    </div>
  );
}

function CustomHtmlConfig({ html, onChange }: { html: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-2">
      <TextArea label="HTML / JavaScript" mono rows={12} value={html} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      <div className="space-y-1 rounded-md bg-[var(--surface-2)] p-2 text-xs text-[var(--text-2)]">
        <p>
          Runs in a sandboxed iframe (<code>sandbox=&quot;allow-scripts&quot;</code>, opaque origin) with a CSP that blocks all network requests. It can&apos;t access the app, your session or other widgets.
        </p>
        <p>
          The widget&apos;s query result arrives via postMessage: define <code>window.onWidgetData = (data) =&gt; …</code> or listen for the <code>ap:data</code> event; <code>data</code> is <code>{"{title, columns, rows}"}</code>.
        </p>
      </div>
      <Button size="sm" onClick={() => onChange(CUSTOM_HTML_EXAMPLE)}>
        Insert example
      </Button>
    </div>
  );
}
