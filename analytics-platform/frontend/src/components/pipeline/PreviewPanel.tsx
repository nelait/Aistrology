"use client";
import type { PipelinePreview } from "@/lib/types";
import { formatNumber } from "@/lib/format";
import { DataGrid } from "../DataGrid";
import { Badge, Card } from "../ui";

function delta(a: number | null | undefined, b: number | null | undefined) {
  if (a === null || a === undefined || b === null || b === undefined) return <span>{formatNumber(a)} → {formatNumber(b)}</span>;
  const d = b - a;
  return (
    <span className="tabular-nums">
      {formatNumber(a)} → {formatNumber(b)}{" "}
      {d !== 0 && <span className={d < 0 ? "text-red-700 dark:text-red-400" : "text-green-700 dark:text-green-400"}>({d > 0 ? "+" : ""}{formatNumber(d)})</span>}
    </span>
  );
}

/** Before/after statistics per step, column deltas and sample rows (PIP-003, PIP-005). */
export function PreviewPanel({ preview, title }: { preview: PipelinePreview; title: string }) {
  const added = preview.step_stats.flatMap((s) => s.added_columns);
  return (
    <Card title={<span className="flex items-center gap-2">{title} <Badge>sample of {preview.sample_rows.toLocaleString()} rows</Badge></span>}>
      <div className="space-y-4">
        {preview.step_stats.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="mb-1 text-left text-sm font-semibold">Before / after per step</caption>
              <thead className="bg-[var(--surface-2)]">
                <tr>
                  <th scope="col" className="px-2 py-1">#</th>
                  <th scope="col" className="px-2 py-1">Step</th>
                  <th scope="col" className="px-2 py-1">Rows</th>
                  <th scope="col" className="px-2 py-1">Columns</th>
                  <th scope="col" className="px-2 py-1">Null cells</th>
                  <th scope="col" className="px-2 py-1">Changed cells</th>
                  <th scope="col" className="px-2 py-1">Added / removed</th>
                </tr>
              </thead>
              <tbody>
                {preview.step_stats.map((s, i) => (
                  <tr key={i} className="border-t border-[var(--border)]">
                    <td className="px-2 py-1">{i + 1}</td>
                    <td className="px-2 py-1 font-mono">{s.op}</td>
                    <td className="px-2 py-1">{delta(s.rows_before, s.rows_after)}</td>
                    <td className="px-2 py-1">{delta(s.columns_before, s.columns_after)}</td>
                    <td className="px-2 py-1">{delta(s.nulls_before, s.nulls_after)}</td>
                    <td className="px-2 py-1">{formatNumber(s.changed_cells)}</td>
                    <td className="px-2 py-1">
                      {s.added_columns.map((c) => (
                        <Badge key={c} tone="good" className="mr-1">+{c}</Badge>
                      ))}
                      {s.removed_columns.map((c) => (
                        <Badge key={c} tone="critical" className="mr-1">−{c}</Badge>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {preview.column_deltas.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="mb-1 text-left text-sm font-semibold">Column changes</caption>
              <thead className="bg-[var(--surface-2)]">
                <tr>
                  <th scope="col" className="px-2 py-1">Column</th>
                  <th scope="col" className="px-2 py-1">Nulls</th>
                  <th scope="col" className="px-2 py-1">Distinct</th>
                  <th scope="col" className="px-2 py-1">Mean</th>
                </tr>
              </thead>
              <tbody>
                {preview.column_deltas.map((c) => (
                  <tr key={c.column} className="border-t border-[var(--border)]">
                    <td className="px-2 py-1 font-mono">{c.column}</td>
                    <td className="px-2 py-1">{delta(c.nulls_before, c.nulls_after)}</td>
                    <td className="px-2 py-1">{delta(c.distinct_before, c.distinct_after)}</td>
                    <td className="px-2 py-1">{delta(c.mean_before, c.mean_after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <DataGrid columns={preview.columns} rows={preview.rows} pageSize={10} dense caption="Sample rows after the pipeline" highlightColumns={added} />
      </div>
    </Card>
  );
}
