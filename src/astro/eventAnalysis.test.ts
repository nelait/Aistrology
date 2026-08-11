import { describe, it, expect } from "vitest";
import { computeChart } from "./engine";
import { analyseEvent, analyseEvents, dashaTreeFor, scoreEventDate } from "./eventAnalysis";
import { EVENT_KARAKAS, EVENT_KARAKA_BY_ID, PRECISION_WINDOW_DAYS } from "./eventKaraka";
import { VARGAS } from "./varga";
import { GRAHAS } from "./constants";
import { BirthData } from "./types";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BIRTH: BirthData = {
  name: "Test",
  year: 1985, month: 6, day: 12,
  hour: 10, minute: 30, second: 0,
  tzOffsetHours: 5.5,
  latitude: 17.385, longitude: 78.4867,
  placeLabel: "Hyderabad",
};

const chart = computeChart(BIRTH);

function chartFor(i: number) {
  return computeChart({
    ...BIRTH,
    year: 1950 + ((i * 7) % 55),
    month: 1 + ((i * 3) % 12),
    day: 1 + ((i * 11) % 28),
    hour: (i * 13) % 24,
    minute: (i * 29) % 60,
    latitude: 8 + (i % 25),
    longitude: 68 + (i % 25),
  });
}

describe("event karaka prior", () => {
  it("is well formed for every event type", () => {
    const planets = new Set(GRAHAS.map((g) => g.name));
    const vargas = new Set(VARGAS.map((v) => v.code));
    for (const k of EVENT_KARAKAS) {
      expect(k.primaryHouses.length, `${k.id} has no primary house`).toBeGreaterThan(0);
      for (const h of [...k.primaryHouses, ...k.secondaryHouses]) {
        expect(h, `${k.id} house out of range`).toBeGreaterThanOrEqual(1);
        expect(h, `${k.id} house out of range`).toBeLessThanOrEqual(12);
      }
      expect(k.karakas.length, `${k.id} has no karaka`).toBeGreaterThan(0);
      for (const p of k.karakas) expect(planets.has(p), `${k.id}: ${p} is not a graha`).toBe(true);
      expect(vargas.has(k.varga), `${k.id}: ${k.varga} is not a computed varga`).toBe(true);
      // Every row must cite where it comes from — the prior is only a guard
      // against overfitting if it is answerable to a text.
      expect(k.source.length, `${k.id} has no source`).toBeGreaterThan(0);
      expect(k.basis.length, `${k.id} has no basis`).toBeGreaterThan(30);
    }
  });

  it("never lists the same house as both primary and secondary", () => {
    for (const k of EVENT_KARAKAS) {
      const overlap = k.primaryHouses.filter((h) => k.secondaryHouses.includes(h));
      expect(overlap, `${k.id} double-counts house ${overlap[0]}`).toEqual([]);
    }
  });

  it("stays in step with the server's whitelist", () => {
    // server/lifeEvents.ts validates the type against its own literal set — it
    // cannot import this module, since the API build does not compile the astro
    // engine. Read the source and compare, so adding an event type here without
    // widening the whitelist fails here rather than as a 400 in production.
    const src = readFileSync(
      fileURLToPath(new URL("../../server/lifeEvents.ts", import.meta.url)),
      "utf8",
    );
    const block = src.match(/const TYPES = new Set\(\[([\s\S]*?)\]\)/);
    expect(block, "TYPES whitelist not found in server/lifeEvents.ts").toBeTruthy();
    const serverTypes = new Set([...block![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
    const engineTypes = new Set(EVENT_KARAKAS.map((k) => k.id as string));
    const missing = [...engineTypes].filter((t) => !serverTypes.has(t));
    const extra = [...serverTypes].filter((t) => !engineTypes.has(t));
    expect(missing, `the server would reject: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `the server accepts unknown types: ${extra.join(", ")}`).toEqual([]);
  });

  it("widens the scoring window as the user's certainty drops", () => {
    expect(PRECISION_WINDOW_DAYS.exact).toBeLessThan(PRECISION_WINDOW_DAYS.month);
    expect(PRECISION_WINDOW_DAYS.month).toBeLessThan(PRECISION_WINDOW_DAYS.year);
    expect(PRECISION_WINDOW_DAYS.year).toBeLessThan(PRECISION_WINDOW_DAYS.approx);
  });
});

describe("analyseEvent", () => {
  const marriage = {
    type: "marriage" as const,
    date: new Date(Date.UTC(2012, 4, 20)),
    precision: "exact" as const,
    confidence: "sure" as const,
  };

  it("names the dasha lords running on the date", () => {
    const a = analyseEvent(chart, marriage, { nullSamples: 0 });
    expect(a.mahadasha).toBeTruthy();
    expect(a.antardasha).toBeTruthy();
    expect(a.pratyantardasha).toBeTruthy();
    expect(a.periodLabel.split(" / ")).toHaveLength(3);
  });

  it("is reproducible — the same input gives the same percentile", () => {
    const a = analyseEvent(chart, marriage, { nullSamples: 150 });
    const b = analyseEvent(chart, marriage, { nullSamples: 150 });
    expect(b.percentile).toBe(a.percentile);
    expect(b.score).toBe(a.score);
  });

  it("returns no percentile when the null arm is switched off", () => {
    expect(analyseEvent(chart, marriage, { nullSamples: 0 }).percentile).toBeNull();
  });

  it("orders reasons by contribution", () => {
    const a = analyseEvent(chart, marriage, { nullSamples: 0 });
    const pts = a.reasons.map((r) => r.points);
    expect([...pts].sort((x, y) => y - x)).toEqual(pts);
  });

  it("flags the missing varga rather than quietly substituting one", () => {
    const a = analyseEvent(
      chart,
      { type: "illness", date: marriage.date, precision: "month", confidence: "sure" },
      { nullSamples: 0 },
    );
    // D30 is what the texts ask for and the engine does not compute it.
    expect(EVENT_KARAKA_BY_ID.illness.vargaWanted).toContain("D30");
    expect(a.vargaNote).toContain("D30");
  });

  it("has no varga note when the classical chart is actually computed", () => {
    expect(analyseEvent(chart, marriage, { nullSamples: 0 }).vargaNote).toBeUndefined();
  });

  it("scores every event type without throwing", () => {
    const tree = dashaTreeFor(chart);
    for (const k of EVENT_KARAKAS) {
      const a = analyseEvent(
        chart,
        { type: k.id, date: marriage.date, precision: "month", confidence: "sure" },
        { dashas: tree, nullSamples: 0 },
      );
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.score).toBeLessThanOrEqual(100);
    }
  });

  it("reads polarity — the same date is not equally good for opposite events", () => {
    // A promotion and a job loss share the 10th house but pull in opposite
    // directions. If the scorer ignored polarity they would score alike for
    // every date, which would mean it is measuring nothing.
    const tree = dashaTreeFor(chart);
    let differ = 0;
    for (let i = 0; i < 24; i++) {
      const date = new Date(Date.UTC(2000 + i, (i * 5) % 12, 15));
      const up = analyseEvent(chart, { type: "promotion", date, precision: "month", confidence: "sure" }, { dashas: tree, nullSamples: 0 });
      const down = analyseEvent(chart, { type: "job_loss", date, precision: "month", confidence: "sure" }, { dashas: tree, nullSamples: 0 });
      if (Math.abs(up.score - down.score) > 1) differ++;
    }
    expect(differ).toBeGreaterThan(12);
  });

  it("says so when the chart does not support the event", () => {
    // Across a long sweep at least some dates must produce dissent. A system
    // that only ever agrees with the user is the failure mode, not the goal.
    const tree = dashaTreeFor(chart);
    let withDissent = 0;
    for (let i = 0; i < 40; i++) {
      const date = new Date(Date.UTC(1990 + i, (i * 7) % 12, 10));
      const a = analyseEvent(chart, { type: "childbirth", date, precision: "month", confidence: "sure" }, { dashas: tree, nullSamples: 0 });
      if (a.dissent.length > 0) withDissent++;
    }
    expect(withDissent).toBeGreaterThan(0);
  });
});

describe("analyseEvents", () => {
  it("returns results in date order regardless of input order", () => {
    const out = analyseEvents(
      chart,
      [
        { type: "promotion", date: new Date(Date.UTC(2015, 1, 1)), precision: "year", confidence: "fairly" },
        { type: "marriage", date: new Date(Date.UTC(2008, 1, 1)), precision: "year", confidence: "sure" },
        { type: "childbirth", date: new Date(Date.UTC(2011, 1, 1)), precision: "year", confidence: "sure" },
      ],
      { nullSamples: 0 },
    );
    expect(out.map((a) => a.type)).toEqual(["marriage", "childbirth", "promotion"]);
  });
});

describe("the null arm", () => {
  // The exact form of the guarantee, and the one that actually catches the bug.
  // The statistical test below can only see a ~4-point shift against a ~1.6
  // standard error, which is too close to call without flaking; this sees it
  // every time, on the first chart where a yoga happens to be live.
  it("scores a date identically whether or not reasons are collected", () => {
    for (let i = 0; i < 40; i++) {
      const c = chartFor(i);
      const k = EVENT_KARAKAS[i % EVENT_KARAKAS.length];
      const date = new Date(Date.UTC(c.birth.year + 25 + (i % 20), (i * 5) % 12, 14));
      const ev = { type: k.id, date, precision: "month" as const, confidence: "sure" as const };
      expect(
        scoreEventDate(c, ev),
        `${k.id} on ${date.toISOString().slice(0, 10)} scored differently with reasons collected`,
      ).toBe(analyseEvent(c, ev, { nullSamples: 0 }).score);
    }
  });

  // This is the most important test in the file. The percentile is only
  // meaningful if a date drawn from the same pool the null arm samples scores
  // at the 50th percentile on average. Anything that lets the real event earn
  // points the null pool cannot shows up here as a shifted mean — which is
  // exactly how the yoga layer was caught running for the real event only,
  // inflating every result by about six points.
  it("is unbiased: random dates land at the 50th percentile on average", () => {
    const pcts: number[] = [];
    for (let i = 0; i < 300; i++) {
      const c = chartFor(i);
      const birth = Date.UTC(c.birth.year, c.birth.month - 1, c.birth.day);
      const span = Date.UTC(2026, 0, 1) - birth;
      const k = EVENT_KARAKAS[i % EVENT_KARAKAS.length];
      const date = new Date(birth + (((i * 37) % 1000) / 1000) * span);
      const a = analyseEvent(c, { type: k.id, date, precision: "month", confidence: "sure" }, { nullSamples: 80 });
      if (a.percentile !== null) pcts.push(a.percentile);
    }
    const mean = pcts.reduce((s, v) => s + v, 0) / pcts.length;
    const sd = Math.sqrt(pcts.reduce((s, v) => s + (v - mean) ** 2, 0) / pcts.length);

    expect(pcts.length).toBeGreaterThan(250);
    // Uniform on 0..100 has mean 50 and sd ~28.9. The standard error of this
    // mean is ~29/sqrt(300) ≈ 1.7, so ±5 is about three sigma — wide enough not
    // to flake, tight enough to catch the six-point bias that was there.
    expect(Math.abs(mean - 50), `null percentile mean was ${mean.toFixed(1)}`).toBeLessThan(5);
    expect(sd, `null percentile sd was ${sd.toFixed(1)}`).toBeGreaterThan(22);
  });
});
