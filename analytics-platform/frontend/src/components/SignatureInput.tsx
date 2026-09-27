"use client";
import type { SignatureField } from "@/lib/types";
import { formatNumber } from "@/lib/format";
import { SelectField, TextField } from "./ui";

/** One input generated from a model signature field (categories → select, numbers → number input with range hint). */
export function SignatureInput({ field, value, onChange }: { field: SignatureField; value: string; onChange: (v: string) => void }) {
  const numeric = /(int|float|number|double|decimal)/i.test(field.type);
  if (field.categories?.length)
    return <SelectField label={field.name} value={value} onChange={(e) => onChange(e.target.value)} options={field.categories.map((c) => ({ value: c, label: c }))} placeholder="(missing)" />;
  if (/bool/i.test(field.type))
    return (
      <SelectField
        label={field.name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        options={[
          { value: "true", label: "true" },
          { value: "false", label: "false" },
        ]}
        placeholder="(missing)"
      />
    );
  return (
    <TextField
      label={field.name}
      type={numeric ? "number" : /datetime/i.test(field.type) ? "datetime-local" : /date/i.test(field.type) ? "date" : "text"}
      step="any"
      hint={numeric && field.min !== undefined && field.min !== null ? `Seen in training: ${formatNumber(field.min)} – ${formatNumber(field.max)}` : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
