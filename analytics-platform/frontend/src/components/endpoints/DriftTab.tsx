"use client";
/** Drift monitoring (API-011): per-feature PSI vs the training reference, prediction PSI, on-demand check job. */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { EChartsOption } from "echarts";
import { api, type DriftReport, type Job } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { axisStyle, baseOption, ink } from "@/lib/chartOptions";
import { DRIFT_ICON, driftLabel, driftTone, psiColor, psiStatus } from "@/lib/drift";
import { formatNumber } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { EChart } from "../charts/EChart";
import { JobProgress } from "../JobProgress";
import { Badge, Button, Card, EmptyState, QueryState, SelectField, StatTile } from "../ui";

function DriftBadge({ status }: { status: string }) {
  return (
    <Badge tone={driftTone(status)}>
      <span aria-hidden="true">{DRIFT_ICON[status] ?? "•"}</span>
      {driftLabel(status)}
    </Badge>
  );
}

function psiBars(report: DriftReport, dark: boolean): EChartsOption {
  const ax = axisStyle(dark);
  const t = ink(dark);
  const th = report.thresholds;
  const feats = [...report.features].sort((a, b) => (b.psi ?? -1) - (a.psi ?? -1)).slice(0, 25).reverse();
  const max = Math.max(th.alert * 1.2, ...feats.map((f) => f.psi ?? 0));
  return {
    ...baseOption(dark),
    grid: { left: 8, right: 48, top: 24, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      confine: true,
      axisPointer: { type: "shadow" },
      formatter: (p: unknown) => {
        const d = (p as { name: string; value: number | null }[])[0];
        return `${d.name}: PSI ${d.value === null ? "—" : formatNumber(d.value, 3)} (${driftLabel(psiStatus(d.value, th))})`;
      },
    },
    xAxis: { type: "value", name: "PSI", max: Number(max.toPrecision(2)), ...ax },
    yAxis: { type: "category", data: feats.map((f) => f.feature), ...ax, splitLine: { show: false } },
    series: [
      {
        type: "bar",
        name: "PSI",
        barMaxWidth: 16,
        data: feats.map((f) => ({ value: f.psi, itemStyle: { color: psiColor(f.psi, th), borderRadius: [0, 4, 4, 0] } })),
        markLine: {
          silent: true,
          symbol: "none",
          label: { color: t.secondary, formatter: "{b}" },
          data: [
            { name: `warn ${th.warn}`, xAxis: th.warn, lineStyle: { color: "#eda100", type: "dashed" } },
            { name: `alert ${th.alert}`, xAxis: th.alert, lineStyle: { color: "#e34948", type: "dashed" } },
          ],
        },
      },
    ],
  };
}

export function DriftTab({ name }: { name: string }) {
  const { can } = useAuth();
  const { dark } = useTheme();
  const [hours, setHours] = useState(24);
  const [job, setJob] = useState<Job | null>(null);
  const q = useQuery({ queryKey: ["drift", name, hours], queryFn: () => api.endpoints.drift(name, hours) });
  const check = useMutation({ mutationFn: () => api.endpoints.driftCheck(name, hours), meta: { errorPrefix: "Drift check not started" }, onSuccess: setJob });
  const jobResult = job?.result as { alerts?: unknown[]; checked?: { endpoint: string; status: string; samples: number }[] } | null | undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <SelectField
          label="Window"
          value={String(hours)}
          onChange={(e) => setHours(Number(e.target.value))}
          options={[
            { value: "24", label: "Last 24 hours" },
            { value: "168", label: "Last 7 days" },
            { value: "720", label: "Last 30 days" },
          ]}
        />
        {can("endpoints.deploy") && (
          <Button variant="primary" onClick={() => check.mutate()} loading={check.isPending}>
            Run drift check
          </Button>
        )}
        <p className="max-w-xl text-xs text-[var(--text-2)]">
          Population Stability Index of recent traffic against the training reference. Only drift tokens (bins / known categories) are stored; PII-tagged features are skipped. A check in alert raises an <code>endpoint.threshold</code> notification.
        </p>
      </div>
      {job && (
        <Card title="Drift check">
          <JobProgress
            jobId={job.id}
            title="Drift check"
            onDone={(j) => {
              setJob(j);
              q.refetch();
            }}
          />
          {job.status === "succeeded" && (
            <p className="mt-2 text-sm" aria-live="polite">
              {jobResult?.alerts?.length ? `⚠ ${jobResult.alerts.length} alert(s) raised.` : "✓ No alerts raised."}
              {jobResult?.checked?.map((c) => ` ${c.endpoint}: ${driftLabel(c.status)} (${c.samples} samples)`).join(";")}
            </p>
          )}
        </Card>
      )}
      <QueryState query={q}>
        {(r) =>
          r.status === "not_applicable" ? (
            <EmptyState title="Drift monitoring is not applicable">Forecasting endpoints are not monitored for input drift.</EmptyState>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
                  <p className="text-xs text-[var(--text-2)]">Overall</p>
                  <p className="mt-2">
                    <DriftBadge status={r.status} />
                  </p>
                </div>
                <StatTile label="Samples" value={formatNumber(r.samples)} sub={`min ${r.min_samples} for a verdict`} />
                <StatTile
                  label="Prediction PSI"
                  value={r.prediction?.psi !== null && r.prediction?.psi !== undefined ? formatNumber(r.prediction.psi, 3) : "—"}
                  sub={r.prediction ? driftLabel(r.prediction.status) : "no prediction profile"}
                  tone={r.prediction?.status === "alert" ? "critical" : undefined}
                />
                <StatTile label="Thresholds" value={`${r.thresholds.warn} / ${r.thresholds.alert}`} sub="warn / alert (PSI)" />
              </div>
              {r.status === "no_data" || !r.features.length ? (
                <EmptyState title={r.status === "no_data" ? "No traffic in this window" : "No feature statistics"}>Drift is computed from sampled predictions (up to 500 per day).</EmptyState>
              ) : (
                <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
                  <Card title="Feature drift (PSI)">
                    <EChart height={Math.min(640, 60 + Math.min(25, r.features.length) * 24)} ariaLabel="Bar chart of the population stability index per feature, with warn and alert thresholds" option={psiBars(r, dark)} />
                  </Card>
                  <Card title="Per feature" bodyClassName="p-0 overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">Drift status per feature</caption>
                      <thead className="bg-[var(--surface-2)] text-xs">
                        <tr>
                          <th scope="col" className="px-3 py-2">Feature</th>
                          <th scope="col" className="px-3 py-2">PSI</th>
                          <th scope="col" className="px-3 py-2">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...r.features]
                          .sort((a, b) => (b.psi ?? -1) - (a.psi ?? -1))
                          .map((f) => (
                            <tr key={f.feature} className="border-t border-[var(--border)]">
                              <td className="px-3 py-1.5 font-mono text-xs">
                                {f.feature} {f.type && <span className="text-[var(--text-2)]">({f.type})</span>}
                              </td>
                              <td className="px-3 py-1.5 tabular-nums">{f.psi === null ? "—" : formatNumber(f.psi, 3)}</td>
                              <td className="px-3 py-1.5">
                                <DriftBadge status={f.status} />
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </Card>
                </div>
              )}
            </>
          )
        }
      </QueryState>
    </div>
  );
}
