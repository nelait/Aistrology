"use client";
/** Opt-in profiling (ANA-004a Isolation Forest, ANA-005a near duplicates, ANA-008 missing-value patterns). */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, type AdvancedProfile, type AdvancedProfileRequest, type DatasetRecord, type Row } from "@/lib/api";
import { axisStyle, baseOption, heatmapOption } from "@/lib/chartOptions";
import { formatNumber, formatPercent } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { EChart } from "../charts/EChart";
import { DataGrid } from "../DataGrid";
import { Badge, Button, Card, Checkbox, EmptyState, SelectField, StatTile, TextField } from "../ui";

function mechanismTone(label: string): "good" | "warning" | "neutral" {
  if (label.startsWith("MCAR")) return "good";
  if (label.startsWith("MAR")) return "warning";
  return "neutral";
}

export function AdvancedProfileTab({ dataset }: { dataset: DatasetRecord }) {
  const multi = dataset.tables.length > 1;
  const [table, setTable] = useState(multi ? dataset.tables[0].name : "");
  const [iso, setIso] = useState({ enabled: true, contamination: "auto" });
  const [dup, setDup] = useState({ enabled: true, threshold: "0.9", window: "10" });
  const [miss, setMiss] = useState({ enabled: true, alpha: "0.05" });

  const run = useMutation({
    mutationFn: () => {
      const body: AdvancedProfileRequest = {
        isolation_forest: iso.enabled ? { enabled: true, contamination: iso.contamination === "auto" ? "auto" : Number(iso.contamination) } : { enabled: false },
        near_duplicates: dup.enabled ? { enabled: true, threshold: Number(dup.threshold) || 0.9, window: Number(dup.window) || 10 } : { enabled: false },
        missing_patterns: miss.enabled ? { enabled: true, alpha: Number(miss.alpha) || 0.05 } : { enabled: false },
      };
      return api.datasets.advancedProfile(dataset.id, body, { version: dataset.version, table: multi ? table : undefined });
    },
    meta: { errorPrefix: "Advanced profile failed" },
  });

  return (
    <div className="space-y-4">
      <Card title="Advanced analyses">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            run.mutate();
          }}
        >
          {multi && (
            <SelectField className="max-w-xs" label="Table" value={table} onChange={(e) => setTable(e.target.value)} options={dataset.tables.map((t) => ({ value: t.name, label: t.name }))} />
          )}
          <div className="grid gap-4 md:grid-cols-3">
            <fieldset className="space-y-2 rounded-md border border-[var(--border)] p-3">
              <legend className="px-1 text-xs font-semibold">Outliers (Isolation Forest)</legend>
              <Checkbox label="Enabled" checked={iso.enabled} onChange={(e) => setIso({ ...iso, enabled: e.target.checked })} />
              <TextField
                label="Contamination"
                value={iso.contamination}
                disabled={!iso.enabled}
                onChange={(e) => setIso({ ...iso, contamination: e.target.value })}
                hint={'"auto" or a share in (0, 0.5]. Numeric columns only.'}
              />
            </fieldset>
            <fieldset className="space-y-2 rounded-md border border-[var(--border)] p-3">
              <legend className="px-1 text-xs font-semibold">Near-duplicate rows</legend>
              <Checkbox label="Enabled" checked={dup.enabled} onChange={(e) => setDup({ ...dup, enabled: e.target.checked })} />
              <TextField label="Similarity threshold" type="number" min={0.5} max={1} step={0.01} disabled={!dup.enabled} value={dup.threshold} onChange={(e) => setDup({ ...dup, threshold: e.target.value })} />
              <TextField label="Blocking window" type="number" min={1} disabled={!dup.enabled} value={dup.window} onChange={(e) => setDup({ ...dup, window: e.target.value })} />
            </fieldset>
            <fieldset className="space-y-2 rounded-md border border-[var(--border)] p-3">
              <legend className="px-1 text-xs font-semibold">Missing-value patterns</legend>
              <Checkbox label="Enabled" checked={miss.enabled} onChange={(e) => setMiss({ ...miss, enabled: e.target.checked })} />
              <TextField label="Significance (alpha)" type="number" min={0.001} max={0.49} step={0.01} disabled={!miss.enabled} value={miss.alpha} onChange={(e) => setMiss({ ...miss, alpha: e.target.value })} />
            </fieldset>
          </div>
          <Button type="submit" variant="primary" loading={run.isPending} disabled={!iso.enabled && !dup.enabled && !miss.enabled}>
            Run analyses
          </Button>
        </form>
      </Card>
      {run.data ? <Results profile={run.data} /> : !run.isPending && <EmptyState title="No results yet">Choose the analyses and run them. Large tables are sampled.</EmptyState>}
    </div>
  );
}

