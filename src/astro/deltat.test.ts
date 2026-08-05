import { describe, it, expect } from "vitest";
import { deltaTForYear, deltaTSeconds, decimalYear } from "./deltat";

describe("deltaTForYear — matches observed ΔT", () => {
  // Well-determined historical values (seconds). Tolerances reflect the fit's
  // documented few-second accuracy.
  const cases: [number, number, number][] = [
    // year, expected ΔT (s), tolerance (s)
    [1900, -2.8, 0.5],
    [1950, 29.1, 1.0],
    [1990, 56.9, 1.0],
    [2000, 63.8, 0.5],
  ];
  for (const [year, expected, tol] of cases) {
    it(`~${expected}s at ${year}`, () => {
      expect(deltaTForYear(year)).toBeCloseTo(expected, -Math.log10(2 * tol));
    });
  }
});

describe("deltaTForYear — shape", () => {
  it("is positive and growing across the modern era", () => {
    expect(deltaTForYear(1970)).toBeGreaterThan(0);
    expect(deltaTForYear(2000)).toBeGreaterThan(deltaTForYear(1970));
  });

  it("is continuous across the piecewise boundaries", () => {
    const boundaries = [
      1700, 1800, 1860, 1900, 1920, 1941, 1961, 1986, 2005, 2050,
    ];
    for (const b of boundaries) {
      const left = deltaTForYear(b - 1e-6);
      const right = deltaTForYear(b + 1e-6);
      // No branch should introduce a jump of more than a couple of seconds.
      expect(Math.abs(left - right)).toBeLessThan(2);
    }
  });
});

describe("deltaTSeconds — from Julian Day", () => {
  it("maps J2000.0 (JD 2451545.0) to the year-2000 value", () => {
    expect(decimalYear(2451545.0)).toBeCloseTo(2000, 6);
    expect(deltaTSeconds(2451545.0)).toBeCloseTo(deltaTForYear(2000), 6);
  });
});
