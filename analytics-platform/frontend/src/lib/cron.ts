/**
 * 5-field cron helpers for the Schedules page. Mirrors backend/app/jobs/cron.py (`minute hour day-of-month
 * month day-of-week`; `*`, numbers, ranges, lists, steps, `jan`–`dec`, `sun`–`sat`, day-of-week 0–7).
 * The server stays authoritative (it also enforces the minimum interval and computes the next runs).
 */

export const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Server default for AP_SCHEDULE_MIN_INTERVAL_MINUTES. */
export const MIN_INTERVAL_MINUTES = 5;

interface FieldSpec {
  name: string;
  lo: number;
  hi: number;
  names?: string[];
  /** index offset of names[0] */
  nameBase?: number;
}

const FIELDS: FieldSpec[] = [
  { name: "minute", lo: 0, hi: 59 },
  { name: "hour", lo: 0, hi: 23 },
  { name: "day of month", lo: 1, hi: 31 },
  { name: "month", lo: 1, hi: 12, names: MONTH_NAMES, nameBase: 1 },
  { name: "day of week", lo: 0, hi: 7, names: DAY_NAMES, nameBase: 0 },
];

export interface CronParse {
  ok: boolean;
  error?: string;
  /** allowed values per field (day of week normalized to 0–6) */
  values?: number[][];
}

function value(token: string, f: FieldSpec): number {
  const t = token.trim().toLowerCase();
  if (f.names) {
    const i = f.names.indexOf(t);
    if (i >= 0) return i + (f.nameBase ?? 0);
  }
  if (!/^\d+$/.test(t)) throw new Error(`invalid value “${token}” in ${f.name}`);
  const v = Number(t);
  if (v < f.lo || v > f.hi) throw new Error(`${f.name} value ${v} is out of range ${f.lo}–${f.hi}`);
  return v;
}

function field(text: string, f: FieldSpec): number[] {
  if (!text) throw new Error(`empty ${f.name}`);
  const out = new Set<number>();
  for (const raw of text.split(",")) {
    let part = raw;
    let step = 1;
    if (part.includes("/")) {
      const [p, s] = part.split("/", 2);
      if (!/^\d+$/.test(s) || Number(s) < 1) throw new Error(`invalid step “${s}” in ${f.name}`);
      part = p;
      step = Number(s);
    }
    let start: number;
    let end: number;
    if (part === "*") {
      start = f.lo;
      end = f.hi;
    } else if (part.includes("-")) {
      const [a, b] = part.split("-", 2);
      start = value(a, f);
      end = value(b, f);
      if (start > end) throw new Error(`invalid range “${part}” in ${f.name}`);
    } else {
      start = value(part, f);
      end = step > 1 ? f.hi : start;
    }
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** Parse and validate a cron expression (syntax and ranges only). */
export function parseCron(expr: string): CronParse {
  const parts = expr.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return { ok: false, error: `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}` };
  try {
    const values = parts.map((p, i) => field(p, FIELDS[i]));
    values[4] = [...new Set(values[4].map((d) => d % 7))].sort((a, b) => a - b);
    return { ok: true, values };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Smallest gap in minutes between two runs on the same day (Infinity for one run per day). */
export function minGapMinutes(expr: string): number {
  const p = parseCron(expr);
  if (!p.ok || !p.values) return Infinity;
  const [minutes, hours] = p.values;
  const times = hours.flatMap((h) => minutes.map((m) => h * 60 + m)).sort((a, b) => a - b);
  let gap = Infinity;
  for (let i = 1; i < times.length; i++) gap = Math.min(gap, times[i] - times[i - 1]);
  return gap;
}

/** Validation message for the form, or null when the expression looks fine. */
export function validateCron(expr: string, minInterval = MIN_INTERVAL_MINUTES): string | null {
  if (!expr.trim()) return "Enter a cron expression";
  const p = parseCron(expr);
  if (!p.ok) return p.error ?? "Invalid cron expression";
  if (minGapMinutes(expr) < minInterval) return `Runs must be at least ${minInterval} minutes apart`;
  return null;
}

// -- Builder --------------------------------------------------------------------------------------

export type Frequency = "hourly" | "daily" | "weekdays" | "weekly" | "monthly";

export interface CronBuilder {
  frequency: Frequency;
  minute: number;
  hour: number;
  /** 0 = Sunday (weekly) */
  weekdays: number[];
  /** 1–31 (monthly) */
  day: number;
}

export const DEFAULT_BUILDER: CronBuilder = { frequency: "daily", minute: 0, hour: 9, weekdays: [1], day: 1 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : lo)));

export function buildCron(b: CronBuilder): string {
  const m = clamp(b.minute, 0, 59);
  const h = clamp(b.hour, 0, 23);
  switch (b.frequency) {
    case "hourly":
      return `${m} * * * *`;
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly": {
      const days = [...new Set(b.weekdays.map((d) => clamp(d, 0, 6)))].sort((x, y) => x - y);
      return `${m} ${h} * * ${days.length ? days.join(",") : "1"}`;
    }
    case "monthly":
      return `${m} ${h} ${clamp(b.day, 1, 31)} * *`;
  }
}

/** Recognize expressions the builder can represent (else null → raw mode). */
export function parseBuilder(expr: string): CronBuilder | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 || !parseCron(expr).ok) return null;
  const [mi, ho, dom, mon, dow] = parts;
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);
  const minute = num(mi);
  if (minute === null || mon !== "*") return null;
  if (ho === "*" && dom === "*" && dow === "*") return { ...DEFAULT_BUILDER, frequency: "hourly", minute };
  const hour = num(ho);
  if (hour === null) return null;
  if (dom === "*" && dow === "*") return { ...DEFAULT_BUILDER, frequency: "daily", minute, hour };
  if (dom === "*" && dow === "1-5") return { ...DEFAULT_BUILDER, frequency: "weekdays", minute, hour };
  if (dom === "*" && /^\d(,\d)*$/.test(dow)) return { ...DEFAULT_BUILDER, frequency: "weekly", minute, hour, weekdays: dow.split(",").map((d) => Number(d) % 7) };
  const day = num(dom);
  if (day !== null && dow === "*") return { ...DEFAULT_BUILDER, frequency: "monthly", minute, hour, day };
  return null;
}

