"use client";
/** Clustering (EXP-005) and forecasting (EXP-004) run charts, plus ALE plots (XAI-001a). */
import { useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import type { Run } from "@/lib/types";
import { axisStyle, baseOption, ink, lineXY, palette } from "@/lib/chartOptions";
import { formatNumber, formatPercent } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { EChart } from "../charts/EChart";
import { Card, SelectField } from "../ui";

function clusterName(c: number): string {
  return c === -1 ? "noise" : `cluster ${c}`;
}

/** k from a k-search entry's params (n_clusters, k, n_components …); null when not a k sweep. */
export function kOf(params: Record<string, unknown>): number | null {
  for (const key of ["n_clusters", "k", "n_components"]) {
    const v = params[key];
    if (typeof v === "number") return v;
  }
  return null;
}

export function ClusterCharts({ run }: { run: Run }) {
  const { dark } = useTheme();
  const a = run.artifacts;
  const pal = palette(dark);
  const t = ink(dark);
  const ax = axisStyle(dark);
  const color = (c: number) => (c === -1 ? t.muted : pal[((c % pal.length) + pal.length) % pal.length]);

  const sizes: EChartsOption | null = a.cluster_sizes?.length
    ? {
        ...baseOption(dark),
        grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
        tooltip: { trigger: "axis", confine: true, axisPointer: { type: "shadow" } },
        xAxis: { type: "category", data: a.cluster_sizes.map((s) => clusterName(s.cluster)), ...ax, splitLine: { show: false } },
        yAxis: { type: "value", name: "rows", ...ax },
        series: [
          {
            type: "bar",
            name: "rows",
            data: a.cluster_sizes.map((s) => ({ value: s.size, itemStyle: { color: color(s.cluster), borderRadius: [4, 4, 0, 0] } })),
            label: { show: a.cluster_sizes.length <= 12, position: "top", color: t.secondary, formatter: (p: unknown) => formatPercent(a.cluster_sizes![(p as { dataIndex: number }).dataIndex].share, 0) },
          },
        ],
      }
    : null;

  const scatter: EChartsOption | null = (() => {
    const p = a.projection;
    if (!p?.x?.length) return null;
    const clusters = Array.from(new Set(p.cluster)).sort((x, y) => x - y);
    const ev = p.explained_variance ?? [];
    return {
      ...baseOption(dark),
      grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
      legend: { show: clusters.length > 1, top: 0, textStyle: { color: t.secondary } },
      tooltip: { trigger: "item", confine: true },
      xAxis: { type: "value", name: `PC1${ev[0] !== undefined ? ` (${formatPercent(ev[0], 0)})` : ""}`, nameLocation: "middle", nameGap: 24, scale: true, ...ax },
      yAxis: { type: "value", name: `PC2${ev[1] !== undefined ? ` (${formatPercent(ev[1], 0)})` : ""}`, scale: true, ...ax },
      series: clusters.map((c) => ({
        type: "scatter" as const,
        name: clusterName(c),
        symbolSize: 6,
        itemStyle: { color: color(c), opacity: 0.75 },
        data: p.x.map((x, i) => (p.cluster[i] === c ? [x, p.y[i]] : null)).filter((d): d is [number, number] => d !== null),
      })),
    };
  })();

  const kSearch = useMemo(() => {
    const entries = (a.k_search ?? []).map((e) => ({ k: kOf(e.params ?? {}), score: typeof e.silhouette === "number" ? e.silhouette : typeof e.cv_score === "number" ? e.cv_score : null }));
    const pts = entries.filter((e): e is { k: number; score: number } => e.k !== null && e.score !== null).sort((x, y) => x.k - y.k);
    // keep the best score per k (several algorithms may try the same k)
    const best = new Map<number, number>();
    for (const p of pts) best.set(p.k, Math.max(best.get(p.k) ?? -Infinity, p.score));
    const ks = Array.from(best.keys()).sort((x, y) => x - y);
    return ks.length ? lineXY([{ name: "silhouette", x: ks, y: ks.map((k) => best.get(k)!) }], { dark, xName: "number of clusters (k)", yName: "silhouette" }) : null;
  }, [a.k_search, dark]);

  const profiles = a.cluster_profiles ?? [];
  const features = Array.from(new Set(profiles.flatMap((p) => Object.keys(p.means ?? {})))).slice(0, 12);
  const catFeatures = Array.from(new Set(profiles.flatMap((p) => Object.keys(p.top_categories ?? {})))).slice(0, 6);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {sizes && (
          <Card title="Cluster sizes">
            <EChart option={sizes} height={260} ariaLabel="Bar chart of cluster sizes" />
          </Card>
        )}
        {scatter && (
          <Card title="2-D PCA projection">
            <p className="mb-2 text-xs text-[var(--text-2)]">A sample of rows projected on the first two principal components, colored by cluster.</p>
            <EChart option={scatter} height={300} ariaLabel="Scatter plot of rows on the first two principal components colored by cluster" />
          </Card>
        )}
        {kSearch && (
          <Card title="k search">
            <p className="mb-2 text-xs text-[var(--text-2)]">Best silhouette score per number of clusters tried by AutoML (higher is better).</p>
            <EChart option={kSearch} height={240} ariaLabel="Line chart of silhouette score by number of clusters" />
          </Card>
        )}
      </div>
      {profiles.length > 0 && (
        <Card title="Cluster profiles" bodyClassName="p-0 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Mean of each feature per cluster, with the most common category</caption>
            <thead className="bg-[var(--surface-2)] text-xs">
              <tr>
                <th scope="col" className="px-3 py-2">Cluster</th>
                <th scope="col" className="px-3 py-2">Size</th>
                {features.map((f) => (
                  <th key={f} scope="col" className="px-3 py-2 font-mono">
                    {f}
                  </th>
                ))}
                {catFeatures.map((f) => (
                  <th key={f} scope="col" className="px-3 py-2 font-mono">
                    {f} (top)
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.cluster} className="border-t border-[var(--border)]">
                  <th scope="row" className="px-3 py-1.5 text-left font-medium">
                    <span aria-hidden="true" className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full" style={{ background: color(p.cluster) }} />
                    {clusterName(p.cluster)}
                  </th>
                  <td className="px-3 py-1.5 tabular-nums">{formatNumber(p.size)}</td>
                  {features.map((f) => {
                    const v = p.means?.[f];
                    const overall = a.overall_means?.[f];
                    const diff = typeof v === "number" && typeof overall === "number" && overall !== 0 ? (v - overall) / Math.abs(overall) : null;
                    return (
                      <td key={f} className="px-3 py-1.5 tabular-nums">
                        {formatNumber(v)}
                        {diff !== null && Math.abs(diff) >= 0.1 && (
                          <span className={diff > 0 ? "ml-1 text-xs text-brand-700 dark:text-brand-300" : "ml-1 text-xs text-red-700 dark:text-red-400"}>
                            {diff > 0 ? "▲" : "▼"}
                            {formatPercent(Math.abs(diff), 0)}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  {catFeatures.map((f) => (
                    <td key={f} className="px-3 py-1.5">
                      {p.top_categories?.[f] === undefined ? "—" : String(p.top_categories[f])}
                    </td>
                  ))}
                </tr>
              ))}
              {a.overall_means && (
                <tr className="border-t-2 border-[var(--border)] text-[var(--text-2)]">
                  <th scope="row" className="px-3 py-1.5 text-left font-medium">
                    overall
                  </th>
                  <td className="px-3 py-1.5" />
                  {features.map((f) => (
                    <td key={f} className="px-3 py-1.5 tabular-nums">
                      {formatNumber(a.overall_means?.[f])}
                    </td>
                  ))}
                  {catFeatures.map((f) => (
                    <td key={f} />
                  ))}
                </tr>
              )}
            </tbody>
          </table>
          <p className="px-3 py-2 text-xs text-[var(--text-2)]">▲/▼: at least 10% above / below the overall mean.</p>
        </Card>
      )}
    </div>
  );
}

/** Line chart of a history + forecast with a shaded prediction interval (shared by runs and endpoint "try it"). */
export function forecastOption(input: {
  dark: boolean;
  history?: { timestamps: string[]; values: (number | null)[] };
  forecast: { timestamps: string[]; forecast: number[]; lower?: number[]; upper?: number[] };
  backtest?: { origin: string; timestamps: string[]; forecast: number[] }[];
  intervalLabel?: string;
}): EChartsOption {
  const { dark } = input;
  const pal = palette(dark);
  const t = ink(dark);
  const ax = axisStyle(dark);
  const f = input.forecast;
  const band = f.lower && f.upper && f.lower.length === f.timestamps.length && f.upper.length === f.timestamps.length;
  const series: EChartsOption["series"] = [];
  if (input.history)
    (series as unknown[]).push({
      type: "line",
      name: "history",
      showSymbol: false,
      lineStyle: { width: 1.5, color: t.secondary },
      itemStyle: { color: t.secondary },
      data: input.history.timestamps.map((ts, i) => [ts, input.history!.values[i]]),
    });
  (input.backtest ?? []).forEach((b, i) =>
    (series as unknown[]).push({
      type: "line",
      name: "backtest",
      showSymbol: false,
      lineStyle: { width: 1.5, type: "dashed", color: pal[1] },
      itemStyle: { color: pal[1] },
      data: b.timestamps.map((ts, j) => [ts, b.forecast[j]]),
      z: 3 + i,
    }),
  );
  if (band) {
    (series as unknown[]).push(
      { type: "line", name: "lower", stack: "interval", showSymbol: false, lineStyle: { opacity: 0 }, data: f.timestamps.map((ts, i) => [ts, f.lower![i]]), tooltip: { show: false } },
      {
        type: "line",
        name: input.intervalLabel ?? "interval",
        stack: "interval",
        showSymbol: false,
        lineStyle: { opacity: 0 },
        areaStyle: { color: pal[0], opacity: 0.18 },
        itemStyle: { color: pal[0] },
        data: f.timestamps.map((ts, i) => [ts, f.upper![i] - f.lower![i]]),
        tooltip: { show: false },
      },
    );
  }
  (series as unknown[]).push({ type: "line", name: "forecast", showSymbol: f.timestamps.length < 40, lineStyle: { width: 2.5, color: pal[0] }, itemStyle: { color: pal[0] }, data: f.timestamps.map((ts, i) => [ts, f.forecast[i]]) });
  return {
    ...baseOption(dark),
    grid: { left: 8, right: 16, top: 36, bottom: 40, containLabel: true },
    legend: { top: 0, data: ["history", "backtest", input.intervalLabel ?? "interval", "forecast"].filter((n) => (series as { name: string }[]).some((s) => s.name === n)), textStyle: { color: t.secondary } },
    tooltip: { trigger: "axis", confine: true, valueFormatter: (v) => (typeof v === "number" ? String(Number(v.toPrecision(4))) : String(v)) },
    xAxis: { type: "time", ...ax, splitLine: { show: false } },
    yAxis: { type: "value", scale: true, ...ax },
    dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 4 }],
    series,
  };
}

export function ForecastCharts({ run }: { run: Run }) {
  const { dark } = useTheme();
  const a = run.artifacts;
  const [showBacktest, setShowBacktest] = useState(true);
  if (!a.forecast) return <p className="text-sm text-[var(--text-2)]">No forecast artifacts for this run.</p>;
  const level = a.forecast.interval_level;
  const option = forecastOption({
    dark,
    history: a.history,
    forecast: a.forecast,
    backtest: showBacktest ? a.backtest : undefined,
    intervalLabel: level ? `${Math.round(level * 100)}% interval` : "interval",
  });
  return (
    <Card title="Forecast">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-[var(--text-2)]">
        {a.frequency && <span>Frequency: {a.frequency}</span>}
        {a.season_length ? <span>Season length: {a.season_length}</span> : null}
        {a.backtest?.length ? (
          <label className="flex items-center gap-1.5">
            <input type="checkbox" className="accent-brand-600" checked={showBacktest} onChange={(e) => setShowBacktest(e.target.checked)} />
            Show {a.backtest.length} backtest window{a.backtest.length === 1 ? "" : "s"}
          </label>
        ) : null}
      </div>
      <EChart option={option} height={360} ariaLabel="History, rolling-origin backtest forecasts and the future forecast with its prediction interval" />
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer">Forecast values</summary>
        <table className="mt-2 text-left text-xs">
          <caption className="sr-only">Forecast values</caption>
          <thead>
            <tr>
              <th scope="col" className="pr-4">Time</th>
              <th scope="col" className="pr-4">Forecast</th>
              <th scope="col" className="pr-4">Lower</th>
              <th scope="col">Upper</th>
            </tr>
          </thead>
          <tbody>
            {a.forecast.timestamps.map((ts, i) => (
              <tr key={ts}>
                <td className="pr-4">{ts}</td>
                <td className="pr-4 tabular-nums">{formatNumber(a.forecast!.forecast[i])}</td>
                <td className="pr-4 tabular-nums">{formatNumber(a.forecast!.lower?.[i])}</td>
                <td className="tabular-nums">{formatNumber(a.forecast!.upper?.[i])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </Card>
  );
}

export function AleChart({ run }: { run: Run }) {
  const { dark } = useTheme();
  const features = Object.keys(run.artifacts.ale ?? {});
  const [feature, setFeature] = useState(features[0] ?? "");
  if (!features.length) return null;
  const f = run.artifacts.ale![feature] ?? run.artifacts.ale![features[0]];
  return (
    <Card title="Accumulated local effects (ALE)">
      <p className="mb-2 text-xs text-[var(--text-2)]">Effect of the feature on the prediction relative to the average, robust to correlated features (unlike PDP).</p>
      <SelectField label="Feature" value={feature} onChange={(e) => setFeature(e.target.value)} options={features.map((x) => ({ value: x, label: x }))} className="mb-2 max-w-xs" />
      <EChart ariaLabel={`Accumulated local effects of ${feature}`} height={240} option={lineXY([{ name: "ALE", x: f.grid, y: f.ale, area: true }], { dark, xName: feature, yName: "effect on prediction" })} />
    </Card>
  );
}
