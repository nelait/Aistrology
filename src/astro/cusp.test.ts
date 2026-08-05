import { describe, it, expect } from "vitest";
import { cuspInfo, DEFAULT_CUSP_TOLERANCE } from "./cusp";
import { NAKSHATRA_SPAN, PADA_SPAN } from "./constants";

describe("cuspInfo — sign boundaries", () => {
  it("flags a longitude just below a sign boundary and names the next sign", () => {
    const info = cuspInfo(29.97); // late Aries, about to enter Taurus
    expect(info.sign.near).toBe(true);
    expect(info.sign.distanceDeg).toBeCloseTo(0.03, 6);
    expect(info.sign.neighborIndex).toBe(1); // Taurus
    expect(info.any).toBe(true);
  });

  it("flags a longitude just above a sign boundary and names the previous sign", () => {
    const info = cuspInfo(30.02); // early Taurus, just left Aries
    expect(info.sign.near).toBe(true);
    expect(info.sign.distanceDeg).toBeCloseTo(0.02, 6);
    expect(info.sign.neighborIndex).toBe(0); // Aries
  });

  it("does not flag a longitude mid-sign", () => {
    const info = cuspInfo(15);
    expect(info.sign.near).toBe(false);
    expect(info.nakshatra.near).toBe(false);
    expect(info.any).toBe(false);
  });
});

describe("cuspInfo — nakshatra and pada boundaries", () => {
  it("flags proximity to a nakshatra boundary", () => {
    const info = cuspInfo(NAKSHATRA_SPAN - 0.02); // end of Ashwini
    expect(info.nakshatra.near).toBe(true);
    expect(info.nakshatra.distanceDeg).toBeCloseTo(0.02, 6);
    expect(info.nakshatra.neighborIndex).toBe(1); // Bharani
  });

  it("flags proximity to a pada boundary and names the neighbouring pada", () => {
    const info = cuspInfo(PADA_SPAN - 0.01); // end of pada 1
    expect(info.pada.near).toBe(true);
    expect(info.pada.neighborIndex).toBe(2);
  });

  it("wraps nakshatra index across 0° (Revati → Ashwini)", () => {
    const info = cuspInfo(0.02); // just past 0° Aries = start of Ashwini
    expect(info.nakshatra.near).toBe(true);
    expect(info.nakshatra.neighborIndex).toBe(26); // Revati is behind
  });
});

describe("cuspInfo — tolerance", () => {
  it("respects a custom tolerance", () => {
    expect(cuspInfo(29.8).sign.near).toBe(false); // 0.2° away, outside default 0.1°
    expect(cuspInfo(29.8, 0.5).sign.near).toBe(true); // inside a 0.5° window
  });

  it("uses ~6 arc-minutes by default", () => {
    expect(DEFAULT_CUSP_TOLERANCE).toBeCloseTo(0.1, 9);
  });

  it("reports the nearest boundary distance within half a cell", () => {
    // Distance to nearest boundary never exceeds half the cell width.
    for (let lon = 0; lon < 360; lon += 0.7) {
      const info = cuspInfo(lon);
      expect(info.sign.distanceDeg).toBeLessThanOrEqual(15 + 1e-9);
      expect(info.pada.distanceDeg).toBeLessThanOrEqual(PADA_SPAN / 2 + 1e-9);
    }
  });
});
