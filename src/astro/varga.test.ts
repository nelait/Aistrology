import { describe, it, expect } from "vitest";
import { divisionalSign, VARGAS, VARGA_BY_CODE, Varga } from "./varga";
import { norm360 } from "./math";

describe("divisionalSign — classical placements", () => {
  // [longitude, varga, expected 0-based sign]
  const cases: [number, Varga, number][] = [
    // D1: the sign itself.
    [45, "D1", 1], // Taurus 15°
    [359, "D1", 11], // Pisces

    // D2 Hora: odd rashi -> Leo(4)/Cancer(3); even rashi -> Cancer(3)/Leo(4).
    [5, "D2", 4], // Aries first half -> Leo
    [20, "D2", 3], // Aries second half -> Cancer
    [35, "D2", 3], // Taurus first half -> Cancer
    [50, "D2", 4], // Taurus second half -> Leo

    // D3 Drekkana: 1st/2nd/3rd third -> self / 5th / 9th.
    [5, "D3", 0], // Aries 1st -> Aries
    [15, "D3", 4], // Aries 2nd -> Leo
    [25, "D3", 8], // Aries 3rd -> Sagittarius
    [45, "D3", 5], // Taurus 2nd -> Virgo (5th)

    // D7 Saptamsha: odd from self, even from 7th.
    [30, "D7", 7], // Taurus part 0 -> Scorpio (7th)
    [35, "D7", 8], // Taurus part 1 -> Sagittarius

    // D9 Navamsa.
    [4, "D9", 1], // Aries part 1 -> Taurus
    [30, "D9", 9], // Taurus (fixed) -> from Capricorn
    [60, "D9", 6], // Gemini (dual) -> from Libra

    // D10 Dashamsha: odd from self, even from 9th.
    [3, "D10", 1], // Aries part 1 -> Taurus
    [30, "D10", 9], // Taurus part 0 -> Capricorn (9th)
    [33, "D10", 10], // Taurus part 1 -> Aquarius

    // D12 Dwadashamsha: from the sign itself, 2.5° steps.
    [2.5, "D12", 1], // Aries part 1 -> Taurus
    [32.5, "D12", 2], // Taurus part 1 -> Gemini
  ];

  for (const [lon, varga, expected] of cases) {
    it(`${varga} at ${lon}° -> sign ${expected}`, () => {
      expect(divisionalSign(lon, varga)).toBe(expected);
    });
  }
});

describe("divisionalSign — invariants", () => {
  const vargas = VARGAS.map((v) => v.code);

  it("always returns a valid 0..11 sign across a full sweep", () => {
    for (let lon = 0; lon < 360; lon += 0.37) {
      for (const v of vargas) {
        const s = divisionalSign(lon, v);
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(12);
      }
    }
  });

  it("normalises out-of-range longitudes", () => {
    expect(divisionalSign(370, "D1")).toBe(divisionalSign(10, "D1"));
    expect(divisionalSign(-10, "D9")).toBe(divisionalSign(350, "D9"));
  });

  it("D9 matches the continuous 108-navamsa formula (engine equivalence)", () => {
    // The engine previously derived navamsaSign as floor(lon / (360/108)) % 12.
    // This guards that the classical rule stays identical to that derivation.
    for (let lon = 0; lon < 360; lon += 0.13) {
      const continuous = Math.floor(norm360(lon) / (360 / 108)) % 12;
      expect(divisionalSign(lon, "D9")).toBe(continuous);
    }
  });
});

describe("varga metadata", () => {
  it("indexes every varga by its code with matching division", () => {
    for (const v of VARGAS) {
      expect(VARGA_BY_CODE[v.code]).toBe(v);
      expect(v.division).toBe(Number(v.code.slice(1)));
    }
  });
});
