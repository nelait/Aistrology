"use client";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ConditionalFormat, type Threshold, type Widget, type WidgetConfig } from "@/lib/api";
import { schemaColumns } from "@/lib/data";
import { ChartConfig } from "../analytics/ChartConfig";
import { Markdown } from "../Markdown";
import { SqlEditor } from "../SqlEditor";
import { Button, Modal, SelectField, TextArea, TextField, toOptions } from "../ui";

const OPS: Threshold["op"][] = [">", ">=", "<", "<=", "==", "!="];
const COLORS = [
  { value: "red", label: "Red (critical)" },
  { value: "amber", label: "Amber (warning)" },
  { value: "green", label: "Green (ok)" },
];

/** Per-widget configuration (WCFG-001, WCFG-003). */
export function WidgetConfigDrawer({ widget, onChange, onClose }: { widget: Widget | null; onChange: (w: Widget) => void; onClose: () => void }) {
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: api.datasets.list });
  const analytics = useQuery({ queryKey: ["analytics"], queryFn: api.analytics.list });
  const endpoints = useQuery({ queryKey: ["endpoints"], queryFn: api.endpoints.list, enabled: widget?.type === "prediction", meta: { silent: true } });

  const c = widget?.config ?? {};
  const datasetId = c.dataset_id ?? (c.analytic_id ? analytics.data?.find((a) => a.id === c.analytic_id)?.dataset_id : undefined) ?? c.filter?.dataset_id;
  const columns = useMemo(() => schemaColumns(datasets.data?.find((d) => d.id === datasetId)?.schema), [datasets.data, datasetId]);
  const colNames = columns.map((x) => x.name);

  if (!widget) return <Modal open={false} onClose={onClose} title="" side>{null}</Modal>;
  const set = (patch: Partial<WidgetConfig>) => onChange({ ...widget, config: { ...widget.config, ...patch } });
  const needsSource = ["chart", "kpi", "table", "alert"].includes(widget.type);
  const sourceKind = c.analytic_id ? "analytic" : "sql";

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
              onChange={(e) => (e.target.value === "analytic" ? set({ sql: undefined, analytic_id: analytics.data?.[0]?.id }) : set({ analytic_id: undefined, sql: c.sql ?? "SELECT *\nFROM data\nLIMIT 100" }))}
              options={[
                { value: "analytic", label: "Saved analytic" },
                { value: "sql", label: "Dataset + SQL" },
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
                {c.dataset_id && <SqlEditor value={c.sql ?? ""} onChange={(sql) => set({ sql })} columns={columns} height={160} label="Widget SQL" />}
              </>
            )}
            <p className="text-xs text-[var(--text-2)]">Global filters and cross-filters are applied server-side to columns with matching names.</p>
          </fieldset>
        )}

        {widget.type === "chart" && <ChartConfig spec={c.chart ?? { type: "bar" }} onChange={(chart) => set({ chart })} columns={colNames} />}

        {widget.type === "kpi" && (
          <div className="grid gap-2">
            <SelectField label="Value column" value={c.kpi?.value ?? ""} onChange={(e) => set({ kpi: { ...c.kpi, value: e.target.value } })} options={toOptions(colNames)} placeholder="(first numeric)" />
            <TextField label="Target" type="number" value={c.kpi?.target ?? ""} onChange={(e) => set({ kpi: { value: c.kpi?.value ?? "", ...c.kpi, target: e.target.value === "" ? null : Number(e.target.value) } })} />
            <SelectField label="Trend (sparkline) column" value={c.kpi?.trend ?? ""} onChange={(e) => set({ kpi: { value: c.kpi?.value ?? "", ...c.kpi, trend: e.target.value || null } })} options={toOptions(colNames)} placeholder="(none)" hint="Rows ordered by time; last two points give the change." />
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
            <SelectField label="Value column" value={c.value_column ?? ""} onChange={(e) => set({ value_column: e.target.value || undefined })} options={toOptions(colNames)} placeholder="(first numeric)" />
            {(c.thresholds ?? []).map((t, i) => {
              const upd = (p: Partial<Threshold>) => set({ thresholds: (c.thresholds ?? []).map((x, j) => (j === i ? { ...x, ...p } : x)) });
              return (
                <div key={i} className="grid grid-cols-[4.5rem_1fr_1fr_auto] items-end gap-1">
                  <SelectField label="Op" value={t.op} onChange={(e) => upd({ op: e.target.value as Threshold["op"] })} options={toOptions(OPS)} />
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
