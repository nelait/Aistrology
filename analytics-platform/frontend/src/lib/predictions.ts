import type { AnomalyPrediction } from "./types";
import { formatNumber } from "./format";

export function isAnomalyPrediction(v: unknown): v is AnomalyPrediction {
  return !!v && typeof v === "object" && !Array.isArray(v) && "is_anomaly" in v && "score" in v;
}

/** Human text for one prediction value (class, number or an anomaly object). */
export function formatPrediction(v: unknown): string {
  if (isAnomalyPrediction(v)) return `${v.is_anomaly ? "Anomaly" : "Normal"} (score ${formatNumber(v.score, 4)})`;
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return formatNumber(v, 4);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
