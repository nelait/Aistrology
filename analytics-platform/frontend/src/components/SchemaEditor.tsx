"use client";
/** Editable schema field table (INF-006): name, type, nullable, PK, PII, semantic. */
import { useState } from "react";
import { FIELD_TYPES, PII_SEMANTICS, SEMANTICS, type ColumnReport, type Schema, type SchemaField } from "@/lib/types";
import { formatPercent } from "@/lib/format";
import { Badge, Button, Tabs, cx } from "./ui";

const cell = "border-b border-[var(--border)] px-2 py-1 align-middle";
const input = "w-full rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-1 text-xs";

export function SchemaEditor({
  schema,
  onChange,
  reports,
  readOnly,
}: {
  schema: Schema;
  onChange: (s: Schema) => void;
  reports?: ColumnReport[];
  readOnly?: boolean;
}) {
  const [active, setActive] = useState(0);
  const entity = schema.entities[Math.min(active, schema.entities.length - 1)];
  if (!entity) return <p className="text-sm text-[var(--text-2)]">No entities in this schema.</p>;
  const entityIndex = schema.entities.indexOf(entity);

  const update = (i: number, patch: Partial<SchemaField>) => {
    const fields = entity.fields.map((f, j) => {
      if (j !== i) return f;
      const next = { ...f, ...patch };
      if (patch.primary_key) {
        next.nullable = false;
        next.unique = true;
      }
      if (patch.semantic !== undefined && patch.semantic && PII_SEMANTICS.has(patch.semantic)) next.pii = true;
      return next;
    });
    onChange({ ...schema, entities: schema.entities.map((e, k) => (k === entityIndex ? { ...e, fields } : e)) });
  };

  const remove = (i: number) =>
    onChange({ ...schema, entities: schema.entities.map((e, k) => (k === entityIndex ? { ...e, fields: e.fields.filter((_, j) => j !== i) } : e)) });

  const add = () =>
    onChange({
      ...schema,
      entities: schema.entities.map((e, k) =>
        k === entityIndex ? { ...e, fields: [...e.fields, { name: `field_${e.fields.length + 1}`, type: "string", nullable: true, primary_key: false, unique: false, pii: false }] } : e,
      ),
    });

  const report = (name: string) => reports?.find((r) => r.name === name);

  return (
    <div className="space-y-2">
      {schema.entities.length > 1 && (
        <Tabs label="Entities" tabs={schema.entities.map((e, i) => ({ id: String(i), label: e.name }))} active={String(entityIndex)} onChange={(id) => setActive(Number(id))} />
      )}
      <div className="overflow-auto rounded-md border border-[var(--border)]">
        <table className="w-full min-w-[760px] border-collapse text-xs">
          <caption className="sr-only">Fields of {entity.name}</caption>
          <thead className="bg-[var(--surface-2)] text-left">
            <tr>
              <th scope="col" className={cell}>Name</th>
              <th scope="col" className={cell}>Type</th>
              <th scope="col" className={cell}>Nullable</th>
              <th scope="col" className={cell}>Primary key</th>
              <th scope="col" className={cell}>PII</th>
              <th scope="col" className={cell}>Semantic</th>
              {reports && <th scope="col" className={cell}>Inference</th>}
              {!readOnly && <th scope="col" className={cell}><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {entity.fields.map((f, i) => {
              const r = report(f.name);
              const label = f.name || `field ${i + 1}`;
              return (
                <tr key={i}>
                  <td className={cell}>
                    <input aria-label={`Name of ${label}`} className={cx(input, "font-mono")} value={f.name} disabled={readOnly} onChange={(e) => update(i, { name: e.target.value })} />
                    {f.source_name && f.source_name !== f.name && <span className="text-[10px] text-[var(--text-2)]">from “{f.source_name}”</span>}
                  </td>
                  <td className={cell}>
                    <select aria-label={`Type of ${label}`} className={input} value={f.type} disabled={readOnly} onChange={(e) => update(i, { type: e.target.value as SchemaField["type"] })}>
                      {FIELD_TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </td>
                  <td className={cell}>
                    <input type="checkbox" aria-label={`${label} nullable`} className="h-4 w-4 accent-brand-600" checked={f.nullable} disabled={readOnly || f.primary_key} onChange={(e) => update(i, { nullable: e.target.checked })} />
                  </td>
                  <td className={cell}>
                    <input type="checkbox" aria-label={`${label} is primary key`} className="h-4 w-4 accent-brand-600" checked={f.primary_key} disabled={readOnly} onChange={(e) => update(i, { primary_key: e.target.checked })} />
                  </td>
                  <td className={cell}>
                    <input type="checkbox" aria-label={`${label} contains PII`} className="h-4 w-4 accent-brand-600" checked={f.pii} disabled={readOnly || (!!f.semantic && PII_SEMANTICS.has(f.semantic))} onChange={(e) => update(i, { pii: e.target.checked })} />
                  </td>
                  <td className={cell}>
                    <select aria-label={`Semantic of ${label}`} className={input} value={f.semantic ?? ""} disabled={readOnly} onChange={(e) => update(i, { semantic: (e.target.value || null) as SchemaField["semantic"] })}>
                      <option value="">—</option>
                      {SEMANTICS.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                  {reports && (
                    <td className={cell}>
                      {r ? (
                        <span className="flex flex-wrap gap-1">
                          <Badge>{r.role}</Badge>
                          <Badge>{formatPercent(r.null_fraction, 0)} null</Badge>
                          {r.primary_key_candidate && <Badge tone="info">PK?</Badge>}
                          {r.detected_format && <Badge>{r.detected_format}</Badge>}
                          {r.ambiguous_formats?.length ? <Badge tone="warning">ambiguous date</Badge> : null}
                          {r.parse_rate !== null && r.parse_rate !== undefined && r.parse_rate < 1 && <Badge tone="warning">{formatPercent(r.parse_rate, 0)} parse</Badge>}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  )}
                  {!readOnly && (
                    <td className={cell}>
                      <Button size="sm" variant="ghost" onClick={() => remove(i)} aria-label={`Remove ${label}`}>
                        ✕
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <Button size="sm" onClick={add}>
          + Add field
        </Button>
      )}
    </div>
  );
}
