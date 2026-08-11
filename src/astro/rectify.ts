// Birth-time rectification — Phase D of docs/rectification-and-event-analysis.md.
//
// Given a birth date, a place and a set of dated life events, score every
// candidate minute of the day and report the windows that fit best.
//
// Three things this deliberately does NOT do, each of them measured rather than
// assumed (see Part 3b of the doc):
//
//   * It does not return a time. It returns windows, with their widths. The
//     winning plateau IS the answer; collapsing it to a midpoint would invent
//     precision the evidence does not carry.
//   * It does not use the transit, varga or yoga layers. Ablation showed they
//     add nothing to recovery while flattening the curve — varga alone lands
//     219 minutes out, yoga alone 487, against a 360-minute chance level.
//   * It does not claim better precision than the dates support. Measured, the
//     birth-time error runs at roughly a third of the date error, so
//     month-precision dates cannot yield a ten-minute answer and the result
//     says so.

import { BirthData } from "./types";
import { computeChart } from "./engine";
import {
  scoreEventDate,
  dashaTreeFor,
  LifeEventInput,
  LayerSwitches,
} from "./eventAnalysis";
import { CONFIDENCE_WEIGHT, PRECISION_WINDOW_DAYS } from "./eventKaraka";

/** The two layers ablation showed carry birth-time information. */
export const RECTIFY_LAYERS: LayerSwitches = { transit: false, varga: false, yoga: false };

/** Coarse parts of the day a user can usually remember even when the clock is lost. */
export type TimeOfDay = "unknown" | "earlyMorning" | "morning" | "afternoon" | "evening" | "night";

export const TIME_OF_DAY: { id: TimeOfDay; label: string; from: number; to: number }[] = [
  { id: "unknown", label: "I have no idea", from: 0, to: 1440 },
  { id: "earlyMorning", label: "Before dawn (midnight–6am)", from: 0, to: 360 },
  { id: "morning", label: "Morning (6am–noon)", from: 360, to: 720 },
  { id: "afternoon", label: "Afternoon (noon–5pm)", from: 720, to: 1020 },
  { id: "evening", label: "Evening (5pm–9pm)", from: 1020, to: 1260 },
  { id: "night", label: "Night (9pm–midnight)", from: 1260, to: 1440 },
];

export interface RectifyWindow {
  /** Minutes from local midnight — the window to SHOW, already widened to the
   *  precision the dates can actually support. */
  startMinute: number;
  endMinute: number;
  widthMinutes: number;
  /** The raw scoring plateau, before that widening. Narrower, and on its own
   *  it would overstate the result: measured against known birth times, a
   *  6-minute plateau routinely sat 11 minutes from the truth. */
  coreStartMinute: number;
  coreEndMinute: number;
  /** 0..100, relative to the best-scoring minute of the day. */
  relativeScore: number;
}

export interface EventFit {
  event: LifeEventInput;
  /** Score at the winning window's midpoint. */
  score: number;
  /** Where that sits against this event's scores across the whole search — a
   *  low figure means the winning window does NOT explain this event. */
  percentileWithinDay: number;
  agrees: boolean;
}

