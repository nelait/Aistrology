/** Drift (API-011) status helpers: PSI → ok / warn / alert, with labels and tones for badges and bars. */
import { STATUS } from "./chartOptions";

export type PsiLevel = "ok" | "warn" | "alert" | "unknown";

export const DEFAULT_PSI_THRESHOLDS = { warn: 0.1, alert: 0.25 };

/** Map a PSI value to a level: < warn → ok, ≥ warn → warn, ≥ alert → alert; missing / NaN → unknown. */
export function psiStatus(psi: number | null | undefined, thresholds: { warn: number; alert: number } = DEFAULT_PSI_THRESHOLDS): PsiLevel {
  if (psi === null || psi === undefined || !Number.isFinite(psi)) return "unknown";
  if (psi >= thresholds.alert) return "alert";
  if (psi >= thresholds.warn) return "warn";
  return "ok";
}

export type Tone = "neutral" | "info" | "good" | "warning" | "critical";

/** Badge tone for a server drift status (ok, warn, alert, insufficient_data, no_data, not_applicable). */
export function driftTone(status: string | null | undefined): Tone {
  switch (status) {
    case "ok":
      return "good";
    case "warn":
      return "warning";
    case "alert":
      return "critical";
    case "insufficient_data":
      return "info";
    default:
      return "neutral";
  }
}

const LABELS: Record<string, string> = {
  ok: "No drift",
  warn: "Moderate drift",
  alert: "Significant drift",
  insufficient_data: "Not enough samples",
  no_data: "No traffic",
  not_applicable: "Not applicable",
  unknown: "Unknown",
};

export function driftLabel(status: string | null | undefined): string {
  return LABELS[status ?? "unknown"] ?? String(status);
}

export const DRIFT_ICON: Record<string, string> = { ok: "✓", warn: "▲", alert: "✕", insufficient_data: "…", no_data: "∅", not_applicable: "–", unknown: "?" };

/** Bar color for a PSI value (status palette). */
export function psiColor(psi: number | null | undefined, thresholds = DEFAULT_PSI_THRESHOLDS): string {
  const level = psiStatus(psi, thresholds);
  return level === "alert" ? STATUS.critical : level === "warn" ? STATUS.warning : level === "ok" ? STATUS.good : "#8a8983";
}
