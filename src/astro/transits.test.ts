import { describe, it, expect } from "vitest";
import { computeChart, birthDateUT } from "./engine";
import { computeTransits, sadeSati, TransitPosition } from "./transits";
import { BirthData } from "./types";
import { PlanetName } from "./constants";

const REFERENCE: BirthData = {
  name: "Reference",
  year: 1990,
  month: 1,
  day: 1,
  hour: 12,
  minute: 0,
  second: 0,
  tzOffsetHours: 5.5,
  latitude: 28.6139,
  longitude: 77.209,
  placeLabel: "New Delhi, India",
};

describe("computeTransits — cross-check against the natal engine", () => {
  const natal = computeChart(REFERENCE);
  const atBirth = computeTransits(natal, birthDateUT(REFERENCE));
  const byName = Object.fromEntries(atBirth.map((t) => [t.planet, t])) as Record<
    PlanetName,
    TransitPosition
  >;

  it("reproduces natal longitudes when the transit date is the birth instant", () => {
    for (const p of natal.planets) {
      expect(byName[p.planet].longitude).toBeCloseTo(p.longitude, 4);
      expect(byName[p.planet].signIndex).toBe(p.signIndex);
    }
  });

  it("puts the transiting Moon in the 1st from the natal Moon at birth", () => {
    expect(byName.Moon.houseFromMoon).toBe(1);
  });

  it("keeps every transit house-from-Moon and house-from-Lagna in 1..12", () => {
    for (const t of atBirth) {
      expect(t.houseFromMoon).toBeGreaterThanOrEqual(1);
      expect(t.houseFromMoon).toBeLessThanOrEqual(12);
      expect(t.houseFromLagna).toBeGreaterThanOrEqual(1);
      expect(t.houseFromLagna).toBeLessThanOrEqual(12);
    }
  });

  it("classifies gochara by the classical house-from-Moon tables", () => {
    // Favourable house sets are asymmetric per planet; spot-check the rule holds.
    const favorable: Record<PlanetName, number[]> = {
      Sun: [3, 6, 10, 11],
      Moon: [1, 3, 6, 7, 10, 11],
      Mars: [3, 6, 11],
      Mercury: [2, 4, 6, 8, 10, 11],
      Jupiter: [2, 5, 7, 9, 11],
      Venus: [1, 2, 3, 4, 5, 8, 9, 11, 12],
      Saturn: [3, 6, 11],
      Rahu: [3, 6, 10, 11],
      Ketu: [3, 6, 10, 11],
    };
    for (const t of atBirth) {
      const expected = favorable[t.planet].includes(t.houseFromMoon)
        ? "Favorable"
        : "Challenging";
      expect(t.gochara).toBe(expected);
    }
  });

  it("moves the transiting Sun forward ~1°/day", () => {
    const oneDayLater = computeTransits(
      natal,
      new Date(birthDateUT(REFERENCE).getTime() + 24 * 3600 * 1000),
    );
    const sun0 = byName.Sun.longitude;
    const sun1 = oneDayLater.find((t) => t.planet === "Sun")!.longitude;
    let delta = sun1 - sun0;
    if (delta < -180) delta += 360;
    expect(delta).toBeGreaterThan(0.9);
    expect(delta).toBeLessThan(1.1);
  });
});

describe("sadeSati", () => {
  function withSaturnHouse(house: number): TransitPosition[] {
    // Minimal synthetic transit list — only Saturn's house-from-Moon matters.
    return [
      {
        planet: "Saturn",
        longitude: 0,
        signIndex: 0,
        degreeInSign: 0,
        nakshatraIndex: 0,
        retrograde: false,
        houseFromMoon: house,
        houseFromLagna: house,
        gochara: "Challenging",
      },
    ];
  }

  it("is active in the 12th, 1st and 2nd from the Moon", () => {
    expect(sadeSati(withSaturnHouse(12)).phase).toBe("Rising (12th)");
    expect(sadeSati(withSaturnHouse(1)).phase).toBe("Peak (1st)");
    expect(sadeSati(withSaturnHouse(2)).phase).toBe("Setting (2nd)");
    for (const h of [12, 1, 2]) {
      expect(sadeSati(withSaturnHouse(h)).active).toBe(true);
    }
  });

  it("is inactive elsewhere", () => {
    for (const h of [3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      const status = sadeSati(withSaturnHouse(h));
      expect(status.active).toBe(false);
      expect(status.phase).toBeUndefined();
    }
  });
});
