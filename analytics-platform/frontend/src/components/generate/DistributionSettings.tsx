"use client";
/** Per-field distributions (GEN-006): uniform (default), normal, lognormal or custom weights. */
import { useMemo } from "react";
import type { Schema } from "@/lib/types";
import { EMPTY_DRAFT, distributionTargets, toDistribution, type DistributionDraft } from "@/lib/distributions";
import { SelectField, TextField } from "../ui";

const KIND_OPTIONS = [
  { value: "uniform", label: "Uniform (default)" },
  { value: "normal", label: "Normal" },
  { value: "lognormal", label: "Lognormal (right-skewed)" },
  { value: "weights", label: "Custom weights" },
];

export function DistributionSettings({ schema, value, onChange }: { schema: Schema; value: Record<string, DistributionDraft>; onChange: (v: Record<string, DistributionDraft>) => void }) {
  const targets = useMemo(() => distributionTargets(schema), [schema]);
  if (!targets.length) return <p className="text-sm text-[var(--text-2)]">No numeric or categorical fields to configure.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Value distribution per field</caption>
        <thead className="text-xs text-[var(--text-2)]">
          <tr>
            <th scope="col" className="py-1 pr-3">Field</th>
            <th scope="col" className="py-1 pr-3">Distribution</th>
            <th scope="col" className="py-1">Parameters</th>
          </tr>
        </thead>
        <tbody>
          {targets.map((t) => {
            const d = value[t.key] ?? EMPTY_DRAFT;
            const set = (patch: Partial<DistributionDraft>) => onChange({ ...value, [t.key]: { ...d, ...patch } });
            const numeric = t.type === "integer" || t.type === "number";
            const { error } = toDistribution(d);
            const kinds = numeric ? KIND_OPTIONS : KIND_OPTIONS.filter((k) => k.value === "uniform" || k.value === "weights");
            return (
              <tr key={t.key} className="border-t border-[var(--border)] align-top">
                <td className="py-2 pr-3">
                  <span className="font-mono text-xs">{t.key}</span>
                  <span className="block text-xs text-[var(--text-2)]">{t.type}</span>
                </td>
                <td className="py-2 pr-3">
                  <SelectField label={`Distribution for ${t.key}`} srOnlyLabel value={d.kind} onChange={(e) => set({ kind: e.target.value as DistributionDraft["kind"] })} options={kinds} />
                </td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-2">
                    {(d.kind === "normal" || d.kind === "lognormal") && (
                      <TextField className="w-28" label={d.kind === "lognormal" ? "Log mean" : "Mean"} type="number" step="any" value={d.mean} onChange={(e) => set({ mean: e.target.value })} placeholder="auto" />
                    )}
                    {d.kind === "normal" && <TextField className="w-28" label="Std dev" type="number" step="any" min={0} value={d.std} onChange={(e) => set({ std: e.target.value })} placeholder="auto" />}
                    {d.kind === "lognormal" && <TextField className="w-28" label="Sigma" type="number" step="any" min={0} max={10} value={d.sigma} onChange={(e) => set({ sigma: e.target.value })} placeholder="0.75" />}
                    {d.kind === "weights" && (
                      <TextField
                        className="min-w-64 flex-1"
                        label="value=weight pairs"
                        value={d.weights}
                        onChange={(e) => set({ weights: e.target.value })}
                        placeholder={t.enumValues ? t.enumValues.slice(0, 3).map((v, i) => `${v}=${i + 1}`).join(", ") : "gold=1, silver=3"}
                        hint={t.enumValues ? `Enum values: ${t.enumValues.join(", ")} (missing ones get weight 0)` : "Values become the categories"}
                        error={error}
                      />
                    )}
                    {d.kind === "uniform" && <span className="text-xs text-[var(--text-2)]">Uniform over the field&apos;s range</span>}
                    {error && d.kind !== "weights" && (
                      <p role="alert" className="w-full text-xs text-red-700 dark:text-red-400">
                        {error}
                      </p>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-[var(--text-2)]">Numeric draws are clipped to each field&apos;s minimum/maximum. Output stays reproducible for a given seed.</p>
    </div>
  );
}
