"use client";
/** TRN-008 anomaly runs: score distribution with the threshold, flagged-vs-normal feature shifts, top anomalies. */
import type { EChartsOption } from "echarts";
import type { Run } from "@/lib/types";
import { axisStyle, baseOption, ink, palette, STATUS } from "@/lib/chartOptions";
import { formatNumber, formatPercent } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { EChart } from "../charts/EChart";
import { Card, KeyValue, StatTile } from "../ui";

export function scoreDistributionOption(d: NonNullable<Run["artifacts"]["score_distribution"]>, threshold: number | undefined, dark: boolean): EChartsOption {
  const ax = axisStyle(dark);
  const t = ink(dark);
  const pal = palette(dark);
  const mids = d.counts.map((_, i) => ((d.edges[i] ?? 0) + (d.edges[i + 1] ?? d.edges[i] ?? 0)) / 2);
  const labelled = !!(d.counts_normal && d.counts_anomaly);
  const bar = (name: string, counts: number[], color: string) => ({
    type: "bar" as const,
    name,
    stack: "score",
    barCategoryGap: "5%",
    itemStyle: { color },
    data: counts.map((c, i) => [mids[i], c]),
  });
  const series = labelled ? [bar("labelled normal", d.counts_normal!, pal[0]), bar("labelled anomaly", d.counts_anomaly!, STATUS.critical)] : [bar("rows", d.counts, pal[0])];
  const withLine = series.map((s, i) =>
    i === 0 && threshold !== undefined
      ? {
          ...s,
          markLine: {
            silent: true,
            symbol: "none",
            label: { formatter: `threshold ${formatNumber(threshold)}`, color: t.primary, position: "insideEndTop" as const },
            lineStyle: { color: STATUS.critical, type: "dashed" as const, width: 2 },
            data: [{ xAxis: threshold }],
          },
        }
      : s,
  );
  const width = d.edges.length > 1 ? (d.edges[d.edges.length - 1] - d.edges[0]) / Math.max(1, d.counts.length) : 1;
  return {
    ...baseOption(dark),
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    legend: { show: labelled, top: 0, textStyle: { color: t.secondary } },
    tooltip: { trigger: "axis", confine: true, valueFormatter: (v) => (typeof v === "number" ? v.toLocaleString() : String(v)) },
    xAxis: { type: "value", name: "anomaly score (higher = more anomalous)", nameLocation: "middle", nameGap: 24, min: d.edges[0] - width / 2, max: d.edges[d.edges.length - 1] + width / 2, ...ax },
    yAxis: { type: "value", name: "rows", ...ax },
    series: withLine,
  };
}

export function AnomalyCharts({ run }: { run: Run }) {
  const { dark } = useTheme();
  const a = run.artifacts;
  const m = run.metrics;
  const num = (k: string) => (typeof m[k] === "number" ? (m[k] as number) : undefined);
  const labelled = num("precision") !== undefined;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Flagged in test set" value={formatPercent(num("anomaly_rate"))} sub={`${formatNumber(num("n_test"))} test rows`} />
        <StatTile label="Threshold" value={formatNumber(num("threshold") ?? a.threshold, 4)} sub={`contamination ${formatPercent(num("contamination"))}`} />
        {labelled ? (
          <>
            <StatTile label="Precision / recall" value={`${formatPercent(num("precision"), 0)} / ${formatPercent(num("recall"), 0)}`} sub={`F1 ${formatNumber(num("f1"))}`} />
            <StatTile label="PR-AUC" value={formatNumber(num("pr_auc"))} sub={`ROC-AUC ${formatNumber(num("roc_auc"))} · label rate ${formatPercent(num("label_rate"))}`} />
          </>
        ) : (
          <>
            <StatTile label="Mean score" value={formatNumber(num("score_mean"), 4)} sub={`p95 ${formatNumber(num("score_p95"), 4)}`} />
            <StatTile label="Model selection" value={String(m.cv_metric ?? "consensus")} sub="no labels: agreement with all detectors" />
          </>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {a.score_distribution && (
          <Card title="Score distribution">
            <p className="mb-2 text-xs text-[var(--text-2)]">Rows to the right of the dashed threshold are flagged as anomalies.{labelled ? " Bars are split by the evaluation label." : ""}</p>
            <EChart option={scoreDistributionOption(a.score_distribution, a.threshold ?? num("threshold"), dark)} height={280} ariaLabel="Anomaly score distribution with threshold" />
          </Card>
        )}
        {a.top_anomalies?.length ? (
          <Card title="Most anomalous test rows">
            <KeyValue items={a.top_anomalies.slice(0, 10).map((t) => [`row ${t.row}`, <span key={t.row} className="tabular-nums">score {formatNumber(t.score, 4)}</span>] as [string, React.ReactNode])} />
          </Card>
        ) : null}
      </div>
      {a.feature_importance?.some((f) => f.direction) && (
        <p className="text-xs text-[var(--text-2)]">
          Feature importance for anomalies is the standardized mean difference between flagged and normal rows:{" "}
          {a.feature_importance
            .slice(0, 5)
            .map((f) => `${f.feature} (${f.direction === "higher" ? "higher" : "lower"} in anomalies)`)
            .join(", ")}
          .
        </p>
      )}
    </div>
  );
}
