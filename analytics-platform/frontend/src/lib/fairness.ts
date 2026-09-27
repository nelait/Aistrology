/** Display logic for the fairness panel (XAI-004): four-fifths rule, parity metrics and plain-language guidance. */
import type { FairnessAttribute, FairnessGroup } from "./types";

export type FairnessTone = "good" | "warning" | "critical" | "neutral";

export interface FourFifthsView {
  status: "pass" | "flag" | "insufficient";
  tone: FairnessTone;
  /** short badge text */
  label: string;
  /** one or two sentences for non-specialists */
  message: string;
  flagged: string[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Groups that count towards the summary metrics (not below min_group_size). */
export function comparableGroups(attr: FairnessAttribute): FairnessGroup[] {
  return attr.groups.filter((g) => !g.small_group);
}

/**
 * Summarize the four-fifths (80 %) rule for one attribute. The API reports `passed` (null when fewer than
 * two groups are large enough to compare) and the flagged groups; this turns that into a status and guidance.
 */
export function fourFifthsView(attr: FairnessAttribute, positiveClass?: unknown): FourFifthsView {
  const rule = attr.four_fifths_rule;
  const threshold = rule?.threshold ?? 0.8;
  const comparable = comparableGroups(attr);
  const outcome = positiveClass !== undefined && positiveClass !== null ? `“${String(positiveClass)}”` : "the positive outcome";
  if (!rule || rule.passed === null || rule.passed === undefined || comparable.length < 2) {
    return {
      status: "insufficient",
      tone: "neutral",
      label: "Not enough data",
      message: `Fewer than two groups of “${attr.attribute}” are large enough to compare. Lower the minimum group size or evaluate on more data.`,
      flagged: [],
    };
  }
  const flagged = rule.flagged_groups ?? [];
  if (rule.passed && !flagged.length) {
    return {
      status: "pass",
      tone: "good",
      label: "Passes four-fifths rule",
      message: `Every group of “${attr.attribute}” receives ${outcome} at least ${pct(threshold)} as often as the most-selected group.`,
      flagged: [],
    };
  }
  const worst = minRatio(attr);
  return {
    status: "flag",
    tone: worst !== null && worst < threshold / 2 ? "critical" : "warning",
    label: `${flagged.length} group${flagged.length === 1 ? "" : "s"} below ${pct(threshold)}`,
    message:
      `${flagged.join(", ")} ${flagged.length === 1 ? "receives" : "receive"} ${outcome} less than ${pct(threshold)} as often as the most-selected group` +
      (worst !== null ? ` (lowest ratio ${pct(worst)})` : "") +
      ". This is a common screening signal of adverse impact, not proof of unfairness: check whether the difference is explained by legitimate factors, and consider rebalancing the data, removing proxy features or adjusting the decision threshold per use case.",
    flagged,
  };
}

/** Lowest selection ratio among comparable groups. */
export function minRatio(attr: FairnessAttribute): number | null {
  const ratios = comparableGroups(attr)
    .map((g) => g.selection_ratio)
    .filter((r): r is number => typeof r === "number" && Number.isFinite(r));
  return ratios.length ? Math.min(...ratios) : null;
}

/** Tone for one group's selection ratio cell. */
export function ratioTone(g: FairnessGroup, threshold = 0.8): FairnessTone {
  if (g.small_group || g.selection_ratio === null || g.selection_ratio === undefined) return "neutral";
  if (g.selection_ratio >= threshold) return "good";
  return g.selection_ratio < threshold / 2 ? "critical" : "warning";
}

/** Demographic parity difference: 0 is parity; ≥ 0.2 is usually worth a look, ≥ 0.1 a note. */
export function parityTone(diff: number | null | undefined): FairnessTone {
  if (diff === null || diff === undefined || !Number.isFinite(diff)) return "neutral";
  const d = Math.abs(diff);
  if (d < 0.1) return "good";
  if (d < 0.2) return "warning";
  return "critical";
}

export const METRIC_HELP = {
  demographic_parity_difference: "Largest gap in selection rate (share predicted positive) between groups. 0 means every group is selected equally often.",
  demographic_parity_ratio: "Lowest selection rate divided by the highest. 1 means parity; below 0.8 fails the four-fifths rule.",
  equalized_odds_difference: "Largest gap in true-positive or false-positive rate between groups: whether the model is equally accurate for everyone, given the actual outcome.",
  selection_ratio: "The group's selection rate divided by the highest group's rate.",
} as const;
