import { describe, it, expect } from "vitest";
import { analyseMentalHealth } from "./mentalHealth";
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

describe("Mental health analysis", () => {
  const chart1 = makeChart({
    year: 1869, month: 10, day: 2, hour: 7, minute: 45,
    tzOffsetHours: 5.5, latitude: 21.6417, longitude: 69.6293,
  });

  const chart2 = makeChart({
    year: 1990, month: 3, day: 15, hour: 14, minute: 30,
    tzOffsetHours: 5.5, latitude: 17.3616, longitude: 78.4747,
  });

  it("should return overall score between 10-100", () => {
    const result = analyseMentalHealth(chart1);
    expect(result.overallScore).toBeGreaterThanOrEqual(10);
    expect(result.overallScore).toBeLessThanOrEqual(100);
  });

  it("should have a non-empty verdict", () => {
    const result = analyseMentalHealth(chart1);
    expect(result.overallVerdict.length).toBeGreaterThan(20);
  });

  it("should have 5 dimensions", () => {
    const result = analyseMentalHealth(chart1);
    expect(result.dimensions).toHaveLength(5);
  });

  it("should have dimension scores between 10-100", () => {
    const result = analyseMentalHealth(chart1);
    for (const d of result.dimensions) {
      expect(d.score).toBeGreaterThanOrEqual(10);
      expect(d.score).toBeLessThanOrEqual(100);
      expect(d.name).toBeTruthy();
      expect(d.icon).toBeTruthy();
      expect(d.indication).toBeTruthy();
      expect(d.remedy).toBeTruthy();
    }
  });

  it("should have at least 3 factors", () => {
    const result = analyseMentalHealth(chart1);
    expect(result.factors.length).toBeGreaterThanOrEqual(3);
    for (const f of result.factors) {
      expect(f.name).toBeTruthy();
      expect(f.detail).toBeTruthy();
    }
  });

  it("should have remedies", () => {
    const result = analyseMentalHealth(chart1);
    expect(result.remedies.length).toBeGreaterThanOrEqual(3);
  });

  it("should detect afflictions as array", () => {
    const result = analyseMentalHealth(chart1);
    expect(Array.isArray(result.afflictions)).toBe(true);
  });

  it("should produce different results for different charts", () => {
    const r1 = analyseMentalHealth(chart1);
    const r2 = analyseMentalHealth(chart2);
    const differs = r1.overallScore !== r2.overallScore ||
      r1.dimensions[0].score !== r2.dimensions[0].score;
    expect(differs).toBe(true);
  });

  it("should include Moon dimension as the first (highest weight)", () => {
    const result = analyseMentalHealth(chart1);
    expect(result.dimensions[0].name).toBe("Emotional Well-being");
  });
});
