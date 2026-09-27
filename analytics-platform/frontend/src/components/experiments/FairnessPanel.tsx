"use client";
/** XAI-004: per-group metrics for protected attributes, demographic parity / equalized odds and the four-fifths rule. */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, type FairnessAttribute, type JsonValue } from "@/lib/api";
import { fourFifthsView, METRIC_HELP, parityTone, ratioTone } from "@/lib/fairness";
import { formatNumber, formatPercent } from "@/lib/format";
import { Badge, Button, Card, InfoTip, MultiSelect, SelectField, TextField, cx, toOptions } from "../ui";

const TONE_TEXT = {
  good: "text-green-800 dark:text-green-300",
  warning: "text-amber-800 dark:text-amber-300",
  critical: "text-red-700 dark:text-red-400",
  neutral: "",
} as const;

export function FairnessPanel({ runId, columns, target, classes }: { runId: string; columns: string[]; target?: string | null; classes?: JsonValue[] }) {
  const [protectedCols, setProtected] = useState<string[]>([]);
  const [positive, setPositive] = useState("");
  const [minGroup, setMinGroup] = useState("10");
  const run = useMutation({
    mutationFn: () => {
      const cls = classes?.find((c) => String(c) === positive);
      return api.training.fairness(runId, { protected: protectedCols, positive_class: positive ? (cls ?? positive) : undefined, min_group_size: Math.max(1, Number(minGroup) || 10) });
    },
    meta: { silent: true },
  });
  const err = run.error;
  const errText =
    err instanceof ApiError && err.code === "holdout_missing"
      ? "This run was trained before fairness analysis was available, so its held-out predictions weren't stored. Retrain the experiment to analyse it."
      : err instanceof Error
        ? err.message
        : err
          ? String(err)
          : null;
  const options = columns.filter((c) => c !== target);

  return (
    <div className="space-y-4">
      <Card title="Fairness analysis">
        <p className="mb-3 text-sm text-[var(--text-2)]">
          Compare how the model treats groups on the held-out test set. Choose the attributes to check (any dataset column, used as a feature or not). Numeric columns with many values are split into quartiles.
        </p>
        <form
          className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_14rem]"
          onSubmit={(e) => {
            e.preventDefault();
            if (protectedCols.length) run.mutate();
          }}
        >
          <MultiSelect label="Protected attributes (1–20)" options={toOptions(options)} value={protectedCols} onChange={(v) => setProtected(v.slice(0, 20))} maxHeight={160} />
          <div className="space-y-3">
            {classes?.length ? (
              <SelectField label="Positive outcome" value={positive} onChange={(e) => setPositive(e.target.value)} options={classes.map((c) => ({ value: String(c), label: String(c) }))} placeholder="Default (2nd / rarest class)" />
            ) : (
              <TextField label="Positive outcome" value={positive} onChange={(e) => setPositive(e.target.value)} placeholder="Default (2nd / rarest class)" />
            )}
            <TextField label="Minimum group size" type="number" min={1} value={minGroup} onChange={(e) => setMinGroup(e.target.value)} hint="Smaller groups are shown but left out of the summary" />
            <Button type="submit" variant="primary" loading={run.isPending} disabled={!protectedCols.length}>
              Analyse
            </Button>
          </div>
        </form>
        {errText && (
          <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
            {errText}
          </p>
        )}
      </Card>
      {run.data && (
        <div className="space-y-4" aria-live="polite">
          <p className="text-sm text-[var(--text-2)]">
            Positive outcome <Badge tone="info">{String(run.data.positive_class)}</Badge> · {run.data.n_test.toLocaleString()} test rows · groups under {run.data.min_group_size} rows are marked “small”.
          </p>
          {run.data.attributes.map((a) => (
            <AttributeCard key={a.attribute} attr={a} positive={run.data.positive_class} />
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, help, tone }: { label: string; value: string; help: string; tone: keyof typeof TONE_TEXT }) {
  return (
    <div className="rounded-md border border-[var(--border)] p-2">
      <p className="flex items-center gap-1 text-xs text-[var(--text-2)]">
        {label} <InfoTip text={help} label={`About ${label}`} />
      </p>
      <p className={cx("text-lg font-semibold tabular-nums", TONE_TEXT[tone])}>{value}</p>
    </div>
  );
}

function AttributeCard({ attr, positive }: { attr: FairnessAttribute; positive: JsonValue }) {
  const view = fourFifthsView(attr, positive);
  const threshold = attr.four_fifths_rule?.threshold ?? 0.8;
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {attr.attribute}
          <Badge>{attr.grouping}</Badge>
          <Badge tone={view.tone === "neutral" ? "neutral" : view.tone}>
            <span aria-hidden="true">{view.status === "pass" ? "✓" : view.status === "flag" ? "⚠" : "•"}</span> {view.label}
          </Badge>
        </span>
      }
    >
      <p className={cx("mb-3 rounded-md p-2 text-sm", view.status === "flag" ? "bg-amber-50 dark:bg-amber-950" : "bg-[var(--surface-2)]")}>{view.message}</p>
      <div className="mb-3 grid gap-2 sm:grid-cols-3">
        <Metric label="Demographic parity difference" value={formatNumber(attr.demographic_parity_difference)} help={METRIC_HELP.demographic_parity_difference} tone={parityTone(attr.demographic_parity_difference)} />
        <Metric
          label="Demographic parity ratio"
          value={formatNumber(attr.demographic_parity_ratio)}
          help={METRIC_HELP.demographic_parity_ratio}
          tone={attr.demographic_parity_ratio === null ? "neutral" : attr.demographic_parity_ratio >= threshold ? "good" : "warning"}
        />
        <Metric label="Equalized odds difference" value={formatNumber(attr.equalized_odds_difference)} help={METRIC_HELP.equalized_odds_difference} tone={parityTone(attr.equalized_odds_difference)} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Per-group metrics for {attr.attribute}</caption>
          <thead className="bg-[var(--surface-2)] text-xs">
            <tr>
              <th scope="col" className="px-2 py-1.5">Group</th>
              <th scope="col" className="px-2 py-1.5">Rows</th>
              <th scope="col" className="px-2 py-1.5">Selection rate</th>
              <th scope="col" className="px-2 py-1.5">
                Selection ratio <InfoTip text={METRIC_HELP.selection_ratio} label="About selection ratio" />
              </th>
              <th scope="col" className="px-2 py-1.5">Base rate</th>
              <th scope="col" className="px-2 py-1.5">TPR</th>
              <th scope="col" className="px-2 py-1.5">FPR</th>
              <th scope="col" className="px-2 py-1.5">Precision</th>
              <th scope="col" className="px-2 py-1.5">Accuracy</th>
            </tr>
          </thead>
          <tbody>
            {attr.groups.map((g) => {
              const tone = ratioTone(g, threshold);
              const flagged = view.flagged.includes(g.group);
              return (
                <tr key={g.group} className={cx("border-t border-[var(--border)]", g.small_group && "text-[var(--text-2)]")}>
                  <th scope="row" className="px-2 py-1.5 font-medium">
                    {g.group} {g.small_group && <Badge>small</Badge>}
                  </th>
                  <td className="px-2 py-1.5 tabular-nums">{g.n.toLocaleString()}</td>
                  <td className="px-2 py-1.5 tabular-nums">{formatPercent(g.selection_rate)}</td>
                  <td className={cx("px-2 py-1.5 tabular-nums font-medium", TONE_TEXT[tone])}>
                    {formatNumber(g.selection_ratio)} {flagged && <span aria-label="below the four-fifths threshold">⚠</span>}
                  </td>
                  <td className="px-2 py-1.5 tabular-nums">{formatPercent(g.base_rate)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{formatPercent(g.tpr)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{formatPercent(g.fpr)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{formatPercent(g.precision)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{formatPercent(g.accuracy)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
