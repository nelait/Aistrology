// In-memory rate limiter and daily quota tracker.
// No external dependencies (Redis) — suitable for single-server deployments.
// Counters reset naturally on server restart (acceptable for daily quotas).

import { getUserPlan } from "./db";

// ─── Sliding-window rate limiter (per key, per window) ─────────────────────

interface RateBucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateBucket>();

// Cleanup stale entries every 5 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}, 5 * 60_000);

/**
 * Check if a request is within the rate limit.
 * @returns `{ allowed: true }` or `{ allowed: false, retryAfterMs }`.
 */
export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  if (b.count >= maxRequests) {
    return { allowed: false, retryAfterMs: b.resetAt - now };
  }
  b.count += 1;
  return { allowed: true };
}

// ─── Daily quota tracker (per user, per feature) ───────────────────────────

interface DailyCounter {
  count: number;
  day: string; // YYYY-MM-DD
}

const dailyCounters = new Map<string, DailyCounter>();

// Cleanup old day entries every 30 minutes.
setInterval(() => {
  const today = new Date().toISOString().slice(0, 10);
  for (const [key, c] of dailyCounters) {
    if (c.day !== today) dailyCounters.delete(key);
  }
}, 30 * 60_000);

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Increment and check a daily quota.
 * @returns `{ allowed: true, used, limit }` or `{ allowed: false, used, limit }`.
 */
export function checkDailyQuota(
  userId: string,
  feature: string,
  limit: number,
): { allowed: boolean; used: number; limit: number } {
  const key = `${userId}:${feature}`;
  const today = todayStr();
  let c = dailyCounters.get(key);
  if (!c || c.day !== today) {
    c = { count: 0, day: today };
    dailyCounters.set(key, c);
  }
  if (c.count >= limit) {
    return { allowed: false, used: c.count, limit };
  }
  c.count += 1;
  return { allowed: true, used: c.count, limit };
}

/** Read current usage without incrementing. */
export function getDailyUsage(userId: string, feature: string): number {
  const key = `${userId}:${feature}`;
  const today = todayStr();
  const c = dailyCounters.get(key);
  return c && c.day === today ? c.count : 0;
}

// ─── Plan-based quota limits ───────────────────────────────────────────────

export type PlanLimits = Record<string, Record<string, number>>;

/** Code defaults — the fallback and the "Reset to defaults" target. Admins can
 * override these in the DB (see server/quotas.ts + Admin → Plan Limits). */
export const DEFAULT_PLAN_DAILY_LIMITS: PlanLimits = {
  free:    { justify: 5,  translate: 3,  justify_stream: 5,  chart_create: 3, booking: 2, vastu: 1,  chat: 5,  feedback: 20 },
  pro:     { justify: 30, translate: 20, justify_stream: 30, chart_create: 10, booking: 5, vastu: 5,  chat: 50, feedback: 40 },
  premium: { justify: 100, translate: 60, justify_stream: 100, chart_create: 30, booking: 10, vastu: 15, chat: 200, feedback: 60 },
};

/** Plans and features exposed in the admin editor (order = display order). */
export const QUOTA_PLANS = ["free", "pro", "premium"] as const;
export const QUOTA_FEATURES: { key: string; label: string }[] = [
  { key: "chat", label: "Astro Chat" },
  { key: "justify", label: "Justify" },
  { key: "justify_stream", label: "Justify (streaming)" },
  { key: "translate", label: "Translate" },
  { key: "vastu", label: "Vastu analysis" },
  { key: "chart_create", label: "New charts / profiles" },
  { key: "booking", label: "Consultation bookings" },
  { key: "feedback", label: "Feature feedback" },
];

// The live limits used by every quota check. Starts at the code defaults and is
// replaced by setActivePlanLimits() once the DB overrides are loaded at boot and
// whenever an admin saves. Kept in-memory so getPlanDailyLimit stays synchronous.
let activeLimits: PlanLimits = DEFAULT_PLAN_DAILY_LIMITS;

