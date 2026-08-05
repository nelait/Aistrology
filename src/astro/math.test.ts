import { describe, it, expect } from "vitest";
import { norm360, norm180, angularSeparation, atan2Deg } from "./math";

describe("norm360", () => {
  it("keeps in-range angles unchanged", () => {
    expect(norm360(0)).toBe(0);
    expect(norm360(359.9)).toBeCloseTo(359.9, 10);
  });

  it("wraps values at or above 360", () => {
    expect(norm360(360)).toBeCloseTo(0, 10);
    expect(norm360(361)).toBeCloseTo(1, 10);
    expect(norm360(720 + 45)).toBeCloseTo(45, 10);
  });

  it("wraps negative values into [0, 360)", () => {
    // Note: JS may yield -0 for exact multiples; toBeCloseTo treats it as 0.
    expect(norm360(-1)).toBeCloseTo(359, 10);
    expect(norm360(-360)).toBeCloseTo(0, 10);
    expect(norm360(-725)).toBeCloseTo(355, 10);
  });
});

describe("norm180", () => {
  it("maps into (-180, 180]", () => {
    expect(norm180(0)).toBe(0);
    expect(norm180(180)).toBe(180);
    expect(norm180(190)).toBeCloseTo(-170, 10);
    expect(norm180(-190)).toBeCloseTo(170, 10);
    expect(norm180(360)).toBe(0);
  });
});

describe("angularSeparation", () => {
  it("returns the short arc in [0, 180]", () => {
    expect(angularSeparation(10, 20)).toBeCloseTo(10, 10);
    expect(angularSeparation(350, 10)).toBeCloseTo(20, 10); // across 0°
    expect(angularSeparation(0, 180)).toBeCloseTo(180, 10);
    expect(angularSeparation(0, 270)).toBeCloseTo(90, 10);
  });

  it("is symmetric", () => {
    expect(angularSeparation(37, 211)).toBeCloseTo(angularSeparation(211, 37), 10);
  });
});

describe("atan2Deg", () => {
  it("returns degrees in [0, 360)", () => {
    expect(atan2Deg(0, 1)).toBeCloseTo(0, 10);
    expect(atan2Deg(1, 0)).toBeCloseTo(90, 10);
    expect(atan2Deg(0, -1)).toBeCloseTo(180, 10);
    expect(atan2Deg(-1, 0)).toBeCloseTo(270, 10); // normalised, not -90
  });
});
