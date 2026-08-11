import { describe, it, expect } from "vitest";
import { divisionalSign, VARGAS, DISPLAYED_VARGAS, VARGA_BY_CODE, Varga } from "./varga";
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

describe("the finer vargas (D4, D16, D24, D30, D60)", () => {
  it("D4 puts the four quarters on the kendras from the sign", () => {
    // Aries 0-7°30' -> Aries, then Cancer, Libra, Capricorn.
    expect(divisionalSign(0, "D4")).toBe(0);
    expect(divisionalSign(8, "D4")).toBe(3);
    expect(divisionalSign(16, "D4")).toBe(6);
    expect(divisionalSign(23, "D4")).toBe(9);
  });

  it("D16 starts movable from Aries, fixed from Leo, dual from Sagittarius", () => {
    expect(divisionalSign(0, "D16")).toBe(0);        // Aries, movable
    expect(divisionalSign(120, "D16")).toBe(4);      // Leo, fixed
    expect(divisionalSign(60, "D16")).toBe(8);       // Gemini, dual
  });

  it("D24 starts odd signs from Leo and even signs from Cancer", () => {
    expect(divisionalSign(0, "D24")).toBe(4);        // Aries (odd) -> Leo
    expect(divisionalSign(30, "D24")).toBe(3);       // Taurus (even) -> Cancer
    expect(divisionalSign(1.3, "D24")).toBe(5);      // second part of Aries
  });

  it("D30 divides unequally and never lands on a luminary's sign", () => {
    // Odd sign order: Mars, Saturn, Jupiter, Mercury, Venus.
    expect(divisionalSign(2, "D30")).toBe(0);        // Aries 0-5 -> Mars/Aries
    expect(divisionalSign(7, "D30")).toBe(10);       // 5-10 -> Saturn/Aquarius
    expect(divisionalSign(14, "D30")).toBe(8);       // 10-18 -> Jupiter/Sagittarius
    expect(divisionalSign(20, "D30")).toBe(2);       // 18-25 -> Mercury/Gemini
    expect(divisionalSign(28, "D30")).toBe(6);       // 25-30 -> Venus/Libra
    // Even sign reverses the order.
    expect(divisionalSign(30 + 2, "D30")).toBe(1);   // Taurus 0-5 -> Venus/Taurus
    expect(divisionalSign(30 + 28, "D30")).toBe(7);  // 25-30 -> Mars/Scorpio

    // Cancer and Leo are owned by the Moon and Sun, which hold no trimsamsa.
    for (let lon = 0; lon < 360; lon += 0.25) {
      const d30 = divisionalSign(lon, "D30");
      expect(d30 === 3 || d30 === 4, `D30 gave a luminary sign at ${lon}°`).toBe(false);
    }
  });

  it("D60 changes every 30 arc-minutes — which is why it rectifies", () => {
    expect(divisionalSign(0, "D60")).toBe(0);
    expect(divisionalSign(0.49, "D60")).toBe(0);
    expect(divisionalSign(0.51, "D60")).toBe(1);
    expect(divisionalSign(1.01, "D60")).toBe(2);
    // 24 changes across one sign: 60 parts cycling through 12 signs.
    let changes = 0;
    let prev = divisionalSign(0, "D60");
    for (let d = 0.01; d < 30; d += 0.01) {
      const cur = divisionalSign(d, "D60");
      if (cur !== prev) changes++;
      prev = cur;
    }
    expect(changes).toBe(59);
  });

  it("every varga returns a valid sign for any longitude", () => {
    for (const v of VARGAS) {
      for (let lon = 0; lon < 360; lon += 0.37) {
        const sign = divisionalSign(lon, v.code);
        expect(Number.isInteger(sign), `${v.code} gave ${sign} at ${lon}°`).toBe(true);
        expect(sign).toBeGreaterThanOrEqual(0);
        expect(sign).toBeLessThanOrEqual(11);
      }
    }
  });

  it("only the classic seven are offered in the chart toggle", () => {
    expect(DISPLAYED_VARGAS.map((v) => v.code)).toEqual(["D1", "D2", "D3", "D7", "D9", "D10", "D12"]);
    // …but every varga has the metadata needed to be surfaced later.
    for (const v of VARGAS) {
      expect(v.label.length, `${v.code} has no label`).toBeGreaterThan(0);
      expect(v.about.length, `${v.code} has no explanation`).toBeGreaterThan(60);
    }
  });
});
