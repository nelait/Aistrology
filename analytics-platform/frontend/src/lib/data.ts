import type { Row, TabularResult } from "./types";

/** Normalize `{columns, rows}` where rows are arrays or objects into a list of records. */
export function toRecords(result: TabularResult | { columns: string[]; rows: unknown[][] } | null | undefined): Row[] {
  if (!result) return [];
  const { columns, rows } = result;
  return (rows as unknown[]).map((r) => {
    if (Array.isArray(r)) {
      const o: Row = {};
      columns.forEach((c, i) => (o[c] = r[i]));
      return o;
    }
    return (r ?? {}) as Row;
  });
}

export function columnsOf(rows: Row[], declared?: string[]): string[] {
  if (declared && declared.length) return declared;
  const seen = new Set<string>();
  rows.slice(0, 50).forEach((r) => Object.keys(r).forEach((k) => seen.add(k)));
  return [...seen];
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(columns: string[], rows: Row[]): string {
  return [columns.map(csvCell).join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n");
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportRows(columns: string[], rows: Row[], format: "csv" | "json", basename: string): void {
  if (format === "csv") saveBlob(new Blob([toCSV(columns, rows)], { type: "text/csv;charset=utf-8" }), `${basename}.csv`);
  else saveBlob(new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }), `${basename}.json`);
}

export function uid(prefix = "id"): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}`;
}

export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

/** Column names of a dataset's main entity. */
export function schemaColumns(schema: { entities: { fields: { name: string; type: string }[] }[] } | null | undefined): { name: string; type: string }[] {
  return schema?.entities?.[0]?.fields?.map((f) => ({ name: f.name, type: f.type })) ?? [];
}
