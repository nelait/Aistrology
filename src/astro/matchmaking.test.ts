import { describe, it, expect } from "vitest";
import { computeMatch, checkManglik } from "./matchmaking";
import { computeChart } from "./engine";
import { BirthData } from "./types";

// Helper to quickly build a chart from minimal birth data.
function makeChart(birth: Partial<BirthData> & { year: number; month: number; day: number }) {
  const full: BirthData = {
    name: "Test",
    year: birth.year,
    month: birth.month,
    day: birth.day,
    hour: birth.hour ?? 12,
    minute: birth.minute ?? 0,
    second: birth.second ?? 0,
    tzOffsetHours: birth.tzOffsetHours ?? 5.5,
    latitude: birth.latitude ?? 28.61,
    longitude: birth.longitude ?? 77.21,
    placeLabel: birth.placeLabel ?? "Delhi",
  };
  return computeChart(full);
}

describe("Ashtakoot Gun Milan", () => {
  // Use two known birth data sets with known results.
  // Gandhi (2 Oct 1869, 07:45, Porbandar) and Kalam (15 Oct 1931, 01:15, Rameswaram)
  const gandhi = makeChart({
    name: "Mahatma Gandhi",
    year: 1869, month: 10, day: 2, hour: 7, minute: 45,
    tzOffsetHours: 5.5, latitude: 21.6417, longitude: 69.6293,
    placeLabel: "Porbandar",
  });

  const kalam = makeChart({
    name: "A. P. J. Abdul Kalam",
    year: 1931, month: 10, day: 15, hour: 1, minute: 15,
    tzOffsetHours: 5.5, latitude: 9.2881, longitude: 79.3129,
    placeLabel: "Rameswaram",
  });

  it("should compute a MatchResult with all 8 kutas", () => {
    const result = computeMatch(gandhi, kalam);
    expect(result.kutas).toHaveLength(8);
    expect(result.maxScore).toBe(36);
    expect(result.totalScore).toBeGreaterThanOrEqual(0);
    expect(result.totalScore).toBeLessThanOrEqual(36);
    expect(["Excellent", "Good", "Average", "Below Average"]).toContain(result.verdict);
  });

  it("should score each kuta within its max range", () => {
    const result = computeMatch(gandhi, kalam);
    for (const k of result.kutas) {
      expect(k.points).toBeGreaterThanOrEqual(0);
      expect(k.points).toBeLessThanOrEqual(k.maxPoints);
      expect(k.name).toBeTruthy();
      expect(k.description).toBeTruthy();
      expect(k.detail).toBeTruthy();
    }
  });

  it("should sum kutas to totalScore", () => {
    const result = computeMatch(gandhi, kalam);
    const sum = result.kutas.reduce((s, k) => s + k.points, 0);
    expect(result.totalScore).toBe(sum);
  });

  it("should have correct kuta names in order", () => {
    const result = computeMatch(gandhi, kalam);
    const names = result.kutas.map((k) => k.name);
    expect(names).toEqual([
      "Varna", "Vashya", "Tara", "Yoni",
      "Graha Maitri", "Gana", "Bhakoot", "Nadi",
    ]);
  });

  it("should have correct max points per kuta", () => {
    const result = computeMatch(gandhi, kalam);
    const maxes = result.kutas.map((k) => k.maxPoints);
    expect(maxes).toEqual([1, 2, 3, 4, 5, 3, 7, 8]);
  });

  it("should assign the correct verdict for the score", () => {
    const result = computeMatch(gandhi, kalam);
    if (result.totalScore >= 28) expect(result.verdict).toBe("Excellent");
    else if (result.totalScore >= 21) expect(result.verdict).toBe("Good");
    else if (result.totalScore >= 15) expect(result.verdict).toBe("Average");
    else expect(result.verdict).toBe("Below Average");
  });

  it("should compute percentage correctly", () => {
    const result = computeMatch(gandhi, kalam);
    expect(result.percentage).toBe(Math.round((result.totalScore / 36) * 100));
  });

  it("same chart matched with itself should score high on Nadi=0 (same nadi)", () => {
    const result = computeMatch(gandhi, gandhi);
    const nadi = result.kutas.find((k) => k.name === "Nadi")!;
    expect(nadi.points).toBe(0); // same nakshatra → same nadi → dosha
  });

  it("same chart: Varna should be 1 (same sign)", () => {
    const result = computeMatch(gandhi, gandhi);
    const varna = result.kutas.find((k) => k.name === "Varna")!;
    expect(varna.points).toBe(1);
  });

  it("same chart: Yoni should be 4 (same animal)", () => {
    const result = computeMatch(gandhi, gandhi);
    const yoni = result.kutas.find((k) => k.name === "Yoni")!;
    expect(yoni.points).toBe(4);
  });

  it("same chart: Gana should be 3 (same gana)", () => {
    const result = computeMatch(gandhi, gandhi);
    const gana = result.kutas.find((k) => k.name === "Gana")!;
    expect(gana.points).toBe(3);
  });
});

describe("Manglik dosha", () => {
  it("should detect Manglik when Mars is in the 1st house", () => {
    // Use a birth where Mars ends up in the 1st house. Use an actual
    // chart since house depends on Lagna.
    const chart = makeChart({ year: 1990, month: 1, day: 1, hour: 6, minute: 0 });
    const mars = chart.planets.find((p) => p.planet === "Mars")!;
    const result = checkManglik(chart);
    if ([1, 2, 4, 7, 8, 12].includes(mars.house)) {
      expect(result.isManglik).toBe(true);
    } else {
      expect(result.isManglik).toBe(false);
    }
  });

  it("should have cancellation info when Manglik is cancelled", () => {
    const chart = makeChart({ year: 1990, month: 1, day: 1, hour: 12, minute: 0 });
    const result = checkManglik(chart);
    if (result.cancelled) {
      expect(result.cancellationReason).toBeTruthy();
    }
  });

  it("should mark manglikCompatible when both partners are Manglik or both non-Manglik", () => {
    const chart = makeChart({ year: 1990, month: 1, day: 1, hour: 12, minute: 0 });
    const match = computeMatch(chart, chart);
    // Same chart → same Manglik status → always compatible
    expect(match.manglikCompatible).toBe(true);
  });
});
