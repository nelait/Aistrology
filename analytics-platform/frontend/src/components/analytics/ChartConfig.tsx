"use client";
import { CHART_TYPES, type ChartSpec } from "@/lib/types";
import { SelectField, cx, toOptions } from "../ui";

const HELP: Record<string, string> = {
  bar: "Compare categories",
  line: "Trend over time",
  area: "Cumulative trend",
  scatter: "Relationship of two numbers",
  pie: "Share of a whole (≤ 8 slices)",
  heatmap: "Two categories × value",
  histogram: "Distribution of a number",
  box: "Spread per category",
  treemap: "Hierarchical share",
  funnel: "Stage conversion",
  gauge: "Single value vs range",
  sankey: "Flows source → target (x → series)",
  waterfall: "Running total of changes",
};

/** Chart type picker + field mapping (VIZ-001, WCFG-001). */
export function ChartConfig({ spec, onChange, columns }: { spec: ChartSpec; onChange: (s: ChartSpec) => void; columns: string[] }) {
  const opts = toOptions(columns);
  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-[var(--text-2)]">Chart type</legend>
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5 lg:grid-cols-7">
          {CHART_TYPES.map((t) => (
            <label
              key={t}
              title={HELP[t]}
              className={cx(
                "flex cursor-pointer flex-col rounded-md border px-2 py-1.5 text-xs focus-within:outline focus-within:outline-2 focus-within:outline-brand-500",
                spec.type === t ? "border-brand-500 bg-brand-50 font-medium dark:bg-brand-900/30" : "border-[var(--border)] hover:bg-[var(--surface-2)]",
              )}
            >
              <input type="radio" name="chart-type" value={t} checked={spec.type === t} onChange={() => onChange({ ...spec, type: t })} className="sr-only" />
              <span className="capitalize">{t}</span>
              <span className="truncate text-[10px] font-normal text-[var(--text-2)]">{HELP[t]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <SelectField label={spec.type === "sankey" ? "Source (x)" : "X / category"} value={spec.x ?? ""} onChange={(e) => onChange({ ...spec, x: e.target.value || null })} options={opts} placeholder="(auto)" />
        <SelectField label="Y / value" value={spec.y ?? ""} onChange={(e) => onChange({ ...spec, y: e.target.value || null })} options={opts} placeholder="(auto)" />
        <SelectField label={spec.type === "sankey" ? "Target (series)" : "Series / color"} value={spec.series ?? ""} onChange={(e) => onChange({ ...spec, series: e.target.value || null })} options={opts} placeholder="(none)" />
        <SelectField
          label="Aggregation"
          value={spec.aggregation ?? ""}
          onChange={(e) => onChange({ ...spec, aggregation: (e.target.value || null) as ChartSpec["aggregation"] })}
          options={toOptions(["sum", "avg", "count", "min", "max"])}
          placeholder="(sum)"
        />
      </div>
    </div>
  );
}
