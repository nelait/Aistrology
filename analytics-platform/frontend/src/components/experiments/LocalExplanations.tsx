"use client";
/** Local explanations (XAI-002a): SHAP force plot and a LIME local surrogate for one instance. */
import type { ForcePlot, LimeExplanation } from "@/lib/types";
import { barH } from "@/lib/chartOptions";
import { formatNumber } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { EChart } from "../charts/EChart";
import { Badge, KeyValue } from "../ui";

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "missing";
  return typeof v === "number" ? formatNumber(v) : String(v);
}

/** Force plot: features pushing the output up (red) or down (blue) from the base value. */
export function ForcePlotView({ plot }: { plot: ForcePlot }) {
  const feats = plot.features.slice(0, 10);
  const total = feats.reduce((s, f) => s + Math.abs(f.shap), 0) || 1;
  const up = feats.filter((f) => f.direction === "up" || f.shap > 0);
  const down = feats.filter((f) => !(f.direction === "up" || f.shap > 0));
  const seg = (f: ForcePlot["features"][number], positive: boolean) => (
    <div
      key={f.feature}
      className={positive ? "flex h-8 items-center justify-center overflow-hidden border-r border-white/60 bg-red-600/85 text-[10px] text-white dark:bg-red-500/80" : "flex h-8 items-center justify-center overflow-hidden border-l border-white/60 bg-blue-600/85 text-[10px] text-white dark:bg-blue-500/80"}
      style={{ width: `${(Math.abs(f.shap) / total) * 100}%` }}
      title={`${f.feature} = ${fmtValue(f.value)}: ${f.shap >= 0 ? "+" : ""}${formatNumber(f.shap)}`}
    >
      <span className="truncate px-1">{f.feature}</span>
    </div>
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-4 text-sm">
        <span>
          Base value <strong className="tabular-nums">{formatNumber(plot.base_value)}</strong>
        </span>
        <span>
          Output <strong className="tabular-nums">{formatNumber(plot.output_value)}</strong>
        </span>
      </div>
      <div className="flex w-full overflow-hidden rounded-md" role="img" aria-label={`Force plot: ${up.length} features push the prediction up, ${down.length} push it down`}>
        {up.map((f) => seg(f, true))}
        {down.map((f) => seg(f, false))}
      </div>
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <p className="mb-1 font-medium text-red-700 dark:text-red-400">▲ Pushes the prediction up</p>
          <ul className="space-y-0.5 text-xs">
            {up.map((f) => (
              <li key={f.feature} className="tabular-nums">
                {f.feature} = {fmtValue(f.value)}: +{formatNumber(Math.abs(f.shap))}
              </li>
            ))}
            {!up.length && <li className="text-[var(--text-2)]">none</li>}
          </ul>
        </div>
        <div>
          <p className="mb-1 font-medium text-blue-700 dark:text-blue-400">▼ Pushes the prediction down</p>
          <ul className="space-y-0.5 text-xs">
            {down.map((f) => (
              <li key={f.feature} className="tabular-nums">
                {f.feature} = {fmtValue(f.value)}: −{formatNumber(Math.abs(f.shap))}
              </li>
            ))}
            {!down.length && <li className="text-[var(--text-2)]">none</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}

export function LimeView({ lime }: { lime: LimeExplanation }) {
  const { dark } = useTheme();
  const items = lime.weights.map((w) => ({ name: `${w.feature} = ${fmtValue(w.value)}`, value: w.weight }));
  return (
    <div className="space-y-3">
      <KeyValue
        items={[
          ["Model prediction", fmtValue(lime.prediction)],
          ["Local surrogate prediction", formatNumber(lime.local_prediction)],
          ["Intercept", formatNumber(lime.intercept)],
          [
            "Surrogate fit (R²)",
            <span key="r2">
              {formatNumber(lime.r2, 3)} {lime.r2 < 0.5 && <Badge tone="warning">low: interpret with care</Badge>}
            </span>,
          ],
          ...(lime.explained_class !== undefined && lime.explained_class !== null ? ([["Explained class", String(lime.explained_class)]] as [string, string][]) : []),
        ]}
      />
      <EChart height={Math.min(420, 60 + items.length * 24)} ariaLabel="LIME feature weights for this prediction" option={barH(items, { dark, name: "local weight", signed: true })} />
      <p className="text-xs text-[var(--text-2)]">LIME fits a weighted linear model around this instance; weights show each feature&apos;s local effect.</p>
    </div>
  );
}
