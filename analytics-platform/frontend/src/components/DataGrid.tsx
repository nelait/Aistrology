"use client";
import { useMemo, useState } from "react";
import type { ConditionalFormat, Row } from "@/lib/types";
import { cellText, formatNumber } from "@/lib/format";
import { exportRows } from "@/lib/data";
import { Button, cx } from "./ui";

export function matchesCondition(value: unknown, op: ConditionalFormat["op"], target: number | string): boolean {
  const a = typeof value === "number" ? value : Number(value);
  const b = typeof target === "number" ? target : Number(target);
  const numeric = Number.isFinite(a) && Number.isFinite(b) && value !== null && value !== "";
  const l: number | string = numeric ? a : String(value ?? "");
  const r: number | string = numeric ? b : String(target);
  switch (op) {
    case ">":
      return l > r;
    case ">=":
      return l >= r;
    case "<":
      return l < r;
    case "<=":
      return l <= r;
    case "==":
      return l === r;
    case "!=":
      return l !== r;
    default:
      return false;
  }
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export interface DataGridProps {
  columns: string[];
  rows: Row[];
  pageSize?: number;
  sortable?: boolean;
  filterable?: boolean;
  exportName?: string;
  conditionalFormat?: ConditionalFormat[];
  caption?: string;
  maxHeight?: number | string;
  dense?: boolean;
  highlightColumns?: string[];
}

/** Results table: sort, filter, paginate, conditional formatting, CSV/JSON export (WDG-003, WCFG-003, VIZ-005). */
export function DataGrid({
  columns,
  rows,
  pageSize = 25,
  sortable = true,
  filterable = true,
  exportName,
  conditionalFormat,
  caption,
  maxHeight = 480,
  dense,
  highlightColumns,
}: DataGridProps) {
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let out = q ? rows.filter((r) => columns.some((c) => cellText(r[c]).toLowerCase().includes(q))) : rows;
    if (sort) out = [...out].sort((a, b) => compare(a[sort.col], b[sort.col]) * sort.dir);
    return out;
  }, [rows, columns, filter, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * pageSize, current * pageSize + pageSize);

  const cellStyle = (col: string, v: unknown): React.CSSProperties | undefined => {
    const rule = conditionalFormat?.find((f) => f.column === col && matchesCondition(v, f.op, f.value));
    return rule ? { backgroundColor: `${rule.color}33`, boxShadow: `inset 3px 0 0 ${rule.color}` } : undefined;
  };

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {(filterable || exportName) && (
        <div className="flex flex-wrap items-center gap-2">
          {filterable && (
            <>
              <label className="sr-only" htmlFor={`grid-filter-${caption ?? "rows"}`}>
                Filter rows
              </label>
              <input
                id={`grid-filter-${caption ?? "rows"}`}
                type="search"
                placeholder="Filter rows…"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setPage(0);
                }}
                className="w-48 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
              />
            </>
          )}
          <span className="text-xs text-[var(--text-2)]" aria-live="polite">
            {filtered.length.toLocaleString()} row{filtered.length === 1 ? "" : "s"}
          </span>
          {exportName && (
            <span className="ml-auto flex gap-1">
              <Button size="sm" onClick={() => exportRows(columns, filtered, "csv", exportName)}>
                Export CSV
              </Button>
              <Button size="sm" onClick={() => exportRows(columns, filtered, "json", exportName)}>
                Export JSON
              </Button>
            </span>
          )}
        </div>
      )}
      <div className="min-h-0 overflow-auto rounded-md border border-[var(--border)]" style={{ maxHeight }} tabIndex={0} aria-label={caption ?? "Data table"} role="region">
        <table className="w-full border-collapse text-left text-xs">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className="sticky top-0 z-10 bg-[var(--surface-2)]">
            <tr>
              {columns.map((c) => {
                const dir = sort?.col === c ? sort.dir : 0;
                return (
                  <th key={c} scope="col" aria-sort={dir === 1 ? "ascending" : dir === -1 ? "descending" : "none"} className={cx("whitespace-nowrap border-b border-[var(--border)] font-semibold", dense ? "px-2 py-1" : "px-3 py-2", highlightColumns?.includes(c) && "text-brand-700 dark:text-brand-300")}>
                    {sortable ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1"
                        onClick={() => setSort(dir === 0 ? { col: c, dir: 1 } : dir === 1 ? { col: c, dir: -1 } : null)}
                      >
                        {c}
                        <span aria-hidden="true" className="text-[var(--text-2)]">
                          {dir === 1 ? "▲" : dir === -1 ? "▼" : "↕"}
                        </span>
                      </button>
                    ) : (
                      c
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr key={i} className="odd:bg-[var(--surface)] even:bg-[var(--surface-2)]/40">
                {columns.map((c) => {
                  const v = r[c];
                  return (
                    <td key={c} style={cellStyle(c, v)} className={cx("max-w-xs truncate border-b border-[var(--border)]", dense ? "px-2 py-0.5" : "px-3 py-1.5", typeof v === "number" && "text-right tabular-nums", highlightColumns?.includes(c) && "bg-brand-50/60 dark:bg-brand-900/20")} title={cellText(v)}>
                      {v === null || v === undefined ? <span className="text-[var(--text-2)] italic">null</span> : typeof v === "number" ? formatNumber(v, 6) : cellText(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
            {!visible.length && (
              <tr>
                <td colSpan={Math.max(1, columns.length)} className="px-3 py-6 text-center text-[var(--text-2)]">
                  No rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <nav className="flex items-center justify-end gap-2 text-xs" aria-label="Pagination">
          <Button size="sm" onClick={() => setPage(0)} disabled={current === 0} aria-label="First page">
            «
          </Button>
          <Button size="sm" onClick={() => setPage(current - 1)} disabled={current === 0} aria-label="Previous page">
            ‹
          </Button>
          <span aria-live="polite">
            Page {current + 1} of {pages}
          </span>
          <Button size="sm" onClick={() => setPage(current + 1)} disabled={current >= pages - 1} aria-label="Next page">
            ›
          </Button>
          <Button size="sm" onClick={() => setPage(pages - 1)} disabled={current >= pages - 1} aria-label="Last page">
            »
          </Button>
        </nav>
      )}
    </div>
  );
}
