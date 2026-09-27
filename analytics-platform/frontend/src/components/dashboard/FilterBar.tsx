"use client";
import { useQuery } from "@tanstack/react-query";
import { api, type FilterValue, type GlobalFilter } from "@/lib/api";
import { DATE_PRESETS, type CrossFilter } from "@/lib/dashboard";
import { quoteIdent } from "@/lib/sql";
import { Button, SelectField, TextField } from "../ui";

function GlobalFilterControl({ filter, datasetId, value, onChange }: { filter: GlobalFilter; datasetId: string | null; value: FilterValue | null; onChange: (v: FilterValue | null) => void }) {
  const opts = useQuery({
    queryKey: ["filter-options", datasetId, filter.column, "distinct"],
    queryFn: () => api.datasets.query(datasetId!, `SELECT DISTINCT ${quoteIdent(filter.column)} AS v FROM data WHERE ${quoteIdent(filter.column)} IS NOT NULL ORDER BY 1 LIMIT 500`, 500),
    enabled: !!datasetId && (filter.kind === "dropdown" || filter.kind === "multiselect"),
    staleTime: 5 * 60_000,
    meta: { silent: true },
  });
  const values = (opts.data?.rows ?? []).map((r) => String(r[0]));
  if ((filter.kind === "dropdown" || filter.kind === "multiselect") && values.length) {
    if (filter.kind === "dropdown")
      return <SelectField label={filter.column} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} options={values.map((v) => ({ value: v, label: v }))} placeholder="All" />;
    const sel = Array.isArray(value) ? value.map(String) : [];
    return (
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-[var(--text-2)]" htmlFor={`gf-${filter.id}`}>
          {filter.column}
        </label>
        <select
          id={`gf-${filter.id}`}
          multiple
          size={Math.min(4, values.length)}
          value={sel}
          onChange={(e) => onChange(Array.from(e.target.selectedOptions).map((o) => o.value))}
          className="min-w-40 rounded-md border border-[var(--border)] bg-[var(--surface)] px-1 text-sm"
        >
          {values.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </div>
    );
  }
  if (filter.kind === "slider" || filter.kind === "date") {
    const cur = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const type = filter.kind === "date" ? "date" : "number";
    return (
      <div className="flex items-end gap-1">
        <TextField className="w-36" label={`${filter.column} from`} type={type} value={String(cur.min ?? "")} onChange={(e) => onChange({ ...cur, min: e.target.value === "" ? undefined : type === "number" ? Number(e.target.value) : e.target.value })} />
        <TextField className="w-36" label="to" type={type} value={String(cur.max ?? "")} onChange={(e) => onChange({ ...cur, max: e.target.value === "" ? undefined : type === "number" ? Number(e.target.value) : e.target.value })} />
      </div>
    );
  }
  return (
    <TextField
      label={filter.column}
      hint={filter.kind === "multiselect" ? "Comma-separated" : undefined}
      value={Array.isArray(value) ? value.join(", ") : typeof value === "string" || typeof value === "number" ? String(value) : ""}
      onChange={(e) =>
        onChange(
          filter.kind === "multiselect"
            ? e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : e.target.value || null,
        )
      }
    />
  );
}

/** Global filters, date range and active cross-filters, in one row above the widgets. */
export function FilterBar({
  filters,
  values,
  onChange,
  datasetFor,
  dateColumn,
  datePreset,
  onDatePreset,
  customRange,
  onCustomRange,
  cross,
  onClearCross,
}: {
  filters: GlobalFilter[];
  values: Record<string, FilterValue | null>;
  onChange: (column: string, v: FilterValue | null) => void;
  datasetFor: (column: string) => string | null;
  dateColumn: string | null;
  datePreset: string;
  onDatePreset: (p: string) => void;
  customRange: { from?: string; to?: string };
  onCustomRange: (r: { from?: string; to?: string }) => void;
  cross: CrossFilter[];
  onClearCross: (column?: string) => void;
}) {
  if (!filters.length && !dateColumn && !cross.length) return null;
  return (
    <div className="no-print flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3" role="group" aria-label="Dashboard filters">
      {dateColumn && (
        <>
          <SelectField label={`Date range (${dateColumn})`} value={datePreset} onChange={(e) => onDatePreset(e.target.value)} options={DATE_PRESETS} />
          {datePreset === "custom" && (
            <>
              <TextField label="From" type="date" value={customRange.from ?? ""} onChange={(e) => onCustomRange({ ...customRange, from: e.target.value })} />
              <TextField label="To" type="date" value={customRange.to ?? ""} onChange={(e) => onCustomRange({ ...customRange, to: e.target.value })} />
            </>
          )}
        </>
      )}
      {filters
        .filter((f) => f.column)
        .map((f) => (
          <GlobalFilterControl key={f.id} filter={f} datasetId={datasetFor(f.column)} value={values[f.column] ?? null} onChange={(v) => onChange(f.column, v)} />
        ))}
      {cross.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" aria-live="polite">
          <span className="text-xs text-[var(--text-2)]">Cross-filters:</span>
          {cross.map((c) => (
            <button key={c.column} type="button" onClick={() => onClearCross(c.column)} className="rounded-full border border-brand-400 bg-brand-50 px-2 py-0.5 text-xs dark:bg-brand-900/40" aria-label={`Remove cross-filter ${c.column} = ${c.value}`}>
              {c.column} = {c.value} ✕
            </button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => onClearCross()}>
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
}
