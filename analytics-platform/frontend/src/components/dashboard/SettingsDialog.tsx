"use client";
import type { DashboardSpec, GlobalFilter } from "@/lib/types";
import { DATE_PRESETS, REFRESH_OPTIONS } from "@/lib/dashboard";
import { uid } from "@/lib/data";
import { Button, Modal, SelectField, TextField } from "../ui";

/** Global filters, date range, auto-refresh and theme (DSH-004/005/006/008). */
export function SettingsDialog({ spec, columns, open, onClose, onChange }: { spec: DashboardSpec; columns: string[]; open: boolean; onClose: () => void; onChange: (s: DashboardSpec) => void }) {
  const filters = spec.filters ?? [];
  const setFilter = (i: number, p: Partial<GlobalFilter>) => onChange({ ...spec, filters: filters.map((f, j) => (j === i ? { ...f, ...p } : f)) });
  const colOpts = columns.map((c) => ({ value: c, label: c }));
  return (
    <Modal open={open} onClose={onClose} title="Dashboard settings" side footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="space-y-5">
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">Global filters</legend>
          <p className="text-xs text-[var(--text-2)]">Applied to every widget whose data has a column with the same name.</p>
          {filters.map((f, i) => (
            <div key={f.id} className="flex items-end gap-2">
              {columns.length ? (
                <SelectField className="flex-1" label="Column" value={f.column} onChange={(e) => setFilter(i, { column: e.target.value })} options={colOpts} placeholder="Choose…" />
              ) : (
                <TextField className="flex-1" label="Column" value={f.column} onChange={(e) => setFilter(i, { column: e.target.value })} />
              )}
              <SelectField
                label="Control"
                value={f.kind}
                onChange={(e) => setFilter(i, { kind: e.target.value as GlobalFilter["kind"], default: e.target.value === "multiselect" ? [] : null })}
                options={[
                  { value: "dropdown", label: "Dropdown" },
                  { value: "multiselect", label: "Multi-select" },
                  { value: "text", label: "Text" },
                  { value: "slider", label: "Range" },
                  { value: "date", label: "Date range" },
                ]}
              />
              <Button size="sm" variant="ghost" aria-label={`Remove filter ${f.column}`} onClick={() => onChange({ ...spec, filters: filters.filter((_, j) => j !== i) })}>
                ✕
              </Button>
            </div>
          ))}
          <Button size="sm" onClick={() => onChange({ ...spec, filters: [...filters, { id: uid("f"), column: columns[0] ?? "", kind: "multiselect", default: [] }] })}>
            + Add global filter
          </Button>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">Date range</legend>
          <div className="grid grid-cols-2 gap-2">
            <SelectField
              label="Date column"
              value={spec.date_range?.column ?? ""}
              onChange={(e) => onChange({ ...spec, date_range: e.target.value ? { column: e.target.value, default: spec.date_range?.default ?? "last_90_days" } : null })}
              options={colOpts}
              placeholder="(no date control)"
            />
            <SelectField
              label="Default range"
              disabled={!spec.date_range}
              value={spec.date_range?.default ?? "last_90_days"}
              onChange={(e) => spec.date_range && onChange({ ...spec, date_range: { ...spec.date_range, default: e.target.value } })}
              options={DATE_PRESETS.filter((p) => p.value !== "custom")}
            />
          </div>
        </fieldset>

        <SelectField
          label="Auto-refresh"
          value={String(spec.refresh_seconds ?? 0)}
          onChange={(e) => onChange({ ...spec, refresh_seconds: Number(e.target.value) })}
          options={REFRESH_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
        />

        <fieldset className="grid grid-cols-2 gap-2">
          <legend className="mb-1 text-sm font-semibold">Theme</legend>
          <SelectField
            label="Export / embed mode"
            value={spec.theme?.mode ?? "light"}
            onChange={(e) => onChange({ ...spec, theme: { primary: spec.theme?.primary ?? "#2a78d6", mode: e.target.value as "light" | "dark" } })}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            hint="In the app, dashboards follow your light/dark setting."
          />
          <TextField label="Accent color" type="color" value={spec.theme?.primary ?? "#2a78d6"} onChange={(e) => onChange({ ...spec, theme: { mode: spec.theme?.mode ?? "light", primary: e.target.value } })} />
        </fieldset>
      </div>
    </Modal>
  );
}
