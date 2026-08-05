import { describe, it, expect } from "vitest";
import { computeFriendship } from "./friendship";
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

describe("Friendship compatibility", () => {
  const gandhi = makeChart({
    year: 1869, month: 10, day: 2, hour: 7, minute: 45,
    tzOffsetHours: 5.5, latitude: 21.6417, longitude: 69.6293,
  });
  const kalam = makeChart({
    year: 1931, month: 10, day: 15, hour: 1, minute: 15,
    tzOffsetHours: 5.5, latitude: 9.2881, longitude: 79.3129,
  });

  it("should compute a result with all 6 factors", () => {
    const result = computeFriendship(gandhi, kalam);
    expect(result.factors).toHaveLength(6);
    expect(result.maxScore).toBe(30);
  });

  it("should score each factor within its max", () => {
    const result = computeFriendship(gandhi, kalam);
    for (const f of result.factors) {
      expect(f.points).toBeGreaterThanOrEqual(0);
      expect(f.points).toBeLessThanOrEqual(f.maxPoints);
      expect(f.name).toBeTruthy();
      expect(f.description).toBeTruthy();
      expect(f.detail).toBeTruthy();
    }
  });

  it("should sum factors to totalScore", () => {
    const result = computeFriendship(gandhi, kalam);
    const sum = result.factors.reduce((s, f) => s + f.points, 0);
    expect(result.totalScore).toBe(sum);
  });

  it("should have correct factor names", () => {
    const result = computeFriendship(gandhi, kalam);
    const names = result.factors.map((f) => f.name);
    expect(names).toEqual([
      "Graha Maitri", "Gana", "Tara",
      "Element Harmony", "Nadi", "Communication",
    ]);
  });

  it("should have correct max points per factor", () => {
    const result = computeFriendship(gandhi, kalam);
    const maxes = result.factors.map((f) => f.maxPoints);
    expect(maxes).toEqual([6, 5, 5, 5, 4, 5]);
  });

  it("should assign correct verdict for the score", () => {
    const result = computeFriendship(gandhi, kalam);
    if (result.totalScore >= 25) expect(result.verdict).toBe("Soul Mates");
    else if (result.totalScore >= 19) expect(result.verdict).toBe("Great Friends");
    else if (result.totalScore >= 13) expect(result.verdict).toBe("Good Friends");
    else expect(result.verdict).toBe("Acquaintances");
  });

  it("should compute percentage correctly", () => {
    const result = computeFriendship(gandhi, kalam);
    expect(result.percentage).toBe(Math.round((result.totalScore / 30) * 100));
  });

  it("same chart: Gana should be max (same gana)", () => {
    const result = computeFriendship(gandhi, gandhi);
    const gana = result.factors.find((f) => f.name === "Gana")!;
    expect(gana.points).toBe(5);
  });

  it("same chart: Graha Maitri should be max (same lord)", () => {
    const result = computeFriendship(gandhi, gandhi);
    const gm = result.factors.find((f) => f.name === "Graha Maitri")!;
    expect(gm.points).toBe(6);
  });

  it("same chart: Element Harmony should be max (same element)", () => {
    const result = computeFriendship(gandhi, gandhi);
    const eh = result.factors.find((f) => f.name === "Element Harmony")!;
    expect(eh.points).toBe(5);
  });

  it("same chart: Communication should be max (same Mercury sign)", () => {
    const result = computeFriendship(gandhi, gandhi);
    const comm = result.factors.find((f) => f.name === "Communication")!;
    expect(comm.points).toBe(5);
  });

  it("same chart: Nadi should be 2 (same nadi — less dynamic)", () => {
    const result = computeFriendship(gandhi, gandhi);
    const nadi = result.factors.find((f) => f.name === "Nadi")!;
    expect(nadi.points).toBe(2);
  });
});
