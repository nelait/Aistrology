"use client";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ColumnProfile, type DatasetRecord } from "@/lib/api";
import { axisStyle, barH, baseOption, gaugeOption, heatmapOption, histogramOption, STATUS } from "@/lib/chartOptions";
import { formatNumber, formatPercent } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { EChart } from "../charts/EChart";
import { Badge, Card, KeyValue, QueryState, SelectField, StatTile } from "../ui";

function qualityTone(score: number): "good" | "warning" | "critical" {
  return score >= 80 ? "good" : score >= 60 ? "warning" : "critical";
}

function ColumnCard({ col, dark }: { col: ColumnProfile; dark: boolean }) {
  const hasHist = !!col.histogram && col.histogram.counts.length > 0;
  const hasTop = !!col.top_values && col.top_values.length > 0;
  const [view, setView] = useState<"hist" | "top">(hasHist ? "hist" : "top");
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{col.name}</span>
          {col.type && <Badge>{col.type}</Badge>}
          {col.role && <Badge tone="info">{col.role}</Badge>}
          {col.type_mismatch && <Badge tone="warning">⚠ type mismatch</Badge>}
        </span>
      }
      actions={
        hasHist && hasTop ? (
          <span className="flex gap-1 text-xs" role="group" aria-label={`${col.name} chart`}>
            <button type="button" aria-pressed={view === "hist"} className={view === "hist" ? "font-semibold underline" : ""} onClick={() => setView("hist")}>
              Histogram
            </button>
            <span aria-hidden="true">·</span>
            <button type="button" aria-pressed={view === "top"} className={view === "top" ? "font-semibold underline" : ""} onClick={() => setView("top")}>
              Top values
            </button>
          </span>
        ) : undefined
      }
    >
      <div className="grid gap-4 md:grid-cols-[minmax(0,14rem)_1fr]">
        <KeyValue
          items={[
            ["Count", formatNumber(col.count)],
            ["Nulls", `${formatNumber(col.null_count)} (${formatPercent(col.null_fraction)})`],
            ["Distinct", formatNumber(col.distinct_count)],
            ...(col.min !== undefined && col.min !== null ? ([["Min", formatNumber(col.min)]] as [string, string][]) : []),
            ...(col.max !== undefined && col.max !== null ? ([["Max", formatNumber(col.max)]] as [string, string][]) : []),
            ...(col.mean !== null && col.mean !== undefined ? ([["Mean", formatNumber(col.mean)]] as [string, string][]) : []),
            ...(col.median !== null && col.median !== undefined ? ([["Median", formatNumber(col.median)]] as [string, string][]) : []),
            ...(col.std !== null && col.std !== undefined ? ([["Std dev", formatNumber(col.std)]] as [string, string][]) : []),
            ...Object.entries(col.percentiles ?? {}).map(([k, v]) => [k.toUpperCase(), formatNumber(v)] as [string, string]),
            ...(col.min_length !== null && col.min_length !== undefined ? ([["Length", `${col.min_length}–${col.max_length} (avg ${formatNumber(col.mean_length)})`]] as [string, string][]) : []),
            ...(col.outliers
              ? ([
                  ["IQR outliers", `${col.outliers.iqr_count} outside [${formatNumber(col.outliers.iqr_bounds[0])}, ${formatNumber(col.outliers.iqr_bounds[1])}]`],
                  ["Z-score outliers", String(col.outliers.zscore_count)],
                ] as [string, string][])
              : []),
          ]}
        />
        <div className="min-w-0">
          {col.type_mismatch && <p className="mb-2 text-xs text-amber-800 dark:text-amber-300">⚠ {col.type_mismatch}</p>}
          {view === "hist" && hasHist && <EChart height={180} ariaLabel={`Histogram of ${col.name}`} option={histogramOption(baseOption(dark), axisStyle(dark), col.histogram!, col.name, dark)} />}
          {view === "top" && hasTop && (
            <EChart
              height={Math.min(260, 40 + col.top_values!.length * 20)}
              ariaLabel={`Top values of ${col.name}`}
              option={barH(
                col.top_values!.map(([name, value]) => ({ name: String(name), value })),
                { dark, name: "count", top: 10 },
              )}
            />
          )}
          {!hasHist && !hasTop && <p className="text-sm text-[var(--text-2)]">No distribution available.</p>}
        </div>
      </div>
    </Card>
  );
}

