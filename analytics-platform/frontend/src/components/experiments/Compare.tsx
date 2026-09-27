"use client";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { barH } from "@/lib/chartOptions";
import { formatNumber } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { EChart } from "../charts/EChart";
import { Card, QueryState, SelectField } from "../ui";

const LOWER_IS_BETTER = /(mae|mse|rmse|mape|loss|error|log_loss|brier|davies)/i;

/** Side-by-side run comparison (EXP-007). One metric per chart: no dual axes. */
export function Compare({ runIds }: { runIds: string[] }) {
  const { dark } = useTheme();
  const q = useQuery({ queryKey: ["compare", runIds], queryFn: () => api.training.compare(runIds), enabled: runIds.length >= 2 });
  const [metric, setMetric] = useState("");
  const m = useMemo(() => metric || q.data?.metrics[0] || "", [metric, q.data]);
  if (runIds.length < 2) return <p className="text-sm text-[var(--text-2)]">Select two or more runs in the leaderboard to compare them.</p>;
  return (
    <QueryState query={q}>
      {(d) => (
        <div className="space-y-4">
          <Card title="Metrics side by side" bodyClassName="p-0 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-[var(--surface-2)] text-xs">
                <tr>
                  <th scope="col" className="px-3 py-2">Metric</th>
                  {d.runs.map((r) => (
                    <th key={r.id} scope="col" className="px-3 py-2">
                      {r.algorithm}
                      <span className="block font-mono text-[10px] font-normal text-[var(--text-2)]">{r.id.slice(0, 8)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.metrics.map((name) => {
                  const vals = d.runs.map((r) => r.metrics[name]).filter((v): v is number => typeof v === "number");
                  const best = vals.length ? (LOWER_IS_BETTER.test(name) ? Math.min(...vals) : Math.max(...vals)) : null;
                  return (
                    <tr key={name} className="border-t border-[var(--border)]">
                      <th scope="row" className="px-3 py-1.5 font-mono text-xs font-normal">{name}</th>
                      {d.runs.map((r) => (
                        <td key={r.id} className={`px-3 py-1.5 tabular-nums ${r.metrics[name] === best ? "font-semibold text-green-800 dark:text-green-300" : ""}`}>
                          {formatNumber(r.metrics[name], 4)}
                          {r.metrics[name] === best && <span className="sr-only"> (best)</span>}
                        </td>
                      ))}
                    </tr>
                  );
                })}
                <tr className="border-t border-[var(--border)]">
                  <th scope="row" className="px-3 py-1.5 text-xs font-normal">Parameters</th>
                  {d.runs.map((r) => (
                    <td key={r.id} className="max-w-xs px-3 py-1.5 font-mono text-[10px] break-words">
                      {JSON.stringify(r.params)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </Card>
          <Card title="Compare a metric">
            <SelectField label="Metric" className="mb-2 max-w-xs" value={m} onChange={(e) => setMetric(e.target.value)} options={d.metrics.map((x) => ({ value: x, label: x }))} />
            <EChart
              ariaLabel={`${m} by run`}
              height={60 + d.runs.length * 32}
              option={barH(d.runs.map((r) => ({ name: `${r.algorithm} (${r.id.slice(0, 6)})`, value: r.metrics[m] ?? 0 })), { dark, name: m })}
            />
          </Card>
        </div>
      )}
    </QueryState>
  );
}
