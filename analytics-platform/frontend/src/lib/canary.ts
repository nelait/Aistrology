/** Canary rollout helpers (API-009). */
import type { CanaryRollout } from "./types";

/** Parse "5, 25, 50" → [5, 25, 50, 100]: strictly increasing percentages 1–100; a final 100 is appended. */
export function parseSteps(text: string): { steps: number[] | null; error: string | null } {
  const parts = text
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return { steps: null, error: "Enter at least one step" };
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 100)) return { steps: null, error: "Steps are whole percentages between 1 and 100" };
  for (let i = 1; i < nums.length; i++) if (nums[i] <= nums[i - 1]) return { steps: null, error: "Steps must be strictly increasing" };
  if (nums.length > 20) return { steps: null, error: "At most 20 steps" };
  return { steps: nums[nums.length - 1] === 100 ? nums : [...nums, 100], error: null };
}

export type StepState = "done" | "current" | "pending" | "failed";

/** State of each step for the progress indicator. */
export function stepStates(r: Pick<CanaryRollout, "steps" | "step_index" | "status">): StepState[] {
  return r.steps.map((_, i) => {
    if (r.status === "completed") return "done";
    if (i < r.step_index) return "done";
    if (i === r.step_index) return r.status === "running" ? "current" : r.status === "rolled_back" || r.status === "aborted" ? "failed" : "pending";
    return "pending";
  });
}

export const CANARY_EVENT_LABELS: Record<string, string> = {
  start: "Started",
  ramp: "Ramped up",
  hold: "Held (not enough requests)",
  completed: "Completed",
  rolled_back: "Rolled back",
  aborted: "Aborted",
  promoted: "Promoted",
};

export function canaryTone(status: string): "info" | "good" | "critical" | "warning" | "neutral" {
  switch (status) {
    case "running":
      return "info";
    case "completed":
      return "good";
    case "rolled_back":
      return "critical";
    case "aborted":
      return "warning";
    default:
      return "neutral";
  }
}