export function ProfileTab({ dataset }: { dataset: DatasetRecord }) {
  const { dark } = useTheme();
  const q = useQuery({ queryKey: ["profile", dataset.id, dataset.version], queryFn: () => api.datasets.profile(dataset.id, dataset.version) });
  const [filter, setFilter] = useState("all");

  return (
    <QueryState query={q} loadingLabel="Profiling dataset… (large datasets can take up to a minute)">
      {(p) => <ProfileBody p={p} dark={dark} filter={filter} setFilter={setFilter} />}
    </QueryState>
  );
}

function ProfileBody({ p, dark, filter, setFilter }: { p: import("@/lib/types").DatasetProfile; dark: boolean; filter: string; setFilter: (v: string) => void }) {
  const corr = useMemo(() => {
    const names = Object.keys(p.correlations ?? {});
    if (names.length < 2) return null;
    const data: [number, number, number | null][] = [];
    names.forEach((a, i) => names.forEach((b, j) => data.push([i, j, p.correlations[a]?.[b] ?? null])));
    return heatmapOption(baseOption(dark), axisStyle(dark), names, names, data, -1, 1, dark, "", "", true);
  }, [p, dark]);

  const score = p.quality.score;
  const bands: [number, string][] = [
    [0.6, STATUS.critical],
    [0.8, STATUS.warning],
    [1, STATUS.good],
  ];
  const columns = p.columns.filter((c) => filter === "all" || (filter === "issues" ? c.type_mismatch || c.null_fraction > 0.2 || (c.outliers?.iqr_count ?? 0) > 0 : c.role === filter));

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        <Card title="Data quality score">
          <EChart height={200} ariaLabel={`Data quality score ${score.toFixed(0)} out of 100`} option={gaugeOption(baseOption(dark), Number(score.toFixed(1)), 100, "quality", dark, bands)} />
          <p className="text-center">
            <Badge tone={qualityTone(score)}>{qualityTone(score) === "good" ? "✓ Good" : qualityTone(score) === "warning" ? "⚠ Fair" : "✕ Poor"}</Badge>
          </p>
          <div className="mt-3">
            <KeyValue
              items={[
                ["Completeness", formatPercent(p.quality.completeness)],
                ["Uniqueness", formatPercent(p.quality.uniqueness)],
                ["Validity", formatPercent(p.quality.validity)],
                ["Consistency", formatPercent(p.quality.consistency)],
              ]}
            />
            <p className="mt-2 font-mono text-[11px] text-[var(--text-2)]">score = {p.quality.formula}</p>
          </div>
        </Card>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTile label="Rows" value={formatNumber(p.row_count)} />
            <StatTile label="Columns" value={formatNumber(p.column_count)} />
            <StatTile label="Duplicate rows" value={formatNumber(p.duplicate_row_count)} sub={p.row_count ? formatPercent(p.duplicate_row_count / p.row_count) : undefined} tone={p.duplicate_row_count ? "critical" : undefined} />
          </div>
          {p.warnings.length > 0 && (
            <Card title={`Warnings (${p.warnings.length})`}>
              <ul className="space-y-1 text-sm">
                {p.warnings.map((w, i) => (
                  <li key={i} className="text-amber-800 dark:text-amber-300">
                    ⚠ {w}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {corr && (
            <Card title="Correlation matrix (Pearson)">
              <EChart height={Math.max(260, Object.keys(p.correlations).length * 28 + 80)} ariaLabel="Correlation heatmap of numeric columns" option={corr} />
            </Card>
          )}
        </div>
      </div>
      <div className="flex items-end justify-between gap-2">
        <h2 className="text-base font-semibold">Columns</h2>
        <SelectField
          label="Show columns"
          className="w-48"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          options={[
            { value: "all", label: "All" },
            { value: "issues", label: "With issues" },
            { value: "continuous", label: "Continuous" },
            { value: "categorical", label: "Categorical" },
            { value: "datetime", label: "Datetime" },
            { value: "identifier", label: "Identifier" },
            { value: "text", label: "Text" },
          ]}
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {columns.map((c) => (
          <ColumnCard key={c.name} col={c} dark={dark} />
        ))}
      </div>
    </div>
  );
}
