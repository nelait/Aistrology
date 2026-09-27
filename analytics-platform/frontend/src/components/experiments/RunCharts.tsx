"use client";
import { useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import type { Run } from "@/lib/types";
import { axisStyle, barH, baseOption, heatmapOption, lineXY, scatterXY } from "@/lib/chartOptions";
import { formatNumber } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { EChart } from "../charts/EChart";
import { DataGrid } from "../DataGrid";
import { Card, SelectField } from "../ui";

function ChartCard({ title, option, height = 280, note }: { title: string; option: EChartsOption; height?: number; note?: string }) {
  return (
    <Card title={title}>
      {note && <p className="mb-2 text-xs text-[var(--text-2)]">{note}</p>}
      <EChart option={option} height={height} ariaLabel={title} />
    </Card>
  );
}

function confusion(run: Run): { labels: string[]; matrix: number[][] } | null {
  const cm = run.artifacts.confusion_matrix;
  if (!cm) return null;
  if (Array.isArray(cm)) {
    const labels = (run.artifacts.classes ?? cm.map((_, i) => i)).map(String);
    return { labels, matrix: cm };
  }
  return { labels: (cm.labels ?? cm.matrix.map((_, i) => i)).map(String), matrix: cm.matrix };
}

/** Evaluation and explainability plots for one run (EXP-002/003/006, XAI-001/002). */
export function RunCharts({ run }: { run: Run }) {
  const { dark } = useTheme();
  const a = run.artifacts;
  const pdpFeatures = Object.keys(a.pdp ?? {});
  const [pdpFeature, setPdpFeature] = useState(pdpFeatures[0] ?? "");
  const cm = useMemo(() => confusion(run), [run]);

  const cards: React.ReactNode[] = [];
  if (cm) {
    const data: [number, number, number][] = [];
    cm.matrix.forEach((row, i) => row.forEach((v, j) => data.push([j, i, v])));
    const max = Math.max(...cm.matrix.flat());
    cards.push(
      <ChartCard
        key="cm"
        title="Confusion matrix"
        note="Rows: actual class · columns: predicted class"
        option={heatmapOption(baseOption(dark), axisStyle(dark), cm.labels, cm.labels, data, 0, max, dark, "predicted", "actual")}
        height={Math.max(260, cm.labels.length * 36 + 90)}
      />,
    );
  }
  if (a.roc_curve)
    cards.push(
      <ChartCard
        key="roc"
        title={`ROC curve${run.metrics.roc_auc !== undefined ? ` (AUC ${formatNumber(run.metrics.roc_auc)})` : a.roc_curve.auc ? ` (AUC ${formatNumber(a.roc_curve.auc)})` : ""}`}
        option={lineXY([{ name: "ROC", x: a.roc_curve.fpr, y: a.roc_curve.tpr, area: true }], { dark, xName: "False positive rate", yName: "True positive rate", xMax: 1, yMax: 1, diagonal: true })}
      />,
    );
  if (a.pr_curve)
    cards.push(
      <ChartCard
        key="pr"
        title={`Precision–recall${run.metrics.pr_auc !== undefined ? ` (AUC ${formatNumber(run.metrics.pr_auc)})` : ""}`}
        option={lineXY([{ name: "PR", x: a.pr_curve.recall, y: a.pr_curve.precision, area: true }], { dark, xName: "Recall", yName: "Precision", xMax: 1, yMax: 1 })}
      />,
    );
  if (a.calibration)
    cards.push(
      <ChartCard
        key="cal"
        title="Calibration"
        note="A well-calibrated model follows the dotted diagonal."
        option={lineXY([{ name: "Model", x: a.calibration.prob_pred, y: a.calibration.prob_true }], { dark, xName: "Mean predicted probability", yName: "Fraction of positives", xMax: 1, yMax: 1, diagonal: true })}
      />,
    );
  if (a.residuals)
    cards.push(
      <ChartCard
        key="res"
        title="Residuals"
        option={scatterXY(
          a.residuals.predicted.map((p, i) => [p, a.residuals!.residual[i]]),
          { dark, xName: "Predicted", yName: "Residual", zeroLine: true },
        )}
      />,
    );
  if (a.learning_curve)
    cards.push(
      <ChartCard
        key="lc"
        title="Learning curve"
        option={lineXY(
          [
            { name: "Training score", x: a.learning_curve.train_sizes, y: a.learning_curve.train_scores },
            { name: "Validation score", x: a.learning_curve.train_sizes, y: a.learning_curve.val_scores, dashed: true },
          ],
          { dark, xName: "Training examples", yName: "Score" },
        )}
      />,
    );
  if (a.feature_importance?.length)
    cards.push(
      <ChartCard
        key="fi"
        title="Feature importance"
        height={Math.min(520, 60 + Math.min(20, a.feature_importance.length) * 22)}
        option={barH(a.feature_importance.map((f) => ({ name: f.feature, value: f.importance })), { dark, name: "importance" })}
      />,
    );
  if (a.permutation_importance?.length)
    cards.push(
      <ChartCard
        key="pi"
        title="Permutation importance"
        height={Math.min(520, 60 + Math.min(20, a.permutation_importance.length) * 22)}
        option={barH(a.permutation_importance.map((f) => ({ name: f.feature, value: f.importance })), { dark, name: "score drop" })}
      />,
    );
  if (a.shap_summary?.length)
    cards.push(
      <ChartCard
        key="shap"
        title="SHAP summary (mean |SHAP|)"
        height={Math.min(520, 60 + Math.min(20, a.shap_summary.length) * 22)}
        option={barH(a.shap_summary.map((f) => ({ name: f.feature, value: f.mean_abs_shap })), { dark, name: "mean |SHAP value|" })}
      />,
    );
  if (pdpFeatures.length) {
    const f = a.pdp![pdpFeature] ?? a.pdp![pdpFeatures[0]];
    cards.push(
      <Card key="pdp" title="Partial dependence">
        <SelectField label="Feature" value={pdpFeature} onChange={(e) => setPdpFeature(e.target.value)} options={pdpFeatures.map((x) => ({ value: x, label: x }))} className="mb-2 max-w-xs" />
        <EChart ariaLabel={`Partial dependence on ${pdpFeature}`} height={240} option={lineXY([{ name: "average prediction", x: f.grid, y: f.average }], { dark, xName: pdpFeature, yName: "Average prediction" })} />
      </Card>,
    );
  }

  return (
    <div className="space-y-4">
      {a.explanation_text && (
        <Card title="Explanation">
          <p className="text-sm">{a.explanation_text}</p>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">{cards}</div>
      {!cards.length && <p className="text-sm text-[var(--text-2)]">No evaluation artifacts for this run yet.</p>}
      {a.leaderboard?.length ? (
        <Card title="AutoML trials">
          <DataGrid
            columns={Array.from(new Set(a.leaderboard.flatMap((t) => [...Object.keys(t).filter((k) => k !== "params" && k !== "metrics"), ...Object.keys(t.metrics ?? {}), "params"])))}
            rows={a.leaderboard.map((t) => ({ ...t, ...(t.metrics ?? {}), params: t.params ? JSON.stringify(t.params) : "" }))}
            pageSize={10}
            dense
            caption="AutoML trials"
          />
        </Card>
      ) : null}
    </div>
  );
}