export interface RectifyResult {
  /** Score per candidate, for the heatmap. Parallel to `minutes`. */
  minutes: number[];
  scores: number[];
  /** Best windows, widest-first within the top band. */
  windows: RectifyWindow[];
  /** Total width of everything in the top band — the honest resolution. */
  resolutionMinutes: number;
  /** How far the peak stands out from the day's own spread, in standard
   *  deviations. Near zero means the events said nothing about the time. */
  separation: number;
  /**
   * Where that separation sits against the same scan run on unrelated dates —
   * the null arm, and the only figure here that distinguishes signal from the
   * scorer's natural spikiness. A peak standing 3 sd above the day's mean
   * sounds impressive until you find that shuffled dates do it too.
   * 0..100, or null if the null arm was disabled. Readable, but NOT what the
   * verdict is based on — a percentile over N runs moves with N, and switching
   * from 6 null runs to 20 pushed the false-positive rate from 20% to 36%.
   */
  separationPercentile: number | null;
  /**
   * The observed separation in standard deviations of the null distribution.
   * This is the statistic the verdict uses: it does not drift with the number
   * of null runs, and it is what actually tells signal from the scorer's
   * natural spikiness.
   */
  separationZ: number | null;
  /** What the date precision alone allows, from the measured scaling law. */
  expectedPrecisionMinutes: number;
  /** Per-event agreement at the winning window. */
  fits: EventFit[];
  searchFrom: number;
  searchTo: number;
  stepMinutes: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * What precision the dates themselves allow, before any astrology.
 *
 * Measured in scripts/ablation.ts (study F): ±7d dates recovered to 3 minutes,
 * ±20d to 7, ±45d to 16, ±90d to 31 — birth-time error running at roughly a
 * third of the date error. The median event decides, since study E showed extra
 * events do not compensate for worse dates.
 */
export function expectedPrecisionMinutes(events: LifeEventInput[]): number {
  if (!events.length) return 1440;
  const per = events
    .map((e) => PRECISION_WINDOW_DAYS[e.precision] / 3)
    .sort((a, b) => a - b);
  return Math.round(per[Math.floor(per.length / 2)]);
}

/** Every event's score at one candidate minute — one chart, one dasha tree. */
function scoresAt(birth: BirthData, minute: number, events: LifeEventInput[]): number[] {
  const chart = computeChart({
    ...birth,
    hour: Math.floor(minute / 60),
    minute: minute % 60,
    second: 0,
  });
  const dashas = dashaTreeFor(chart);
  return events.map((e) => scoreEventDate(chart, e, { dashas, layers: RECTIFY_LAYERS }));
}

export interface RectifyOptions {
  timeOfDay?: TimeOfDay;
  /** Explicit search bounds in minutes from midnight; overrides timeOfDay. */
  fromMinute?: number;
  toMinute?: number;
  /** Scan resolution. 1 is exhaustive; 2 halves the cost with no practical loss
   *  given the precision the dates allow. */
  stepMinutes?: number;
  /** How far below the peak still counts as "in the running", as a fraction of
   *  the peak-to-mean gap. Wider means a more conservative, wider window. */
  tolerance?: number;
  /** Scans against randomised dates, for the confidence null. 0 disables it. */
  nullRuns?: number;
  /** Seed for the null arm, so a run is reproducible. */
  seed?: number;
}

/** Deterministic PRNG — the null arm has to give the same answer twice. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Peak-to-mean separation of a scan, in standard deviations. */
function separationOf(scores: number[]): number {
  const peak = Math.max(...scores);
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  const sd = Math.sqrt(scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length);
  return sd > 1e-9 ? (peak - mean) / sd : 0;
}

/**
 * The scan as a generator, yielding progress 0..1 as it goes.
 *
 * A full day at the default step is a few thousand chart computations, which in
 * a browser is seconds, not the half-second it measures in Node — long enough
 * that running it straight through freezes the page. The UI drives this in
 * chunks instead. `rectify()` below runs it to completion for tests and scripts.
 */
export function* rectifySteps(
  birth: BirthData,
  events: LifeEventInput[],
  options: RectifyOptions = {},
): Generator<number, RectifyResult, void> {
  const band = TIME_OF_DAY.find((t) => t.id === (options.timeOfDay ?? "unknown"))!;
  const from = clamp(options.fromMinute ?? band.from, 0, 1439);
  const to = clamp(options.toMinute ?? band.to, from + 1, 1440);
  // 3 minutes, not 1: the dates never justify better than about ±5 minutes
  // (see expectedPrecisionMinutes), so a finer grid buys nothing but seconds.
  const step = Math.max(1, options.stepMinutes ?? 3);

  // One pass keeps every event's score at every candidate, so the per-event
  // agreement below is free rather than a second sweep of the day per event.
  const minutes: number[] = [];
  const scores: number[] = [];
  const perEvent: number[][] = events.map(() => []);
  const mainSteps = Math.ceil((to - from) / step);
  let done = 0;
  for (let m = from; m < to; m += step) {
    minutes.push(m);
    const each = scoresAt(birth, m, events);
    let total = 0;
    for (let i = 0; i < events.length; i++) {
      perEvent[i].push(each[i]);
      total += each[i] * CONFIDENCE_WEIGHT[events[i].confidence];
    }
    scores.push(total);
    // The main scan is roughly half the work; the null arm is the other half.
    if (++done % 8 === 0) yield (done / mainSteps) * 0.5;
  }

  const peak = Math.max(...scores);
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  const separation = separationOf(scores);

  // ── The null arm ────────────────────────────────────────────────────────
  // The scorer is spiky by nature, so *any* set of dates produces a peak that
  // stands well clear of the day's mean — arbitrary dates measured at 2.9 sd,
  // which reads as high confidence and means nothing. The question is whether
  // THESE dates do better than unrelated ones, so run the same scan on dates
  // scattered across the life and see where the real separation falls.
  const nullRuns = options.nullRuns ?? 8;
  let separationPercentile: number | null = null;
  let separationZ: number | null = null;
  if (nullRuns > 0 && events.length > 0) {
    const rnd = mulberry32(options.seed ?? 12345);
    const birthMs = Date.UTC(birth.year, birth.month - 1, birth.day);
    const span = Math.max(...events.map((e) => e.date.getTime())) - birthMs;
    const nullStep = step * 2; // coarser: only the shape of the peak matters
    const seps: number[] = [];
    for (let run = 0; run < nullRuns; run++) {
      const shuffled = events.map((e) => ({
        ...e,
        date: new Date(birthMs + rnd() * Math.max(span, 365 * 86_400_000)),
      }));
      const nullScores: number[] = [];
      // Yield inside the run, not just between runs. One null run is a whole
      // scan of the day; yielding only at the end of each left a one-second
      // block on the main thread, measured in the browser.
      let nDone = 0;
      const nSteps = Math.ceil((to - from) / nullStep);
      for (let m = from; m < to; m += nullStep) {
        const each = scoresAt(birth, m, shuffled);
        let t = 0;
        for (let i = 0; i < shuffled.length; i++) t += each[i] * CONFIDENCE_WEIGHT[shuffled[i].confidence];
        nullScores.push(t);
        if (++nDone % 8 === 0) {
          yield 0.5 + ((run + nDone / nSteps) / nullRuns) * 0.5;
        }
      }
      seps.push(separationOf(nullScores));
      yield 0.5 + ((run + 1) / nullRuns) * 0.5;
    }
    const below = seps.filter((v) => v < separation).length;
    separationPercentile = Math.round((below / seps.length) * 100);
    const nMean = seps.reduce((a, v) => a + v, 0) / seps.length;
    const nSd = Math.sqrt(seps.reduce((a, v) => a + (v - nMean) ** 2, 0) / seps.length);
    separationZ = nSd > 1e-6 ? (separation - nMean) / nSd : separation > nMean ? 99 : 0;
  }

  // Everything within `tolerance` of the way from the mean up to the peak stays
  // in the running. Taking only the exact argmax would report a 2-minute answer
  // off a curve that is flat for an hour.
  const tol = options.tolerance ?? 0.15;
  const cutoff = peak - (peak - mean) * tol;

  const windows: RectifyWindow[] = [];
  let runStart: number | null = null;
  for (let i = 0; i < scores.length; i++) {
    const inBand = scores[i] >= cutoff;
    if (inBand && runStart === null) runStart = minutes[i];
    if ((!inBand || i === scores.length - 1) && runStart !== null) {
      const end = inBand ? minutes[i] + step : minutes[i - 1] + step;
      const mid = Math.floor((runStart + end) / 2);
      const nearest = minutes.reduce((b, m) => (Math.abs(m - mid) < Math.abs(b - mid) ? m : b), minutes[0]);
      // Widen the plateau to the precision the dates can actually support. The
      // curve knows nothing about how well the user remembers a date, so a
      // sharp peak off wobbly dates is sharp and wrong — measured against known
      // birth times, 6-minute plateaus sat 11 minutes from the truth.
      const allow = expectedPrecisionMinutes(events);
      // 1.5x, not 1x: `allow` is a MEDIAN error, so half of cases exceed it,
      // and a window that only covers half the time is not a window.
      const halfWidth = Math.max(Math.ceil((end - runStart) / 2), Math.ceil(allow * 1.5));
      const shownStart = clamp(mid - halfWidth, 0, 1440);
      const shownEnd = clamp(mid + halfWidth, 0, 1440);
      windows.push({
        startMinute: shownStart,
        endMinute: shownEnd,
        widthMinutes: shownEnd - shownStart,
        coreStartMinute: runStart,
        coreEndMinute: end,
        relativeScore: peak > 0 ? Math.round((scores[minutes.indexOf(nearest)] / peak) * 100) : 0,
      });
      runStart = null;
    }
  }
  windows.sort((a, b) => b.relativeScore - a.relativeScore || a.widthMinutes - b.widthMinutes);

  const resolutionMinutes = windows.reduce((s, w) => s + w.widthMinutes, 0);

  // Per-event agreement at the best window's midpoint, read straight out of the
  // matrix. An event the winning window fails to explain is information the
  // user should see, not something to bury.
  const best = windows[0];
  const bestMinute = best ? Math.floor((best.startMinute + best.endMinute) / 2) : minutes[0];
  const bestIdx = minutes.reduce(
    (b, m, i) => (Math.abs(m - bestMinute) < Math.abs(minutes[b] - bestMinute) ? i : b), 0);

  const fits: EventFit[] = events.map((e, i) => {
    const series = perEvent[i];
    const score = series[bestIdx];
    const below = series.filter((s) => s < score).length;
    const ties = series.filter((s) => s === score).length;
    // Mid-rank, for the same reason the null arm in eventAnalysis uses it:
    // scoring is coarse and long stretches of the day score identically.
    const percentileWithinDay = Math.round(((below + ties / 2) / series.length) * 100);
    return { event: e, score, percentileWithinDay, agrees: percentileWithinDay >= 60 };
  });

  return {
    minutes,
    scores,
    windows,
    resolutionMinutes,
    separation,
    separationPercentile,
    separationZ,
    expectedPrecisionMinutes: expectedPrecisionMinutes(events),
    fits,
    searchFrom: from,
    searchTo: to,
    stepMinutes: step,
  };
}

/** Run the scan straight through. Fine off the main thread or in a script. */
export function rectify(
  birth: BirthData,
  events: LifeEventInput[],
  options: RectifyOptions = {},
): RectifyResult {
  const it = rectifySteps(birth, events, options);
  let step = it.next();
  while (!step.done) step = it.next();
  return step.value;
}

/** hh:mm from minutes-since-midnight. */
export function formatMinute(m: number): string {
  const h = Math.floor(m / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * How much the result should be trusted, in words rather than a number.
 *
 * Separation is how far the peak stands out from the day's own spread. A flat
 * curve means the events carried no information about the time, and saying so
 * is the whole point — a rectifier that always sounds confident is useless.
 */
export type RectifyVerdict = "narrow" | "indicative" | "weak" | "inconclusive";

export function verdictFor(r: RectifyResult): RectifyVerdict {
  // The null arm decides first. Raw separation cannot: the scorer peaks
  // sharply whatever dates it is given, so a confident-looking curve off
  // unrelated dates is the normal case, not the exception.
  // Judged in standard deviations of the null distribution, not by rank. A
  // percentile threshold looked fine at six null runs and fell apart at twenty:
  // the false-positive rate on arbitrary dates went 20% → 36% purely because
  // finer rank granularity let more sets clear the bar. The z-score does not
  // drift that way.
  //
  // The threshold is deliberately conservative. Measured over 30 charts, with
  // arbitrary dates as the control and model-optimal dates as the signal:
  //
  //     z ≥ 2.0   20% false positives, 97% true
  //     z ≥ 3.0   10% false positives, 87% true
  //     z ≥ 3.5    7% false positives, 77% true   ← chosen
  //     z ≥ 4.0    3% false positives, 70% true
  //
  // The distributions genuinely overlap — arbitrary dates reached z = 4.29 at
  // worst, real events fell to 1.92 at best — so no threshold separates them
  // cleanly. Telling someone their birth time was found in noise is a worse
  // failure than telling them to add more events, and "inconclusive" is an
  // honest, actionable answer rather than a dead end. Note too that the signal
  // arm here is the easiest possible case, so the real-world true-positive rate
  // will be lower than 77%.
  if (r.separationZ !== null && r.separationZ < 3.5) return "inconclusive";
  if (r.separation < 1 || r.resolutionMinutes > 600) return "inconclusive";
  if (r.resolutionMinutes > 240) return "weak";
  if (r.resolutionMinutes > 90) return "indicative";
  return "narrow";
}
