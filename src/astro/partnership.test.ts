import { describe, it, expect } from "vitest";
import { computePartnership } from "./partnership";
import { computeChart } from "./engine";
import { BirthData } from "./types";

function makeChart(birth: Partial<BirthData> & { year: number; month: number; day: number }) {
  const full: BirthData = {
    name: "Test",
    year: birth.year, month: birth.month, day: birth.day,
    hour: birth.hour ?? 12, minute: birth.minute ?? 0, second: birth.second ?? 0,
    tzOffsetHours: birth.tzOffsetHours ?? 5.5,
    latitude: birth.latitude ?? 28.61, longitude: birth.longitude ?? 77.21,
    placeLabel: birth.placeLabel ?? "Delhi",
  };
  return computeChart(full);
}

describe("Partnership compatibility", () => {
  const gandhi = makeChart({
    year: 1869, month: 10, day: 2, hour: 7, minute: 45,
    tzOffsetHours: 5.5, latitude: 21.6417, longitude: 69.6293,
  });
  const kalam = makeChart({
    year: 1931, month: 10, day: 15, hour: 1, minute: 15,
    tzOffsetHours: 5.5, latitude: 9.2881, longitude: 79.3129,
  });

  it("should compute a result with all 6 factors", () => {
    const result = computePartnership(gandhi, kalam);
    expect(result.factors).toHaveLength(6);
    expect(result.maxScore).toBe(30);
  });

  it("should score each factor within its max", () => {
    const result = computePartnership(gandhi, kalam);
    for (const f of result.factors) {
      expect(f.points).toBeGreaterThanOrEqual(0);
      expect(f.points).toBeLessThanOrEqual(f.maxPoints);
      expect(f.name).toBeTruthy();
      expect(f.description).toBeTruthy();
      expect(f.detail).toBeTruthy();
    }
  });

  it("should sum factors to totalScore", () => {
    const result = computePartnership(gandhi, kalam);
    const sum = result.factors.reduce((s, f) => s + f.points, 0);
    expect(result.totalScore).toBe(sum);
  });

  it("should have correct factor names", () => {
    const result = computePartnership(gandhi, kalam);
    const names = result.factors.map((f) => f.name);
    expect(names).toEqual([
      "Mercury Synergy", "Jupiter Alignment", "Saturn Commitment",
      "Leadership Dynamics", "Wealth Potential", "Graha Maitri",
    ]);
  });

  it("should have correct max points per factor", () => {
    const result = computePartnership(gandhi, kalam);
    const maxes = result.factors.map((f) => f.maxPoints);
    expect(maxes).toEqual([6, 5, 5, 5, 5, 4]);
  });

  it("should assign correct verdict for the score", () => {
    const result = computePartnership(gandhi, kalam);
    if (result.totalScore >= 25) expect(result.verdict).toBe("Power Duo");
    else if (result.totalScore >= 19) expect(result.verdict).toBe("Strong Alliance");
    else if (result.totalScore >= 13) expect(result.verdict).toBe("Workable");
    else expect(result.verdict).toBe("Challenging");
  });

  it("should compute percentage correctly", () => {
    const result = computePartnership(gandhi, kalam);
    expect(result.percentage).toBe(Math.round((result.totalScore / 30) * 100));
  });

  it("same chart: Mercury Synergy should be max", () => {
    const result = computePartnership(gandhi, gandhi);
    const merc = result.factors.find((f) => f.name === "Mercury Synergy")!;
    expect(merc.points).toBe(6);
  });

  it("same chart: Jupiter Alignment should be max", () => {
    const result = computePartnership(gandhi, gandhi);
    const jup = result.factors.find((f) => f.name === "Jupiter Alignment")!;
    expect(jup.points).toBe(5);
  });

  it("same chart: Saturn Commitment should be max", () => {
    const result = computePartnership(gandhi, gandhi);
    const sat = result.factors.find((f) => f.name === "Saturn Commitment")!;
    expect(sat.points).toBe(5);
  });

  it("same chart: Leadership should be 4 (same Sun sign, ego overlap)", () => {
    const result = computePartnership(gandhi, gandhi);
    const lead = result.factors.find((f) => f.name === "Leadership Dynamics")!;
    expect(lead.points).toBe(4); // same sign = 4, not 5 (ego clash risk)
  });

  it("same chart: Graha Maitri should be max", () => {
    const result = computePartnership(gandhi, gandhi);
    const gm = result.factors.find((f) => f.name === "Graha Maitri")!;
    expect(gm.points).toBe(4);
  });
});