function Results({ profile }: { profile: AdvancedProfile }) {
  const { dark } = useTheme();
  const iso = profile.isolation_forest;
  const dup = profile.near_duplicates;
  const miss = profile.missing_patterns;
  return (
    <div className="space-y-4" aria-live="polite">
      {iso && (
        <Card title="Outliers — Isolation Forest">
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Outliers" value={formatNumber(iso.outlier_count)} sub={formatPercent(iso.outlier_fraction)} tone={iso.outlier_fraction > 0.05 ? "critical" : undefined} />
            <StatTile label="Rows analyzed" value={formatNumber(iso.sampled_rows)} sub={`of ${formatNumber(iso.total_rows)}`} />
            <StatTile label="Contamination" value={String(iso.contamination)} />
            <StatTile label="Columns" value={iso.columns.length} sub={iso.columns.slice(0, 4).join(", ")} />
          </div>
          {iso.examples.length ? (
            <DataGrid
              caption="Most anomalous rows (higher score = more anomalous)"
              columns={["row", "score", ...Object.keys(iso.examples[0].values)]}
              rows={iso.examples.map((e) => ({ row: e.row, score: Number(e.score.toFixed(4)), ...e.values }))}
              pageSize={10}
              dense
            />
          ) : (
            <p className="text-sm text-[var(--text-2)]">{iso.message ? `Skipped: ${iso.message}.` : "No outliers found."}</p>
          )}
        </Card>
      )}
      {dup && (
        <Card title="Near-duplicate rows">
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Duplicate pairs" value={formatNumber(dup.pair_count)} />
            <StatTile label="Clusters" value={formatNumber(dup.cluster_count)} />
            <StatTile label="Rows involved" value={formatNumber(dup.duplicate_rows)} />
            <StatTile label="Rows scanned" value={formatNumber(dup.rows_scanned)} sub={dup.sampled ? "sampled" : `threshold ${dup.threshold}`} />
          </div>
          <p className="mb-2 text-xs text-[var(--text-2)]">Method: {dup.method}. Remove them with the “Fuzzy deduplicate” pipeline step.</p>
          {dup.examples.length ? (
            <ul className="space-y-3">
              {dup.examples.slice(0, 10).map((ex, i) => (
                <li key={i} className="rounded-md border border-[var(--border)] p-2">
                  <p className="mb-1 text-xs">
                    Rows {ex.rows[0]} &amp; {ex.rows[1]} <Badge tone="info">similarity {formatNumber(ex.score, 3)}</Badge>
                  </p>
                  <PairTable a={ex.values[0]} b={ex.values[1]} caption={`Near-duplicate rows ${ex.rows[0]} and ${ex.rows[1]}`} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--text-2)]">No near duplicates above the threshold.</p>
          )}
        </Card>
      )}
      {miss && (
        <Card title="Missing-value patterns">
          <p role="note" className="mb-3 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <Badge tone="warning">Heuristic</Badge> {miss.method}
          </p>
          {miss.columns.length >= 1 ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="mb-1 text-sm font-semibold">Co-missingness heatmap</h3>
                <p className="mb-2 text-xs text-[var(--text-2)]">P(both missing | either missing) for columns with missing values.</p>
                <EChart
                  height={Math.max(260, miss.columns.length * 30 + 110)}
                  ariaLabel="Heatmap of co-missingness between columns"
                  option={heatmapOption(
                    baseOption(dark),
                    axisStyle(dark),
                    miss.columns,
                    miss.columns,
                    miss.columns.flatMap((a, i) => miss.columns.map((b, j) => [i, j, a === b ? 1 : (miss.co_missingness[a]?.[b] ?? null)] as [number, number, number | null])),
                    0,
                    1,
                    dark,
                  )}
                />
              </div>
              <div className="space-y-3">
                <div>
                  <h3 className="mb-1 text-sm font-semibold">Mechanism per column</h3>
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">Missingness mechanism per column</caption>
                    <thead className="text-xs text-[var(--text-2)]">
                      <tr>
                        <th scope="col" className="py-1 pr-2">Column</th>
                        <th scope="col" className="py-1 pr-2">Missing</th>
                        <th scope="col" className="py-1">Label</th>
                      </tr>
                    </thead>
                    <tbody>
                      {miss.mechanisms.map((m) => (
                        <tr key={m.column} className="border-t border-[var(--border)] align-top">
                          <td className="py-1 pr-2 font-mono text-xs">{m.column}</td>
                          <td className="py-1 pr-2 tabular-nums">{formatPercent(m.missing_fraction)}</td>
                          <td className="py-1">
                            <Badge tone={mechanismTone(m.label)}>{m.label}</Badge>
                            {m.associated_with.length > 0 && <span className="block text-xs text-[var(--text-2)]">associated with {m.associated_with.join(", ")}</span>}
                            <span className="block text-xs text-[var(--text-2)]">{m.evidence}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <h3 className="mb-1 text-sm font-semibold">Most common patterns</h3>
                  <ul className="space-y-0.5 text-xs">
                    {miss.patterns.slice(0, 10).map((p, i) => (
                      <li key={i}>
                        <span className="tabular-nums">{formatPercent(p.fraction)}</span> ({formatNumber(p.count)} rows):{" "}
                        {p.missing_columns.length ? <span className="font-mono">{p.missing_columns.join(", ")}</span> : "complete rows"}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[var(--text-2)]">No missing values in the analyzed rows ({formatNumber(miss.rows_analyzed)}).</p>
          )}
        </Card>
      )}
    </div>
  );
}

function PairTable({ a, b, caption }: { a: Row; b: Row; caption: string }) {
  const cols = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
  return (
    <div className="overflow-x-auto">
      <table className="text-left text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="pr-3"><span className="sr-only">Row</span></th>
            {cols.map((c) => (
              <th key={c} scope="col" className="pr-3 font-mono font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[a, b].map((r, i) => (
            <tr key={i}>
              <th scope="row" className="pr-3 text-[var(--text-2)]">{i === 0 ? "A" : "B"}</th>
              {cols.map((c) => (
                <td key={c} className={`pr-3 ${String(a[c]) !== String(b[c]) ? "font-semibold text-amber-800 dark:text-amber-300" : ""}`}>
                  {r[c] === null || r[c] === undefined ? "—" : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
