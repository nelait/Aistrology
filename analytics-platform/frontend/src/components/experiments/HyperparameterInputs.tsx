"use client";
/** Hyperparameter inputs with documentation tooltips (CFG-002). */
import type { Algorithm, Hyperparameter, JsonValue } from "@/lib/api";
import { InfoTip, SelectField, TextField } from "../ui";

function hpDescription(h: Hyperparameter): string {
  const parts = [h.help];
  parts.push(`Default: ${JSON.stringify(h.default)}.`);
  if (h.min !== null && h.min !== undefined) parts.push(`Range: ${h.min} – ${h.max ?? "∞"}${h.log ? " (log scale)" : ""}.`);
  if (h.choices?.length) parts.push(`Choices: ${h.choices.map((c) => JSON.stringify(c)).join(", ")}.`);
  return parts.join(" ");
}

export function HyperparameterInputs({ algo, values, onChange }: { algo: Algorithm; values: Record<string, JsonValue>; onChange: (v: Record<string, JsonValue>) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {algo.hyperparameters.map((h) => {
        const v = values[h.name];
        const label = (
          <span className="inline-flex items-center gap-1">
            {h.name} <InfoTip text={hpDescription(h)} label={`About ${h.name}`} />
          </span>
        );
        if (h.choices?.length)
          return (
            <SelectField
              key={h.name}
              label={label}
              value={v === undefined ? "" : JSON.stringify(v)}
              onChange={(e) => {
                const next = { ...values };
                if (e.target.value === "") delete next[h.name];
                else next[h.name] = JSON.parse(e.target.value) as JsonValue;
                onChange(next);
              }}
              options={h.choices.map((c) => ({ value: JSON.stringify(c), label: String(c) }))}
              placeholder={`default (${String(h.default)})`}
            />
          );
        if (h.type === "bool")
          return (
            <SelectField
              key={h.name}
              label={label}
              value={v === undefined ? "" : String(v)}
              onChange={(e) => {
                const next = { ...values };
                if (e.target.value === "") delete next[h.name];
                else next[h.name] = e.target.value === "true";
                onChange(next);
              }}
              options={[
                { value: "true", label: "true" },
                { value: "false", label: "false" },
              ]}
              placeholder={`default (${String(h.default)})`}
            />
          );
        return (
          <TextField
            key={h.name}
            label={label}
            type={h.type === "int" || h.type === "float" ? "number" : "text"}
            step={h.type === "int" ? 1 : "any"}
            min={h.min ?? undefined}
            max={h.max ?? undefined}
            placeholder={`default (${String(h.default)})`}
            value={v === undefined || v === null ? "" : String(v)}
            onChange={(e) => {
              const next = { ...values };
              if (e.target.value === "") delete next[h.name];
              else next[h.name] = h.type === "int" ? parseInt(e.target.value, 10) : h.type === "float" ? Number(e.target.value) : e.target.value;
              onChange(next);
            }}
          />
        );
      })}
    </div>
  );
}
