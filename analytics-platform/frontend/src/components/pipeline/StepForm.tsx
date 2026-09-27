"use client";
import { STEP_DEF_BY_OP, isVisible, type StepFormState } from "@/lib/pipelineSteps";
import type { StepOp } from "@/lib/types";
import { Button, Checkbox, MultiSelect, SelectField, TextArea, TextField, toOptions } from "../ui";

/** Form for one cleaning step; fields come from STEP_DEFS so every contract `op` is covered. */
export function StepForm({
  op,
  values,
  onChange,
  columns,
  errors,
}: {
  op: StepOp;
  values: StepFormState;
  onChange: (v: StepFormState) => void;
  columns: string[];
  errors?: Record<string, string>;
}) {
  const def = STEP_DEF_BY_OP[op];
  const set = (name: string, v: StepFormState[string]) => onChange({ ...values, [name]: v });
  const colOptions = toOptions(columns);

  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--text-2)]">{def.description}</p>
      {def.fields
        .filter((f) => isVisible(f, values))
        .map((f) => {
          const err = errors?.[f.name];
          const label = `${f.label}${f.required ? " *" : ""}`;
          switch (f.kind) {
            case "columns":
              return (
                <div key={f.name}>
                  <MultiSelect label={label} hint={f.help} options={colOptions} value={(values[f.name] as string[]) ?? []} onChange={(v) => set(f.name, v)} ordered={op === "reorder"} />
                  {err && <p className="text-xs text-red-700 dark:text-red-400">{err}</p>}
                </div>
              );
            case "column":
              return <SelectField key={f.name} label={label} hint={f.help} error={err} value={(values[f.name] as string) ?? ""} onChange={(e) => set(f.name, e.target.value)} options={colOptions} placeholder="Choose a column…" />;
            case "enum":
              return (
                <SelectField
                  key={f.name}
                  label={label}
                  hint={f.help}
                  error={err}
                  value={(values[f.name] as string | null) ?? ""}
                  onChange={(e) => set(f.name, e.target.value === "" && f.nullable ? null : e.target.value)}
                  options={toOptions(f.options ?? [])}
                  placeholder={f.nullable ? "(unchanged)" : undefined}
                />
              );
            case "boolean":
              return <Checkbox key={f.name} label={f.label} hint={f.help} checked={Boolean(values[f.name])} onChange={(e) => set(f.name, e.target.checked)} />;
            case "number":
              return <TextField key={f.name} label={label} hint={f.help} error={err} type="number" min={f.min} max={f.max} step={f.step ?? "any"} value={(values[f.name] as string) ?? ""} onChange={(e) => set(f.name, e.target.value)} />;
            case "list":
              return (
                <TextField
                  key={f.name}
                  label={label}
                  hint={f.help}
                  error={err}
                  value={Array.isArray(values[f.name]) ? (values[f.name] as string[]).join(", ") : ((values[f.name] as string) ?? "")}
                  onChange={(e) => set(f.name, e.target.value.split(",").map((s) => s.trimStart()))}
                />
              );
            case "sql":
              return <TextArea key={f.name} label={label} hint={f.help} error={err} mono rows={3} value={(values[f.name] as string) ?? ""} onChange={(e) => set(f.name, e.target.value)} />;
            case "mapping": {
              const rows = (values[f.name] as { from: string; to: string }[]) ?? [];
              return (
                <fieldset key={f.name} className="space-y-2">
                  <legend className="text-xs font-medium text-[var(--text-2)]">{label}</legend>
                  {rows.map((r, i) => (
                    <div key={i} className="flex items-end gap-2">
                      <SelectField
                        className="flex-1"
                        label={`Column ${i + 1}`}
                        value={r.from}
                        onChange={(e) => set(f.name, rows.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))}
                        options={colOptions}
                        placeholder="Column…"
                      />
                      <TextField className="flex-1" label={`New name ${i + 1}`} value={r.to} onChange={(e) => set(f.name, rows.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
                      <Button size="sm" variant="ghost" aria-label={`Remove rename ${i + 1}`} onClick={() => set(f.name, rows.filter((_, j) => j !== i))}>
                        ✕
                      </Button>
                    </div>
                  ))}
                  <Button size="sm" onClick={() => set(f.name, [...rows, { from: "", to: "" }])}>
                    + Add rename
                  </Button>
                  {err && <p className="text-xs text-red-700 dark:text-red-400">{err}</p>}
                </fieldset>
              );
            }
            default:
              return <TextField key={f.name} label={label} hint={f.help} error={err} value={(values[f.name] as string) ?? ""} onChange={(e) => set(f.name, e.target.value)} />;
          }
        })}
    </div>
  );
}
