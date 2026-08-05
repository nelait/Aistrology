import { describe, it, expect } from "vitest";
import { analyseCareer } from "./career";
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

describe("Career analysis", () => {
  const gandhi = makeChart({
    year: 1869, month: 10, day: 2, hour: 7, minute: 45,
    tzOffsetHours: 5.5, latitude: 21.6417, longitude: 69.6293,
  });

  const kalam = makeChart({
    year: 1931, month: 10, day: 15, hour: 1, minute: 15,
    tzOffsetHours: 5.5, latitude: 9.2881, longitude: 79.3129,
  });

  it("should return top 5 domains", () => {
    const result = analyseCareer(gandhi);
    expect(result.topDomains.length).toBeLessThanOrEqual(5);
    expect(result.topDomains.length).toBeGreaterThan(0);
  });

  it("should have domains sorted by score descending", () => {
    const result = analyseCareer(gandhi);
    for (let i = 1; i < result.allDomains.length; i++) {
      expect(result.allDomains[i].score).toBeLessThanOrEqual(result.allDomains[i - 1].score);
    }
  });

  it("should have scores in 0-100 range", () => {
    const result = analyseCareer(gandhi);
    for (const d of result.allDomains) {
      expect(d.score).toBeGreaterThanOrEqual(0);
      expect(d.score).toBeLessThanOrEqual(100);
    }
  });

  it("should have at least one domain with score 100 (the top)", () => {
    const result = analyseCareer(gandhi);
    expect(result.allDomains[0].score).toBe(100);
  });

  it("should include non-empty factors", () => {
    const result = analyseCareer(gandhi);
    expect(result.factors.length).toBeGreaterThanOrEqual(4);
    for (const f of result.factors) {
      expect(f.name).toBeTruthy();
      expect(f.description).toBeTruthy();
      expect(f.detail).toBeTruthy();
    }
  });

  it("should identify a strongest planet", () => {
    const result = analyseCareer(gandhi);
    expect(result.strongestPlanet).toBeTruthy();
    const validPlanets = ["Sun", "Moon", "Mars", "Mercury", "Jupiter", "Venus", "Saturn"];
    expect(validPlanets).toContain(result.strongestPlanet);
  });

  it("should identify a career element", () => {
    const result = analyseCareer(gandhi);
    expect(["Fire", "Earth", "Air", "Water"]).toContain(result.careerElement);
  });

  it("should provide a non-empty tenthHouseSummary", () => {
    const result = analyseCareer(gandhi);
    expect(result.tenthHouseSummary.length).toBeGreaterThan(20);
  });

  it("should have domains with icons and keywords", () => {
    const result = analyseCareer(gandhi);
    for (const d of result.topDomains) {
      expect(d.icon).toBeTruthy();
      expect(d.keywords.length).toBeGreaterThan(0);
      expect(d.reasoning).toBeTruthy();
    }
  });

  it("should produce different results for different charts", () => {
    const r1 = analyseCareer(gandhi);
    const r2 = analyseCareer(kalam);
    // At minimum the 10th house summary should differ
    expect(r1.tenthHouseSummary).not.toBe(r2.tenthHouseSummary);
  });
});
