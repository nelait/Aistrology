"use client";
/** Visual query builder (USR-001): dimensions, measures, filters, sort, limit → SQL. */
import { FILTER_OPS, measureAlias, type BuilderAggregation, type FilterOp, type QueryModel } from "@/lib/sql";
import { Button, MultiSelect, SelectField, TextField, toOptions } from "../ui";

const AGGS: { value: BuilderAggregation; label: string }[] = [
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "count", label: "Count" },
  { value: "count_distinct", label: "Count distinct" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
  { value: "none", label: "No aggregation" },
];

export function QueryBuilder({ model, onChange, columns }: { model: QueryModel; onChange: (m: QueryModel) => void; columns: { name: string; type: string }[] }) {
  const colOpts = toOptions(columns.map((c) => c.name));
  const set = (patch: Partial<QueryModel>) => onChange({ ...model, ...patch });

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <MultiSelect label="Group by (dimensions)" options={colOpts} value={model.dimensions} onChange={(dimensions) => set({ dimensions })} maxHeight={150} ordered />

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-[var(--text-2)]">Measures</legend>
        {model.measures.map((m, i) => (
          <div key={i} className="flex items-end gap-2">
            <SelectField
              className="flex-1"
              label={`Measure ${i + 1} column`}
              value={m.column}
              onChange={(e) => set({ measures: model.measures.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)) })}
              options={[{ value: "*", label: "* (all rows)" }, ...colOpts]}
              placeholder="Column…"
            />
            <SelectField
              label={`Measure ${i + 1} aggregation`}
              value={m.aggregation}
              onChange={(e) => set({ measures: model.measures.map((x, j) => (j === i ? { ...x, aggregation: e.target.value as BuilderAggregation } : x)) })}
              options={AGGS}
            />
            <Button size="sm" variant="ghost" aria-label={`Remove measure ${i + 1}`} onClick={() => set({ measures: model.measures.filter((_, j) => j !== i) })}>
              ✕
            </Button>
          </div>
        ))}
        <Button size="sm" onClick={() => set({ measures: [...model.measures, { column: "*", aggregation: "count" }] })}>
          + Add measure
        </Button>
      </fieldset>

      <fieldset className="space-y-2 lg:col-span-2">
        <legend className="text-xs font-medium text-[var(--text-2)]">Filters</legend>
        {model.filters.map((f, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <SelectField
              label={`Filter ${i + 1} column`}
              value={f.column}
              onChange={(e) => set({ filters: model.filters.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)) })}
              options={colOpts}
              placeholder="Column…"
            />
            <SelectField
              label="Operator"
              value={f.op}
              onChange={(e) => set({ filters: model.filters.map((x, j) => (j === i ? { ...x, op: e.target.value as FilterOp } : x)) })}
              options={FILTER_OPS}
            />
            {f.op !== "is_null" && f.op !== "not_null" && (
              <TextField
                label={f.op === "in" ? "Values (comma-separated)" : f.op === "between" ? "From" : "Value"}
                hint={i === 0 ? "Use :name for a parameter" : undefined}
                value={f.value ?? ""}
                onChange={(e) => set({ filters: model.filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
              />
            )}
            {f.op === "between" && (
              <TextField label="To" value={f.value2 ?? ""} onChange={(e) => set({ filters: model.filters.map((x, j) => (j === i ? { ...x, value2: e.target.value } : x)) })} />
            )}
            <Button size="sm" variant="ghost" aria-label={`Remove filter ${i + 1}`} onClick={() => set({ filters: model.filters.filter((_, j) => j !== i) })}>
              ✕
            </Button>
          </div>
        ))}
        <Button size="sm" onClick={() => set({ filters: [...model.filters, { column: columns[0]?.name ?? "", op: "=", value: "" }] })}>
          + Add filter
        </Button>
      </fieldset>

      <div className="flex flex-wrap items-end gap-2 lg:col-span-2">
        <SelectField
          label="Order by"
          value={model.orderBy?.column ?? ""}
          onChange={(e) => set({ orderBy: e.target.value ? { column: e.target.value, direction: model.orderBy?.direction ?? "desc" } : null })}
          options={[...model.dimensions, ...model.measures.map(measureAlias)]
            .filter((v, i, a) => v && a.indexOf(v) === i)
            .map((v) => ({ value: v, label: v }))}
          placeholder="(default)"
        />
        <SelectField
          label="Direction"
          value={model.orderBy?.direction ?? "desc"}
          disabled={!model.orderBy}
          onChange={(e) => model.orderBy && set({ orderBy: { ...model.orderBy, direction: e.target.value as "asc" | "desc" } })}
          options={[
            { value: "desc", label: "Descending" },
            { value: "asc", label: "Ascending" },
          ]}
        />
        <TextField label="Limit" type="number" min={1} max={10000} value={model.limit ?? ""} onChange={(e) => set({ limit: e.target.value ? Number(e.target.value) : null })} className="w-28" />
      </div>
    </div>
  );
}
