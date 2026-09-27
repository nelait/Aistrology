"use client";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type Experiment, type Run } from "@/lib/api";
import { axisStyle, baseOption, waterfallOption } from "@/lib/chartOptions";
import { formatNumber } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { EChart } from "../charts/EChart";
import { Button, Card, SelectField, TabPanel, Tabs, TextField } from "../ui";
import { ForcePlotView, LimeView } from "./LocalExplanations";

/** What-if analysis (XAI-003): edit feature values, see prediction and SHAP contributions (XAI-002). */
export function WhatIf({ run, experiment }: { run: Run; experiment: Experiment }) {
  const { dark } = useTheme();
  const profile = useQuery({ queryKey: ["profile", experiment.dataset_id, "latest"], queryFn: () => api.datasets.profile(experiment.dataset_id), meta: { silent: true } });
  const features = useMemo(() => {
    if (experiment.config.features?.length) return experiment.config.features;
    const fromArtifacts = run.artifacts.feature_importance?.map((f) => f.feature) ?? [];
    return fromArtifacts.length ? fromArtifacts : (profile.data?.columns.map((c) => c.name).filter((c) => c !== experiment.config.target) ?? []);
  }, [experiment, run, profile.data]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [view, setView] = useState("waterfall");

  // Start from typical values: median for numbers, most frequent value otherwise.
  useEffect(() => {
    if (!profile.data) return;
    setValues((prev) => {
      const next = { ...prev };
      for (const f of features) {
        if (next[f] !== undefined) continue;
        const c = profile.data!.columns.find((x) => x.name === f);
        next[f] = c?.median !== null && c?.median !== undefined ? String(c.median) : c?.top_values?.[0]?.[0] !== undefined ? String(c.top_values[0][0]) : "";
      }
      return next;
    });
  }, [profile.data, features]);

  const colType = (f: string) => profile.data?.columns.find((c) => c.name === f)?.type;
  const explain = useMutation({
    mutationFn: () => {
      const instance: Record<string, unknown> = {};
      for (const f of features) {
        const t = colType(f);
        const v = values[f] ?? "";
        instance[f] = v === "" ? null : t === "integer" || t === "number" ? Number(v) : t === "boolean" ? v === "true" : v;
      }
      return api.training.explain(run.id, [instance]);
    },
    meta: { errorPrefix: "What-if failed" },
  });

  const result = explain.data;
  const shap = result?.shap?.[0];
  const base = Array.isArray(result?.base_value) ? result!.base_value[0] : result?.base_value;
  const option = useMemo(() => {
    if (!shap) return null;
    const entries = Object.entries(shap).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12);
    const cats = ["base value", ...entries.map(([k]) => k)];
    const deltas = [base ?? 0, ...entries.map(([, v]) => v)];
    return waterfallOption(baseOption(dark), axisStyle(dark), cats, deltas, dark, "model output");
  }, [shap, base, dark]);

  return (
    <Card title="What-if analysis">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          explain.mutate();
        }}
        className="space-y-3"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f) => {
            const col = profile.data?.columns.find((c) => c.name === f);
            const cats = col?.top_values && (col.type === "string" || col.type === "boolean") ? col.top_values.map(([v]) => String(v)) : null;
            return cats && cats.length <= 30 ? (
              <SelectField key={f} label={f} value={values[f] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))} options={cats.map((c) => ({ value: c, label: c }))} placeholder="(missing)" />
            ) : (
              <TextField
                key={f}
                label={f}
                type={col?.type === "integer" || col?.type === "number" ? "number" : col?.type === "date" ? "date" : "text"}
                step="any"
                value={values[f] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
              />
            );
          })}
        </div>
        <Button type="submit" variant="primary" loading={explain.isPending}>
          Predict &amp; explain
        </Button>
      </form>
      {result && (
        <div className="mt-4 space-y-3" aria-live="polite">
          <p className="text-lg">
            Prediction: <strong className="tabular-nums">{typeof result.predictions[0] === "number" ? formatNumber(result.predictions[0]) : String(result.predictions[0])}</strong>
          </p>
          <Tabs
            label="Explanation view"
            active={view}
            onChange={setView}
            tabs={[
              { id: "waterfall", label: "SHAP waterfall" },
              { id: "force", label: "Force plot", hidden: !result.force_plot?.[0] },
              { id: "lime", label: "LIME", hidden: !result.lime?.[0] },
            ]}
          />
          <TabPanel id={view}>
            {view === "waterfall" && option && <EChart option={option} height={320} ariaLabel="SHAP waterfall: contribution of each feature from the base value to the prediction" />}
            {view === "force" && result.force_plot?.[0] && <ForcePlotView plot={result.force_plot[0]} />}
            {view === "lime" && result.lime?.[0] && <LimeView lime={result.lime[0]} />}
          </TabPanel>
        </div>
      )}
    </Card>
  );
}
