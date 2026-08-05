import { describe, it, expect } from "vitest";
import { computeChart } from "./engine";
import { dailyForecast, weeklyForecast } from "./forecast";
import { BirthData } from "./types";

const REFERENCE: BirthData = {
  name: "Reference",
  year: 1990, month: 1, day: 1, hour: 12, minute: 0, second: 0,
  tzOffsetHours: 5.5, latitude: 28.6139, longitude: 77.209,
  placeLabel: "New Delhi, India",
};

const chart = computeChart(REFERENCE);
const DAY = new Date(Date.UTC(2026, 6, 26)); // 2026-07-26

describe("dailyForecast", () => {
  const f = dailyForecast(chart, DAY);

  it("counts all nine grahas across favorable + challenging", () => {
    expect(f.favorable + f.challenging).toBe(9);
  });

  it("classifies a coherent tone", () => {
    expect(["Favorable", "Mixed", "Challenging"]).toContain(f.tone);
    if (f.favorable >= f.challenging + 2) expect(f.tone).toBe("Favorable");
    if (f.challenging >= f.favorable + 2) expect(f.tone).toBe("Challenging");
  });

  it("places the transiting Moon in a valid sign / nakshatra / house", () => {
    expect(f.moonSign).toBeGreaterThanOrEqual(0);
    expect(f.moonSign).toBeLessThan(12);
    expect(f.moonNakshatra).toBeGreaterThanOrEqual(0);
    expect(f.moonNakshatra).toBeLessThan(27);
    expect(f.moonHouseFromMoon).toBeGreaterThanOrEqual(1);
    expect(f.moonHouseFromMoon).toBeLessThanOrEqual(12);
  });

  it("names the running dasha and writes a summary", () => {
    expect(f.dashaMaha).toBeDefined();
    expect(f.summary.length).toBeGreaterThan(20);
  });

  it("is deterministic", () => {
    const g = dailyForecast(chart, DAY);
    expect(g.tone).toBe(f.tone);
    expect(g.moonSign).toBe(f.moonSign);
    expect(g.summary).toBe(f.summary);
  });
});

describe("weeklyForecast", () => {
  const w = weeklyForecast(chart, DAY);

  it("spans seven contiguous days", () => {
    expect(w.days).toHaveLength(7);
    for (let i = 1; i < 7; i++) {
      const gap = w.days[i].date.getTime() - w.days[i - 1].date.getTime();
      expect(Math.round(gap / 86_400_000)).toBe(1);
    }
  });

  it("collects the distinct Moon signs of the week (Moon moves fast)", () => {
    expect(w.moonSigns.length).toBeGreaterThanOrEqual(2);
    for (const s of w.moonSigns) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(12);
    }
  });

  it("summarises with a coherent overall tone", () => {
    expect(["Favorable", "Mixed", "Challenging"]).toContain(w.tone);
    expect(w.summary.length).toBeGreaterThan(30);
  });
});