export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 09:00", cron: "0 9 * * *" },
  { label: "Weekdays at 08:00", cron: "0 8 * * 1-5" },
  { label: "Mondays at 09:00", cron: "0 9 * * 1" },
  { label: "First of the month at 06:00", cron: "0 6 1 * *" },
];

const pad = (n: number) => String(n).padStart(2, "0");

/** Plain-language summary of common shapes; falls back to the expression itself. */
export function describeCron(expr: string): string {
  const preset = CRON_PRESETS.find((p) => p.cron === expr.trim().split(/\s+/).join(" "));
  if (preset) return preset.label;
  const b = parseBuilder(expr);
  if (!b) {
    const step = /^\*\/(\d+) \* \* \* \*$/.exec(expr.trim().split(/\s+/).join(" "));
    return step ? `Every ${step[1]} minutes` : `Cron “${expr.trim()}”`;
  }
  const at = `${pad(b.hour)}:${pad(b.minute)}`;
  switch (b.frequency) {
    case "hourly":
      return `Every hour at minute ${b.minute}`;
    case "daily":
      return `Every day at ${at}`;
    case "weekdays":
      return `Weekdays at ${at}`;
    case "weekly":
      return `Every ${b.weekdays.map((d) => DAY_LABELS[d]).join(", ")} at ${at}`;
    case "monthly":
      return `Day ${b.day} of every month at ${at}`;
  }
}

// -- Time zones --------------------------------------------------------------------------------

export const COMMON_TIMEZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/** Every IANA zone the browser knows (falls back to a short list), with UTC first. */
export function listTimezones(): string[] {
  let zones: string[] = [];
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    zones = intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  const all = new Set(["UTC", ...COMMON_TIMEZONES, ...zones]);
  return ["UTC", ...[...all].filter((z) => z !== "UTC").sort()];
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Format an ISO instant in a zone (for the "next runs" preview). */
export function formatInZone(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(d);
  } catch {
    return d.toISOString();
  }
}
