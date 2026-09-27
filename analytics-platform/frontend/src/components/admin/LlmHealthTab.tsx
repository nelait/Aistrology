"use client";
/** LLM provider health (LPA-006): rolling latency / error stats per provider and circuit-breaker settings. */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BreakerConfig } from "@/lib/api";
import { formatDuration, formatNumber, formatPercent } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { Badge, Button, Card, Checkbox, EmptyState, QueryState, TextField } from "../ui";

const STATUS_TONE: Record<string, "good" | "warning" | "critical"> = { healthy: "good", degraded: "warning", unhealthy: "critical" };
const BREAKER_TONE: Record<string, "good" | "warning" | "critical"> = { closed: "good", half_open: "warning", open: "critical" };

export function LlmHealthTab() {
  const q = useQuery({ queryKey: ["llm-health"], queryFn: api.llmAdmin.health, refetchInterval: 15_000 });
  return (
    <div className="space-y-4">
      <QueryState query={q}>
        {(h) => (
          <>
            <Card title={`Provider health (last ${formatDuration(h.window_seconds)})`} bodyClassName="p-0 overflow-x-auto">
              {h.providers.length ? (
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">LLM provider statistics</caption>
                  <thead className="bg-[var(--surface-2)] text-xs">
                    <tr>
                      <th scope="col" className="px-3 py-2">Provider</th>
                      <th scope="col" className="px-3 py-2">Status</th>
                      <th scope="col" className="px-3 py-2">Requests</th>
                      <th scope="col" className="px-3 py-2">Error rate</th>
                      <th scope="col" className="px-3 py-2">Refusal rate</th>
                      <th scope="col" className="px-3 py-2">p50</th>
                      <th scope="col" className="px-3 py-2">p95</th>
                      <th scope="col" className="px-3 py-2">max</th>
                      <th scope="col" className="px-3 py-2">Breaker</th>
                      <th scope="col" className="px-3 py-2">Last call</th>
                    </tr>
                  </thead>
                  <tbody>
                    {h.providers.map((p) => (
                      <tr key={p.provider} className="border-t border-[var(--border)]">
                        <td className="px-3 py-2 font-medium">{p.provider}</td>
                        <td className="px-3 py-2">
                          <Badge tone={STATUS_TONE[p.status] ?? "neutral"}>{p.status}</Badge>
                        </td>
                        <td className="px-3 py-2 tabular-nums">{formatNumber(p.requests)}</td>
                        <td className="px-3 py-2 tabular-nums">
                          {formatPercent(p.error_rate)} <span className="text-xs text-[var(--text-2)]">({p.errors})</span>
                        </td>
                        <td className="px-3 py-2 tabular-nums">{formatPercent(p.refusal_rate)}</td>
                        <td className="px-3 py-2 tabular-nums">{p.latency_ms.p50 !== null ? `${formatNumber(p.latency_ms.p50)} ms` : "—"}</td>
                        <td className="px-3 py-2 tabular-nums">{p.latency_ms.p95 !== null ? `${formatNumber(p.latency_ms.p95)} ms` : "—"}</td>
                        <td className="px-3 py-2 tabular-nums">{p.latency_ms.max !== null ? `${formatNumber(p.latency_ms.max)} ms` : "—"}</td>
                        <td className="px-3 py-2">{p.breaker ? <Badge tone={BREAKER_TONE[p.breaker] ?? "neutral"}>{p.breaker.replace("_", "-")}</Badge> : "—"}</td>
                        <td className="px-3 py-2 text-xs">{p.last_outcome ? `${p.last_outcome}${p.seconds_since_last !== null ? `, ${formatDuration(p.seconds_since_last)} ago` : ""}` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="p-4">
                  <EmptyState title="No LLM calls in this window">Statistics appear after the first schema, suggestion or explanation request.</EmptyState>
                </div>
              )}
            </Card>
            <BreakerForm initial={h.breaker} />
          </>
        )}
      </QueryState>
    </div>
  );
}

function BreakerForm({ initial }: { initial: BreakerConfig }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [cfg, setCfg] = useState(initial);
  useEffect(() => setCfg(initial), [initial]);
  const save = useMutation({
    mutationFn: () => api.llmAdmin.putBreaker(cfg),
    meta: { errorPrefix: "Breaker settings not saved" },
    onSuccess: () => {
      toast.success("Circuit breaker settings saved");
      qc.invalidateQueries({ queryKey: ["llm-health"] });
    },
  });
  const thresholdError = cfg.failure_threshold < 1 || cfg.failure_threshold > 100 ? "1–100" : null;
  const openError = cfg.open_seconds < 1 || cfg.open_seconds > 3600 ? "1–3600 seconds" : null;
  return (
    <Card title="Circuit breaker">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <p className="text-sm text-[var(--text-2)]">
          When on, a provider with N consecutive errors is skipped for the open period, then gets one half-open probe. Refusals never trip it, and if every provider is open the chain is tried anyway.
        </p>
        <Checkbox label="Enable the circuit breaker" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
        <div className="grid max-w-lg gap-3 sm:grid-cols-2">
          <TextField label="Failure threshold" type="number" min={1} max={100} disabled={!cfg.enabled} value={cfg.failure_threshold} onChange={(e) => setCfg({ ...cfg, failure_threshold: Number(e.target.value) })} error={thresholdError} />
          <TextField label="Open for (seconds)" type="number" min={1} max={3600} disabled={!cfg.enabled} value={cfg.open_seconds} onChange={(e) => setCfg({ ...cfg, open_seconds: Number(e.target.value) })} error={openError} />
        </div>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!!thresholdError || !!openError}>
          Save
        </Button>
      </form>
    </Card>
  );
}
