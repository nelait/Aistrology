import { describe, it, expect } from "vitest";
import { computeChart } from "./engine";
import { detectYogas } from "./yogas";
import { scoreEventDate, dashaTreeFor, LifeEventInput, LayerSwitches } from "./eventAnalysis";
import { EVENT_KARAKAS } from "./eventKaraka";
import { BirthData } from "./types";

/**
 * Identifiability — can a scan over candidate birth times find its way back to
 * a known one? This is the foundation birth-time rectification (Phase D) will
 * stand on, so it is worth a regression test before that is built.
 *
 * It is circular by construction: the synthetic events are dates this model
 * calls strongly indicated, and the same model then recovers them. That makes
 * it a test of whether the scoring carries birth-time INFORMATION, and not of
 * whether the astrology is true. Nothing in this repository can test the
 * latter — see docs/rectification-and-event-analysis.md, Part 5.
 *
 * The full study lives in scripts/ablation.ts (`npm run ablation`); this is the
 * small, fast slice of it that runs in CI.
 */

const DAY_MS = 86_400_000;

const BASE: BirthData = {
  name: "Subject", year: 1985, month: 6, day: 12,
  hour: 0, minute: 0, second: 0,
  tzOffsetHours: 5.5, latitude: 17.385, longitude: 78.4867,
  placeLabel: "Hyderabad",
};

/** Rectification uses these two layers only — the other three were measured to
 *  add nothing to recovery while flattening the curve. See the ablation doc. */
const RECTIFICATION_LAYERS: LayerSwitches = { transit: false, varga: false, yoga: false };

function chartAt(base: BirthData, minute: number) {
  return computeChart({ ...base, hour: Math.floor(minute / 60), minute: minute % 60, second: 0 });
}

/** Dates this chart scores highest for a few event types — a stand-in user. */
function syntheticEvents(base: BirthData, trueMinute: number, count: number, jitterDays: number): LifeEventInput[] {
  const chart = chartAt(base, trueMinute);
  const dashas = dashaTreeFor(chart);
  const yogas = detectYogas(chart);
  const birth = Date.UTC(base.year, base.month - 1, base.day);
  const out: LifeEventInput[] = [];
  for (let n = 0; n < count; n++) {
    const k = EVENT_KARAKAS[(n * 5) % EVENT_KARAKAS.length];
    let best: { date: Date; score: number } | null = null;
    for (let age = 18 * 365; age < 60 * 365; age += 10) {
      const date = new Date(birth + age * DAY_MS);
      const s = scoreEventDate(chart, { type: k.id, date, precision: "exact", confidence: "sure" }, { dashas, yogas });
      if (!best || s > best.score) best = { date, score: s };
    }
    const wobble = jitterDays ? ((n * 37) % (2 * jitterDays + 1)) - jitterDays : 0;
    out.push({
      type: k.id,
      date: new Date(best!.date.getTime() + wobble * DAY_MS),
      precision: jitterDays > 0 ? "month" : "exact",
      confidence: "sure",
    });
  }
  return out;
}

/** Scan the day and return the middle of the winning plateau, plus its width. */
function scan(base: BirthData, events: LifeEventInput[], step: number, layers?: LayerSwitches) {
  const scores: number[] = [];
  for (let m = 0; m < 1440; m += step) {
    const chart = chartAt(base, m);
    const dashas = dashaTreeFor(chart);
    const yogas = detectYogas(chart);
    let total = 0;
    for (const e of events) total += scoreEventDate(chart, e, { dashas, yogas, layers });
    scores.push(total);
  }
  const top = Math.max(...scores);
  const winners: number[] = [];
  for (let i = 0; i < scores.length; i++) if (scores[i] >= top - 1e-9) winners.push(i * step);
  return { estimate: winners[Math.floor(winners.length / 2)], plateau: winners.length * step };
}

function circularError(a: number, b: number): number {
  const raw = Math.abs(a - b);
  return Math.min(raw, 1440 - raw);
}

const median = (x: number[]) => [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)];

/**
 * Median recovery error over several subjects. Single subjects are far too
 * noisy to assert on — the script's ±90d row has a 31-minute median but a tail
 * that runs to hundreds, so one unlucky chart proves nothing either way.
 */
function medianRecoveryError(
  subjects: number, events: number, jitterDays: number, layers?: LayerSwitches, step = 12,
): number {
  const errs: number[] = [];
  for (let i = 0; i < subjects; i++) {
    const base = subject(i);
    const trueMinute = (i * 97) % 1440;
    const { estimate } = scan(base, syntheticEvents(base, trueMinute, events, jitterDays), step, layers);
    errs.push(circularError(estimate, trueMinute));
  }
  return median(errs);
}

function subject(i: number): BirthData {
  return {
    ...BASE,
    year: 1950 + ((i * 11) % 55),
    month: 1 + ((i * 5) % 12),
    day: 1 + ((i * 13) % 28),
    latitude: 8 + ((i * 7) % 45),
    longitude: -80 + ((i * 23) % 160),
  };
}

describe("birth-time identifiability", () => {
  it("recovers a known birth time from exactly dated events", () => {
    const errors: number[] = [];
    for (let i = 0; i < 4; i++) {
      const base = subject(i);
      const trueMinute = (i * 97) % 1440;
      const events = syntheticEvents(base, trueMinute, 4, 0);
      const { estimate } = scan(base, events, 8, RECTIFICATION_LAYERS);
      errors.push(circularError(estimate, trueMinute));
    }
    // Chance on a 24-hour window is a 360-minute mean error. Anything near that
    // means the scoring carries no birth-time information at all.
    const worst = Math.max(...errors);
    expect(worst, `worst recovery error was ${worst} minutes`).toBeLessThan(60);
  });

  it("degrades with date accuracy rather than failing outright", () => {
    // The measured scaling is roughly birth-time error ≈ date error ÷ 3, which
    // follows from the drift table: every dasha boundary moves 1.35–4.5 days
    // per minute of birth time. A user a month out on their dates cannot be
    // given a ten-minute answer, and the UI must not imply otherwise.
    const exact = medianRecoveryError(5, 4, 0, RECTIFICATION_LAYERS);
    const noisy = medianRecoveryError(5, 4, 30, RECTIFICATION_LAYERS);
    expect(exact, `exact-date median error was ${exact}m`).toBeLessThan(30);
    expect(noisy, `±30d median error was ${noisy}m`).toBeLessThan(150);
    // Degradation is the point — if noise changed nothing, the dates would not
    // be what the scan is reading.
    expect(noisy).toBeGreaterThanOrEqual(exact);
  });

  it("the layers rectification drops do not carry birth-time information", () => {
    // Measured across 30 subjects in scripts/ablation.ts: transit alone lands
    // 61 minutes out with a 128-minute plateau, varga 284m/84m and yoga
    // 486m/340m — at or worse than the 360-minute chance level, on a curve so
    // flat that the plateau is the answer. Dropping them costs nothing and
    // avoids feeding that flatness into the sum.
    const rectOnly = medianRecoveryError(5, 4, 0, RECTIFICATION_LAYERS);
    const everything = medianRecoveryError(5, 4, 0);
    expect(rectOnly, "dropping three layers should not cost recovery")
      .toBeLessThanOrEqual(everything + 12);

    const yogaOnly = medianRecoveryError(
      5, 4, 0, { dasha: false, boundary: false, transit: false, varga: false },
    );
    expect(yogaOnly, `yoga alone recovered to ${yogaOnly}m — it should be far worse than ${rectOnly}m`)
      .toBeGreaterThan(rectOnly + 60);
  });
});
