/** Helpers to render a SchemaDiff (SCH-010, INF-007/008) as a flat, color-coded change list. */
import type { SchemaDiff } from "./types";

export type DiffKind = "entity_added" | "entity_removed" | "field_added" | "field_removed" | "retyped" | "changed";

export interface DiffRow {
  entity: string;
  kind: DiffKind;
  field?: string;
  detail: string;
  /** This change can break downstream consumers (mirrors the server's `breaking` rules). */
  breaking: boolean;
}

export const DIFF_LABEL: Record<DiffKind, string> = {
  entity_added: "Entity added",
  entity_removed: "Entity removed",
  field_added: "Added",
  field_removed: "Removed",
  retyped: "Type changed",
  changed: "Changed",
};

export const DIFF_TONE: Record<DiffKind, "good" | "critical" | "warning" | "info"> = {
  entity_added: "good",
  field_added: "good",
  entity_removed: "critical",
  field_removed: "critical",
  retyped: "warning",
  changed: "info",
};

/** Text for an attribute value in a diff (null → "—", arrays → comma list, objects → JSON). */
export function formatDiffValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.map((x) => formatDiffValue(x)).join(", ") : "[]";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function narrowedEnum(from: unknown, to: unknown): boolean {
  if (!Array.isArray(from) || from.length === 0) return false;
  if (!Array.isArray(to)) return false; // enum removed = widened
  const next = new Set(to.map((x) => JSON.stringify(x)));
  return from.some((x) => !next.has(JSON.stringify(x)));
}

/** Is a single attribute change breaking? nullable → required, and narrowed enums are. */
export function isBreakingChange(attribute: string, from: unknown, to: unknown): boolean {
  if (attribute === "nullable") return from === true && to === false;
  if (attribute === "enum") return narrowedEnum(from, to);
  return false;
}

/** Flatten a SchemaDiff into rows ordered by entity, then added → removed → retyped → changed. */
export function flattenDiff(diff: SchemaDiff | null | undefined): DiffRow[] {
  if (!diff) return [];
  const rows: DiffRow[] = [];
  for (const e of diff.added_entities ?? []) rows.push({ entity: e, kind: "entity_added", detail: "new entity", breaking: false });
  for (const e of diff.removed_entities ?? []) rows.push({ entity: e, kind: "entity_removed", detail: "entity removed", breaking: true });
  for (const e of diff.entities ?? []) {
    for (const f of e.added_fields ?? [])
      rows.push({ entity: e.name, kind: "field_added", field: f.name, detail: `${f.type}${f.nullable ? ", nullable" : ", required"}`, breaking: !f.nullable });
    for (const f of e.removed_fields ?? []) rows.push({ entity: e.name, kind: "field_removed", field: f.name, detail: f.type, breaking: true });
    for (const r of e.retyped_fields ?? []) rows.push({ entity: e.name, kind: "retyped", field: r.field, detail: `${r.from_type} → ${r.to_type}`, breaking: true });
    for (const c of e.changed_fields ?? [])
      rows.push({
        entity: e.name,
        kind: "changed",
        field: c.field,
        detail: `${c.attribute}: ${formatDiffValue(c.from)} → ${formatDiffValue(c.to)}`,
        breaking: isBreakingChange(c.attribute, c.from, c.to),
      });
  }
  return rows;
}

export interface DiffCounts {
  added: number;
  removed: number;
  changed: number;
  breaking: number;
}

export function diffCounts(diff: SchemaDiff | null | undefined): DiffCounts {
  const rows = flattenDiff(diff);
  return {
    added: rows.filter((r) => r.kind === "field_added" || r.kind === "entity_added").length,
    removed: rows.filter((r) => r.kind === "field_removed" || r.kind === "entity_removed").length,
    changed: rows.filter((r) => r.kind === "retyped" || r.kind === "changed").length,
    breaking: rows.filter((r) => r.breaking).length,
  };
}

/** One-line summary, e.g. "2 added · 1 removed · 3 changed". */
export function diffSummary(diff: SchemaDiff | null | undefined): string {
  if (!diff || diff.identical) return "No changes";
  const c = diffCounts(diff);
  const parts = [c.added && `${c.added} added`, c.removed && `${c.removed} removed`, c.changed && `${c.changed} changed`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No structural changes";
}
