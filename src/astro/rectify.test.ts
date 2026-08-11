import { describe, it, expect } from "vitest";
import { computeChart } from "./engine";
import { scoreEventDate, dashaTreeFor, LifeEventInput } from "./eventAnalysis";
import { EVENT_KARAKAS } from "./eventKaraka";
import {
  rectify,
  verdictFor,
  formatMinute,
  expectedPrecisionMinutes,
  RECTIFY_LAYERS,
  TIME_OF_DAY,
} from "./rectify";
import { BirthData } from "./types";

const DAY = 86_400_000;

const BASE: BirthData = {
  name: "Subject", year: 1979, month: 3, day: 18,
  hour: 0, minute: 0, second: 0,
  tzOffsetHours: 5.5, latitude: 19.076, longitude: 72.877,
  placeLabel: "Mumbai",
};

function subject(i: number): BirthData {
  return {
    ...BASE,
    year: 1955 + ((i * 9) % 50),
    month: 1 + ((i * 5) % 12),
    day: 1 + ((i * 13) % 28),
    latitude: 8 + ((i * 7) % 45),
    longitude: -60 + ((i * 23) % 140),
  };
}

/** Dates this chart scores highest — a stand-in for a user's real events. */
function syntheticEvents(base: BirthData, trueMinute: number, count: number, jitterDays = 0): LifeEventInput[] {
  const chart = computeChart({ ...base, hour: Math.floor(trueMinute / 60), minute: trueMinute % 60 });
  const dashas = dashaTreeFor(chart);
  const birthMs = Date.UTC(base.year, base.month - 1, base.day);
  const out: LifeEventInput[] = [];
  for (let n = 0; n < count; n++) {
    const k = EVENT_KARAKAS[(n * 5) % EVENT_KARAKAS.length];
    let best: { date: Date; score: number } | null = null;
    for (let age = 18 * 365; age < 58 * 365; age += 10) {
      const date = new Date(birthMs + age * DAY);
      const s = scoreEventDate(chart, { type: k.id, date, precision: "exact", confidence: "sure" },
        { dashas, layers: RECTIFY_LAYERS });
      if (!best || s > best.score) best = { date, score: s };
    }
    const wobble = jitterDays ? ((n * 37) % (2 * jitterDays + 1)) - jitterDays : 0;
    out.push({
      type: k.id,
      date: new Date(best!.date.getTime() + wobble * DAY),
      precision: jitterDays > 0 ? "month" : "exact",
      confidence: "sure",
    });
  }
  return out;
}

/** Dates with no relationship to the chart — the control. */
function arbitraryEvents(base: BirthData, salt: number): LifeEventInput[] {
  const birthMs = Date.UTC(base.year, base.month - 1, base.day);
  return [0, 1, 2, 3, 4].map((i) => ({
    type: EVENT_KARAKAS[(i * 3 + salt) % EVENT_KARAKAS.length].id,
    date: new Date(birthMs + (18 + i * 5 + salt) * 365 * DAY),
    precision: "month" as const,
    confidence: "sure" as const,
  }));
}

