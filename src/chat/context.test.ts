import { describe, it, expect } from "vitest";
import { computeChart } from "../astro/engine";
import { BirthData } from "../astro/types";
import { RASHIS } from "../astro/constants";
import { detectDoshas } from "../astro/doshas";
import { summarizeChart, summarizeDoshas, buildChatContext } from "./context";

// Two distinct reference profiles with known, DIFFERENT ascendants. Profile A is
// the engine suite's reference chart (Ascendant Pisces). Profile B is a separate
// birth chosen to land on a different Lagna, so cross-profile leakage is visible.
const PROFILE_A: BirthData = {
  name: "Asha (Delhi 1990)",
  year: 1990, month: 1, day: 1, hour: 12, minute: 0, second: 0,
  tzOffsetHours: 5.5, latitude: 28.6139, longitude: 77.209, placeLabel: "New Delhi, India",
};
const PROFILE_B: BirthData = {
  name: "Ravi (Chennai 1985)",
  year: 1985, month: 6, day: 15, hour: 6, minute: 30, second: 0,
  tzOffsetHours: 5.5, latitude: 13.0827, longitude: 80.2707, placeLabel: "Chennai, India",
};

const chartA = computeChart(PROFILE_A);
const chartB = computeChart(PROFILE_B);
const ascA = RASHIS[chartA.ascendantSign].name;
const ascB = RASHIS[chartB.ascendantSign].name;

describe("summarizeChart", () => {
  it("names the correct ascendant for the profile", () => {
    expect(summarizeChart(chartA)).toContain(`Ascendant (Lagna): ${ascA}.`);
    expect(chartA.ascendantSign).toBe(11); // Pisces — anchors to the engine suite
    expect(summarizeChart(chartA)).toContain("Ascendant (Lagna): Pisces.");
  });

  it("lists every planet with its sign and house exactly as computed", () => {
    const summary = summarizeChart(chartA);
    for (const p of chartA.planets) {
      const line = `${p.planet} in ${RASHIS[p.signIndex].name}, house ${p.house}`;
      expect(summary).toContain(line);
    }
  });

  it("is deterministic (same chart → identical summary)", () => {
    expect(summarizeChart(chartA)).toBe(summarizeChart(computeChart(PROFILE_A)));
  });
});

describe("summarizeDoshas", () => {
  it("mirrors detectDoshas exactly (names every detected dosha, or says none)", () => {
    const lines = summarizeDoshas(chartA);
    const detected = detectDoshas(chartA);
    if (detected.length === 0) {
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/none of the common chart doshas/i);
    } else {
      expect(lines).toHaveLength(detected.length);
      for (const d of detected) {
        expect(lines.some((l) => l.includes(d.name))).toBe(true);
      }
    }
  });
});

describe("buildChatContext", () => {
  it("labels the context with the profile name and its own summary", () => {
    const ctx = buildChatContext({ chart: chartA, moduleLabel: "Kundli" });
    expect(ctx.chart?.label).toBe(PROFILE_A.name);
    expect(ctx.chart?.summary).toBe(summarizeChart(chartA));
    expect(ctx.module).toBe("Kundli");
  });

  it("always injects the detected doshas as findings", () => {
    const ctx = buildChatContext({ chart: chartA });
    expect(ctx.findings).toEqual(summarizeDoshas(chartA));
  });

  it("merges the active module's published findings after the doshas", () => {
    const moduleFindings = ["Muhurta: 2026-08-05 rated excellent."];
    const ctx = buildChatContext({ chart: chartA, moduleFindings });
    expect(ctx.findings).toEqual([...summarizeDoshas(chartA), ...moduleFindings]);
  });

  it("handles a signed-in user with no chart loaded", () => {
    const ctx = buildChatContext({ chart: null, moduleFindings: ["x"] });
    expect(ctx.chart).toBeUndefined();
    expect(ctx.findings).toEqual(["x"]);
  });

  it("omits findings entirely when there are none", () => {
    const ctx = buildChatContext({ chart: null });
    expect(ctx.findings).toBeUndefined();
  });
});

// The core guarantee behind "appropriate for the SELECTED profile": the context
// for a profile reflects only that profile's chart, never another's.
describe("cross-profile isolation", () => {
  it("uses two profiles with genuinely different ascendants (a meaningful test)", () => {
    expect(ascA).not.toBe(ascB);
  });

  it("each context names its own ascendant and not the other's", () => {
    const ctxA = buildChatContext({ chart: chartA });
    const ctxB = buildChatContext({ chart: chartB });
    expect(ctxA.chart?.summary).toContain(`Ascendant (Lagna): ${ascA}.`);
    expect(ctxB.chart?.summary).toContain(`Ascendant (Lagna): ${ascB}.`);
    // No leakage: A's Lagna line must not claim B's ascendant, and vice versa.
    expect(ctxA.chart?.summary).not.toContain(`Ascendant (Lagna): ${ascB}.`);
    expect(ctxB.chart?.summary).not.toContain(`Ascendant (Lagna): ${ascA}.`);
  });

  it("produces distinct summaries and labels for distinct profiles", () => {
    const a = buildChatContext({ chart: chartA });
    const b = buildChatContext({ chart: chartB });
    expect(a.chart?.summary).not.toBe(b.chart?.summary);
    expect(a.chart?.label).not.toBe(b.chart?.label);
  });

  it("is order-independent — building B after A never mutates A's context", () => {
    const first = buildChatContext({ chart: chartA });
    buildChatContext({ chart: chartB });
    const again = buildChatContext({ chart: chartA });
    expect(again).toEqual(first);
  });
});
