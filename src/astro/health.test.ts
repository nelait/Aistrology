import { describe, it, expect } from "vitest";
import { analyseHealth } from "./health";
import { computeChart } from "./engine";
import { BirthData } from "./types";

function makeChart(birth: Partial<BirthData> & { year: number; month: number; day: number }) {
  return computeChart({
    name: "Test", year: birth.year, month: birth.month, day: birth.day,
    hour: birth.hour ?? 12, minute: birth.minute ?? 0, second: birth.second ?? 0,
    tzOffsetHours: birth.tzOffsetHours ?? 5.5,
    latitude: birth.latitude ?? 28.61, longitude: birth.longitude ?? 77.21,
    placeLabel: birth.placeLabel ?? "Delhi",
  });
}

describe("Health analysis", () => {
  const chart1 = makeChart({
    year: 1869, month: 10, day: 2, hour: 7, minute: 45,
    tzOffsetHours: 5.5, latitude: 21.6417, longitude: 69.6293,
  });

  const chart2 = makeChart({
    year: 1990, month: 3, day: 15, hour: 14, minute: 30,
    tzOffsetHours: 5.5, latitude: 17.3616, longitude: 78.4747,
  });

  it("should return a valid constitution type", () => {
    const result = analyseHealth(chart1);
    expect(["Vata", "Pitta", "Kapha"]).toContain(result.constitution);
  });

  it("should return a constitution description", () => {
    const result = analyseHealth(chart1);
    expect(result.constitutionDescription.length).toBeGreaterThan(20);
  });

  it("should have vitality score between 10-100", () => {
    const result = analyseHealth(chart1);
    expect(result.vitalityScore).toBeGreaterThanOrEqual(10);
    expect(result.vitalityScore).toBeLessThanOrEqual(100);
  });

  it("should have a non-empty vitality verdict", () => {
    const result = analyseHealth(chart1);
    expect(result.vitalityVerdict.length).toBeGreaterThan(10);
  });

  it("should have health areas with valid severity", () => {
    const result = analyseHealth(chart1);
    for (const a of result.areas) {
      expect(["high", "moderate", "low"]).toContain(a.severity);
      expect(a.name).toBeTruthy();
      expect(a.bodyParts.length).toBeGreaterThan(0);
      expect(a.indication).toBeTruthy();
      expect(a.remedy).toBeTruthy();
    }
  });

  it("should have areas sorted by severity (high first)", () => {
    const result = analyseHealth(chart1);
    const order = { high: 0, moderate: 1, low: 2 };
    for (let i = 1; i < result.areas.length; i++) {
      expect(order[result.areas[i].severity]).toBeGreaterThanOrEqual(order[result.areas[i - 1].severity]);
    }
  });

  it("should have at least 4 factors", () => {
    const result = analyseHealth(chart1);
    expect(result.factors.length).toBeGreaterThanOrEqual(4);
    for (const f of result.factors) {
      expect(f.name).toBeTruthy();
      expect(f.description).toBeTruthy();
      expect(f.detail).toBeTruthy();
    }
  });

  it("should have general remedies", () => {
    const result = analyseHealth(chart1);
    expect(result.generalRemedies.length).toBeGreaterThanOrEqual(3);
  });

  it("should produce different results for different charts", () => {
    const r1 = analyseHealth(chart1);
    const r2 = analyseHealth(chart2);
    // At minimum vitality or constitution should differ
    const differs = r1.vitalityScore !== r2.vitalityScore ||
      r1.constitution !== r2.constitution ||
      r1.areas.length !== r2.areas.length;
    expect(differs).toBe(true);
  });
});