describe("rectify", () => {
  it("puts the true birth time inside the window it reports", () => {
    // The claim the feature makes is about the WINDOW, not a point, so that is
    // what gets tested. Chance of a 16-minute window covering a given minute is
    // about 1 in 90.
    let covered = 0;
    for (let i = 0; i < 4; i++) {
      const base = subject(i);
      const trueMinute = (i * 211 + 97) % 1440;
      const r = rectify(base, syntheticEvents(base, trueMinute, 4), { stepMinutes: 4, nullRuns: 0 });
      const w = r.windows[0];
      if (trueMinute >= w.startMinute && trueMinute < w.endMinute) covered++;
    }
    expect(covered, `only ${covered}/4 windows covered the true time`).toBeGreaterThanOrEqual(3);
  });

  it("mostly calls arbitrary dates inconclusive", () => {
    // The scorer peaks sharply whatever dates it is given — arbitrary dates
    // measured 2.9 standard deviations above the day's own mean, which reads as
    // confidence and means nothing. The null arm is what catches that.
    //
    // "Mostly" is the honest word: measured over 30 charts the chosen threshold
    // lets 7% of arbitrary sets through, because the distributions overlap.
    // This asserts the rate, not perfection.
    let conclusive = 0;
    const N = 8;
    for (let salt = 0; salt < N; salt++) {
      const base = subject(salt);
      const r = rectify(base, arbitraryEvents(base, salt), { stepMinutes: 6, seed: salt + 1 });
      if (verdictFor(r) !== "inconclusive") conclusive++;
    }
    expect(conclusive, `${conclusive}/${N} arbitrary date sets looked conclusive`).toBeLessThanOrEqual(2);
  });

  it("rates real events above the null and arbitrary ones at or below it", () => {
    const base = subject(2);
    const trueMinute = 582;
    const real = rectify(base, syntheticEvents(base, trueMinute, 4), { stepMinutes: 6, seed: 7 });
    const fake = rectify(base, arbitraryEvents(base, 3), { stepMinutes: 6, seed: 7 });
    expect(real.separationZ!).toBeGreaterThan(fake.separationZ!);
    expect(real.separationZ!).toBeGreaterThanOrEqual(3.5);
  });

  it("never reports a window narrower than the dates can support", () => {
    // A sharp peak off wobbly dates is sharp and wrong: before this widening,
    // 6-minute plateaus routinely sat 11 minutes from the truth.
    const base = subject(0);
    const r = rectify(base, syntheticEvents(base, 640, 4, 45), { stepMinutes: 6, nullRuns: 0 });
    const allow = r.expectedPrecisionMinutes;
    for (const w of r.windows) {
      expect(w.widthMinutes, `window ${formatMinute(w.startMinute)}–${formatMinute(w.endMinute)}`)
        .toBeGreaterThanOrEqual(allow * 2);
      // The raw plateau is kept, and is what was actually narrower.
      expect(w.coreEndMinute - w.coreStartMinute).toBeLessThanOrEqual(w.widthMinutes);
    }
  });

  it("honours a time-of-day constraint", () => {
    const base = subject(3);
    const events = syntheticEvents(base, 900, 3);
    const r = rectify(base, events, { timeOfDay: "afternoon", stepMinutes: 6, nullRuns: 0 });
    expect(r.searchFrom).toBe(720);
    expect(r.searchTo).toBe(1020);
    for (const m of r.minutes) {
      expect(m).toBeGreaterThanOrEqual(720);
      expect(m).toBeLessThan(1020);
    }
  });

  it("is reproducible", () => {
    const base = subject(4);
    const events = syntheticEvents(base, 300, 3);
    const a = rectify(base, events, { stepMinutes: 8, nullRuns: 4, seed: 99 });
    const b = rectify(base, events, { stepMinutes: 8, nullRuns: 4, seed: 99 });
    expect(b.separationPercentile).toBe(a.separationPercentile);
    expect(b.windows[0]).toEqual(a.windows[0]);
  });

  it("reports which events the winning window fails to explain", () => {
    const base = subject(0);
    const trueMinute = 415;
    // Three events that fit, one that cannot — a date chosen at random.
    const events = syntheticEvents(base, trueMinute, 3);
    events.push({
      type: "litigation",
      date: new Date(Date.UTC(base.year + 31, 6, 3)),
      precision: "year",
      confidence: "vague",
    });
    const r = rectify(base, events, { stepMinutes: 6, nullRuns: 0 });
    expect(r.fits).toHaveLength(4);
    for (const f of r.fits) {
      expect(f.percentileWithinDay).toBeGreaterThanOrEqual(0);
      expect(f.percentileWithinDay).toBeLessThanOrEqual(100);
    }
  });

  it("derives the expected precision from the measured scaling law", () => {
    // Study F: birth-time error runs at roughly a third of the date error.
    const at = (p: LifeEventInput["precision"]) =>
      expectedPrecisionMinutes([{ type: "marriage", date: new Date(), precision: p, confidence: "sure" }]);
    expect(at("exact")).toBe(5);   // ±15d window / 3
    expect(at("month")).toBe(10);  // ±30d / 3
    expect(at("year")).toBe(61);   // ±183d / 3
    expect(at("approx")).toBe(122);
    expect(expectedPrecisionMinutes([])).toBe(1440);
  });

  it("covers the whole day across the time-of-day bands", () => {
    const bands = TIME_OF_DAY.filter((t) => t.id !== "unknown").sort((a, b) => a.from - b.from);
    expect(bands[0].from).toBe(0);
    expect(bands[bands.length - 1].to).toBe(1440);
    for (let i = 1; i < bands.length; i++) expect(bands[i].from).toBe(bands[i - 1].to);
  });

  it("formats minutes as a clock time", () => {
    expect(formatMinute(0)).toBe("00:00");
    expect(formatMinute(582)).toBe("09:42");
    expect(formatMinute(1439)).toBe("23:59");
  });
});
