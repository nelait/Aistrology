import { Request, Response, NextFunction } from "express";
import { getGlobalSetting, setGlobalSetting } from "./db";

// Admin-controlled feature flags. Stored globally; default enabled. Disabling a
// feature hides it in the UI AND blocks its API routes (defense in depth).

export const FEATURE_KEYS = ["consultation", "temples", "vastu", "reminders", "chat", "notes"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURE_META: Record<FeatureKey, { label: string; description: string }> = {
  consultation: {
    label: "Consultations",
    description: "Book astrologer consultations and let Premium users offer provider services.",
  },
  temples: {
    label: "Temples & Pooja Services",
    description: "The temple registration portal and the Pooja Services directory for devotees.",
  },
  vastu: {
    label: "Vastu",
    description: "Vastu property-suitability analysis and its AI reading.",
  },
  reminders: {
    label: "Reminders",
    description: "Personal ritual/date reminders and opt-in festival reminders, delivered by email + in-app.",
  },
  chat: {
    label: "Astro Chat",
    description: "The logged-in AI chat grounded in the user's chart and current module.",
  },
  notes: {
    label: "Notes",
    description: "Per-profile notes for Pro/Premium users managing many charts.",
  },
};

const KEY = "features";

export async function getFeatures(): Promise<Record<FeatureKey, boolean>> {
  const stored = await getGlobalSetting(KEY);
  const out = {} as Record<FeatureKey, boolean>;
  for (const k of FEATURE_KEYS) out[k] = stored[k] !== false; // default: enabled
  return out;
}

export async function setFeatures(
  patch: Partial<Record<FeatureKey, boolean>>,
): Promise<Record<FeatureKey, boolean>> {
  const next = await getFeatures();
  for (const k of FEATURE_KEYS) {
    if (typeof patch[k] === "boolean") next[k] = patch[k]!;
  }
  await setGlobalSetting(KEY, next);
  return next;
}

/** Express middleware — 403 when the given feature is disabled. */
export function requireFeature(key: FeatureKey) {
  return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    const f = await getFeatures();
    if (!f[key]) {
      res.status(403).json({ error: "This feature is currently unavailable.", featureDisabled: key });
      return;
    }
    next();
  };
}