export function setActivePlanLimits(limits: PlanLimits): void { activeLimits = limits; }
export function getActivePlanLimits(): PlanLimits { return activeLimits; }

/** Merge admin overrides over the code defaults → the effective limit table. */
export function mergePlanLimits(overrides: Partial<PlanLimits> | null | undefined): PlanLimits {
  const out: PlanLimits = {};
  for (const plan of QUOTA_PLANS) {
    out[plan] = { ...DEFAULT_PLAN_DAILY_LIMITS[plan], ...(overrides?.[plan] ?? {}) };
  }
  return out;
}

/** Get the daily limit for a user's plan and feature (from the live table). */
export function getPlanDailyLimit(plan: string, feature: string): number {
  return activeLimits[plan]?.[feature]
    ?? DEFAULT_PLAN_DAILY_LIMITS[plan]?.[feature]
    ?? DEFAULT_PLAN_DAILY_LIMITS.free[feature]
    ?? 5;
}

// ─── LLM response cache (dedup identical justify requests) ─────────────────

interface CacheEntry {
  response: unknown;
  createdAt: number;
}

const llmCache = new Map<string, CacheEntry>();
const LLM_CACHE_TTL = 24 * 60 * 60_000; // 24 hours
const LLM_CACHE_MAX = 10_000;

// Cleanup expired cache entries every 10 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [key, e] of llmCache) {
    if (now - e.createdAt > LLM_CACHE_TTL) llmCache.delete(key);
  }
}, 10 * 60_000);

/** Simple string hash for cache keys. */
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

export function llmCacheKey(userId: string, subject: string, basePrediction: string, language?: string): string {
  return simpleHash(`${userId}|${subject}|${basePrediction}|${language ?? "en"}`);
}

export function getLlmCached(key: string): unknown | undefined {
  const e = llmCache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.createdAt > LLM_CACHE_TTL) {
    llmCache.delete(key);
    return undefined;
  }
  return e.response;
}

export function setLlmCached(key: string, response: unknown): void {
  // Evict oldest if at capacity.
  if (llmCache.size >= LLM_CACHE_MAX) {
    const oldest = llmCache.keys().next().value;
    if (oldest !== undefined) llmCache.delete(oldest);
  }
  llmCache.set(key, { response, createdAt: Date.now() });
}

// ─── Lifetime chart counter ────────────────────────────────────────────────

export const PLAN_LIFETIME_CHART_LIMIT: Record<string, number> = {
  free: 1,
  pro: 5,
  premium: 30,
};

// ─── Admin usage stats (expose in-memory counters) ─────────────────────────

export function getUsageStats(): {
  rateBuckets: number;
  dailyCounters: number;
  llmCacheEntries: number;
  llmCacheMaxEntries: number;
  topDailyUsers: Array<{ userId: string; feature: string; count: number }>;
} {
  const today = todayStr();

  // Collect top daily users (sorted by count desc, top 20)
  const topUsers: Array<{ userId: string; feature: string; count: number }> = [];
  for (const [key, c] of dailyCounters) {
    if (c.day !== today) continue;
    const [userId, feature] = key.split(":");
    topUsers.push({ userId, feature, count: c.count });
  }
  topUsers.sort((a, b) => b.count - a.count);

  return {
    rateBuckets: buckets.size,
    dailyCounters: dailyCounters.size,
    llmCacheEntries: llmCache.size,
    llmCacheMaxEntries: LLM_CACHE_MAX,
    topDailyUsers: topUsers.slice(0, 20),
  };
}

/** Get all daily counters for a specific user (for drill-down). */
export function getUserDailyUsage(userId: string): Record<string, number> {
  const today = todayStr();
  const usage: Record<string, number> = {};
  for (const [key, c] of dailyCounters) {
    if (c.day !== today) continue;
    if (!key.startsWith(`${userId}:`)) continue;
    const feature = key.slice(userId.length + 1);
    usage[feature] = c.count;
  }
  return usage;
}
