import { describe, it, expect } from "vitest";
import { computeChart } from "./engine";
import {
  computeAshtakavarga,
  binduInSign,
  binduStrength,
  savStrength,
  AV_PLANETS,
  CLASSICAL_BAV_TOTALS,
  CLASSICAL_SAV_TOTAL,
} from "./ashtakavarga";
import { BirthData } from "./types";

const BIRTH: BirthData = {
  name: "Test",
  year: 1985, month: 6, day: 12,
  hour: 10, minute: 30, second: 0,
  tzOffsetHours: 5.5,
  latitude: 17.385, longitude: 78.4867,
  placeLabel: "Hyderabad",
};

function chartFor(i: number) {
  return computeChart({
    ...BIRTH,
    year: 1930 + ((i * 7) % 90),
    month: 1 + ((i * 3) % 12),
    day: 1 + ((i * 11) % 28),
    hour: (i * 13) % 24,
    minute: (i * 29) % 60,
    latitude: -50 + ((i * 7) % 100),
    longitude: -170 + ((i * 23) % 340),
  });
}

describe("Ashtakavarga", () => {
  // The tables are the whole feature, and they carry their own proof: each
  // graha's benefic places sum to a total every classical text quotes, and the
  // seven totals sum to 337. A single typo anywhere breaks one of these, which
  // makes this the most valuable test in the file.
  it("reproduces the classical Bhinnashtakavarga totals for any chart", () => {
    for (let i = 0; i < 60; i++) {
      const av = computeAshtakavarga(chartFor(i));
      for (const b of av.bav) {
        expect(b.total, `${b.planet} totalled ${b.total} on chart ${i}`)
          .toBe(CLASSICAL_BAV_TOTALS[b.planet]);
      }
    }
  });

  it("reproduces the Sarvashtakavarga total of 337", () => {
    for (let i = 0; i < 60; i++) {
      const av = computeAshtakavarga(chartFor(i));
      expect(av.savTotal).toBe(CLASSICAL_SAV_TOTAL);
      expect(av.sav.reduce((s, v) => s + v, 0)).toBe(CLASSICAL_SAV_TOTAL);
    }
  });

  it("covers all seven grahas and excludes the nodes", () => {
    const av = computeAshtakavarga(computeChart(BIRTH));
    expect(av.bav.map((b) => b.planet)).toEqual(AV_PLANETS);
    expect(av.bav).toHaveLength(7);
    expect(binduInSign(av, "Rahu", 0)).toBeNull();
    expect(binduInSign(av, "Ketu", 0)).toBeNull();
  });

  it("gives every sign a plausible number of points", () => {
    for (let i = 0; i < 40; i++) {
      const av = computeAshtakavarga(chartFor(i));
      for (let s = 0; s < 12; s++) {
        // A sign can collect at most one point per contributor per graha.
        expect(av.sav[s]).toBeGreaterThanOrEqual(0);
        expect(av.sav[s]).toBeLessThanOrEqual(56);
        for (const b of av.bav) {
          expect(b.bindus[s]).toBeGreaterThanOrEqual(0);
          expect(b.bindus[s]).toBeLessThanOrEqual(8);
        }
      }
    }
  });

  it("actually varies between charts — it is not a constant table", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add(computeAshtakavarga(chartFor(i)).sav.join(","));
    expect(seen.size).toBeGreaterThan(30);
  });

  it("moves with the Lagna, which is what makes it birth-time sensitive", () => {
    // The Lagna is one of the eight contributors, so a chart cast two hours
    // later — a different rising sign, everything else near enough unchanged —
    // must redistribute the points.
    const morning = computeAshtakavarga(computeChart({ ...BIRTH, hour: 6, minute: 0 }));
    const later = computeAshtakavarga(computeChart({ ...BIRTH, hour: 8, minute: 30 }));
    expect(morning.sav.join(",")).not.toBe(later.sav.join(","));
    // …but the totals are invariant, because the tables are.
    expect(morning.savTotal).toBe(later.savTotal);
  });

  it("reads bindu counts the classical way", () => {
    expect(binduStrength(6)).toBe("strong");
    expect(binduStrength(5)).toBe("strong");
    expect(binduStrength(4)).toBe("average");
    expect(binduStrength(3)).toBe("weak");
    expect(binduStrength(0)).toBe("weak");
  });

  it("reads Sarvashtakavarga around the 28-point average", () => {
    // 337 over twelve signs averages 28.08, so the bands sit either side of it.
    expect(savStrength(34)).toBe("strong");
    expect(savStrength(30)).toBe("strong");
    expect(savStrength(28)).toBe("average");
    expect(savStrength(25)).toBe("average");
    expect(savStrength(22)).toBe("weak");
  });
});
