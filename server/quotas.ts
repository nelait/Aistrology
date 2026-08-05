import { getGlobalSetting, setGlobalSetting } from "./db";
import {
  DEFAULT_PLAN_DAILY_LIMITS, QUOTA_PLANS, QUOTA_FEATURES,
  mergePlanLimits, setActivePlanLimits, getActivePlanLimits, type PlanLimits,
} from "./rateLimit";

// Admin-editable per-plan daily quotas, persisted globally and merged over the
// code defaults. The effective table lives in-memory (rateLimit.activeLimits);
// this module loads it at boot and rewrites it on save.

const KEY = "quotas";
const MAX_LIMIT = 100_000; // sanity ceiling; 0 = block the feature for that plan

/** Coerce arbitrary input into a full, validated limit table (ints in range). */
function sanitize(input: unknown): PlanLimits {
  const obj = (input ?? {}) as Record<string, Record<string, unknown>>;
  const out: PlanLimits = {};
  for (const plan of QUOTA_PLANS) {
    out[plan] = {};
    for (const f of QUOTA_FEATURES) {
      const raw = Number(obj[plan]?.[f.key]);
      out[plan][f.key] = Number.isFinite(raw)
        ? Math.max(0, Math.min(MAX_LIMIT, Math.floor(raw)))
        : DEFAULT_PLAN_DAILY_LIMITS[plan][f.key];
    }
  }
  return out;
}

/** Load stored overrides at startup and activate the effective table. */
export async function loadQuotas(): Promise<void> {
  const stored = await getGlobalSetting(KEY);
  setActivePlanLimits(mergePlanLimits(stored as Partial<PlanLimits>));
}

/** Persist a new limit table and activate it. Returns the effective table. */
export async function saveQuotas(input: unknown): Promise<PlanLimits> {
  const clean = sanitize(input);
  await setGlobalSetting(KEY, clean);
  setActivePlanLimits(mergePlanLimits(clean));
  return getActivePlanLimits();
}

/** Discard overrides and revert to the code defaults. */
export async function resetQuotas(): Promise<PlanLimits> {
  await setGlobalSetting(KEY, {});
  setActivePlanLimits(mergePlanLimits(null));
  return getActivePlanLimits();
}

export function currentQuotas(): PlanLimits { return getActivePlanLimits(); }
