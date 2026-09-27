"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatBytes, formatNumber } from "@/lib/format";
import { Card, QueryState, StatTile } from "../ui";

function fmt(k: string, v: number): string {
  if (/second/.test(k)) return `${formatNumber(Math.round(v))} s`;
  if (/usd|cost/.test(k)) return `$${v.toFixed(4)}`;
  return formatNumber(v);
}

function label(k: string) {
  return k.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Usage (MT-008/009): LLM tokens & cost, storage, compute and API counters. */
export function UsageTab() {
  const llm = useQuery({ queryKey: ["llm-usage"], queryFn: api.tenant.llmUsage });
  const usage = useQuery({ queryKey: ["usage"], queryFn: () => api.tenant.usage() });
  return (
    <div className="space-y-5">
      <QueryState query={usage}>
        {(u) => (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatTile label="Storage" value={formatBytes(u.storage_bytes)} />
              {Object.entries(u.counters).map(([k, v]) => {
                const total = typeof v === "number" ? v : Object.values(v).reduce((a, b) => a + b, 0);
                return <StatTile key={k} label={label(k)} value={fmt(k, total)} />;
              })}
            </div>
            <Card title="Breakdown" bodyClassName="p-0 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Usage breakdown</caption>
                <thead className="bg-[var(--surface-2)] text-xs">
                  <tr>
                    <th scope="col" className="px-3 py-2">Metric</th>
                    <th scope="col" className="px-3 py-2">By</th>
                    <th scope="col" className="px-3 py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(u.counters).flatMap(([k, v]) =>
                    (typeof v === "number" ? [["—", v] as [string, number]] : Object.entries(v)).map(([by, n]) => (
                      <tr key={`${k}-${by}`} className="border-t border-[var(--border)]">
                        <td className="px-3 py-1.5">{label(k)}</td>
                        <td className="px-3 py-1.5 font-mono text-xs">{by}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmt(k, n)}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </Card>
          </div>
        )}
      </QueryState>
      <Card title="LLM usage" bodyClassName="p-0 overflow-x-auto">
        <QueryState query={llm}>
          {(l) => (
            <>
              <div className="grid grid-cols-2 gap-3 p-4">
                <StatTile label="Total tokens" value={formatNumber(l.total_tokens)} />
                <StatTile label="Total cost" value={`$${l.total_cost_usd.toFixed(2)}`} />
              </div>
              <table className="w-full text-left text-sm">
                <caption className="sr-only">LLM usage by model</caption>
                <thead className="bg-[var(--surface-2)] text-xs">
                  <tr>
                    <th scope="col" className="px-3 py-2">Model</th>
                    <th scope="col" className="px-3 py-2 text-right">Calls</th>
                    <th scope="col" className="px-3 py-2 text-right">Input tokens</th>
                    <th scope="col" className="px-3 py-2 text-right">Output tokens</th>
                    <th scope="col" className="px-3 py-2 text-right">Cost (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(l.by_model).map(([m, v]) => (
                    <tr key={m} className="border-t border-[var(--border)]">
                      <td className="px-3 py-2 font-mono text-xs">{m}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(v.calls ?? (v as Record<string, unknown>).requests)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(v.input_tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(v.output_tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{v.cost_usd !== undefined ? `$${v.cost_usd.toFixed(4)}` : "—"}</td>
                    </tr>
                  ))}
                  {!Object.keys(l.by_model).length && (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-center text-[var(--text-2)]">
                        No LLM calls yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}
        </QueryState>
      </Card>
    </div>
  );
}
