import { describe, it, expect } from "vitest";
import { computeChart } from "./engine";
import { interpretVarga } from "./vargaInterpret";
import { VARGAS } from "./varga";
import { BirthData } from "./types";

const REFERENCE: BirthData = {
  name: "Reference",
  year: 1990, month: 1, day: 1, hour: 12, minute: 0, second: 0,
  tzOffsetHours: 5.5, latitude: 28.6139, longitude: 77.209,
  placeLabel: "New Delhi, India",
};

const chart = computeChart(REFERENCE);

describe("interpretVarga", () => {
  it("produces a domain reading for every varga", () => {
    for (const v of VARGAS) {
      const r = interpretVarga(chart, v.code);
      expect(r.domain.length).toBeGreaterThan(3);
      expect(r.lines.length).toBeGreaterThanOrEqual(1);
      expect(r.lagnaSign).toBeGreaterThanOrEqual(0);
      expect(r.lagnaSign).toBeLessThan(12);
      expect(["Favourable", "Mixed", "Challenging"]).toContain(r.tone);
      expect(r.references.length).toBeGreaterThanOrEqual(1);
      expect(r.facts.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("reads D9 for marriage, naming the 7th and Venus", () => {
    const r = interpretVarga(chart, "D9");
    expect(r.domain).toMatch(/marriage/i);
    expect(r.lines.join(" ")).toMatch(/7th/);
    expect(r.lines.join(" ")).toMatch(/Venus/);
  });

  it("reads D10 for career, naming the 10th", () => {
    const r = interpretVarga(chart, "D10");
    expect(r.domain).toMatch(/career/i);
    expect(r.lines.join(" ")).toMatch(/10th/);
  });

  it("reads D7 for children (5th, Jupiter)", () => {
    const r = interpretVarga(chart, "D7");
    expect(r.domain).toMatch(/children/i);
    expect(r.lines.join(" ")).toMatch(/5th/);
    expect(r.lines.join(" ")).toMatch(/Jupiter/);
  });

  it("reads D2 (Horā) as a wealth lean between the two horās", () => {
    const r = interpretVarga(chart, "D2");
    expect(r.domain).toMatch(/wealth/i);
    expect(r.facts.join(" ")).toMatch(/hor[āa]/i);
  });

  it("points D1 to the whole chart", () => {
    const r = interpretVarga(chart, "D1");
    expect(r.domain).toMatch(/whole/i);
  });

  it("checks the D1 baseline first, then the running dasha (analysis method)", () => {
    const now = new Date(Date.UTC(2026, 0, 1)); // within the 1990 chart's dasha span
    const r = interpretVarga(chart, "D9", now);
    const all = [...r.lines, ...r.facts].join(" ");
    // Guideline 1: the D1 baseline for the area.
    expect(all).toMatch(/baseline/i);
    expect(all).toMatch(/D1|Rāśi/);
    // Guideline 2: the currently-running dasha lord.
    expect(all).toMatch(/Mahadasha/);
  });
});
