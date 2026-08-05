import { describe, it, expect } from "vitest";
import { computeChart } from "./engine";
import { BirthData } from "./types";
import { PlanetName } from "./constants";

// Reference: 1990-01-01, 12:00 IST (UT+5:30), New Delhi (28.6139N, 77.2090E).
// Expected sidereal (Lahiri) sign / nakshatra / pada cross-checked against
// standard Vedic software. Discrete placements are asserted exactly; longitudes
// are asserted loosely so a future refinement (e.g. a ΔT correction, which moves
// the Moon by <0.01°) does not spuriously break the suite.
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

interface Expected {
  sign: number; // 0 = Aries
  nakshatra: number; // 0 = Ashwini
  pada: number;
  retrograde: boolean;
  lon: number; // approximate sidereal longitude, degrees
}

// Sign / nakshatra / pada from cross-checked reference output.
const EXPECTED: Record<PlanetName, Expected> = {
  Sun: { sign: 8, nakshatra: 19, pada: 2, retrograde: false, lon: 256.87 },
  Moon: { sign: 10, nakshatra: 22, pada: 4, retrograde: false, lon: 306.46 },
  Mars: { sign: 7, nakshatra: 16, pada: 4, retrograde: false, lon: 226.14 },
  Mercury: { sign: 9, nakshatra: 20, pada: 2, retrograde: true, lon: 272.02 },
  Jupiter: { sign: 2, nakshatra: 5, pada: 2, retrograde: true, lon: 71.53 },
  Venus: { sign: 9, nakshatra: 21, pada: 1, retrograde: true, lon: 282.54 },
  Saturn: { sign: 8, nakshatra: 19, pada: 3, retrograde: false, lon: 261.87 },
  Rahu: { sign: 9, nakshatra: 22, pada: 1, retrograde: true, lon: 294.73 },
  Ketu: { sign: 3, nakshatra: 8, pada: 3, retrograde: true, lon: 114.73 },
};

describe("computeChart — reference chart (New Delhi, 1990-01-01 12:00 IST)", () => {
  const chart = computeChart(REFERENCE);
  const byName = Object.fromEntries(chart.planets.map((p) => [p.planet, p]));

  it("has a Lahiri ayanamsa of ~23°43' for 1990", () => {
    expect(chart.ayanamsa).toBeGreaterThan(23.6);
    expect(chart.ayanamsa).toBeLessThan(23.8);
  });

  it("places the Ascendant in Pisces", () => {
    expect(chart.ascendantSign).toBe(11);
  });

  for (const [name, exp] of Object.entries(EXPECTED) as [PlanetName, Expected][]) {
    describe(name, () => {
      const p = byName[name];
      it("is in the expected sign", () => expect(p.signIndex).toBe(exp.sign));
      it("is in the expected nakshatra", () =>
        expect(p.nakshatraIndex).toBe(exp.nakshatra));
      it("is in the expected pada", () => expect(p.pada).toBe(exp.pada));
      it("has the expected retrograde state", () =>
        expect(p.retrograde).toBe(exp.retrograde));
      it("has a longitude close to the reference", () =>
        expect(p.longitude).toBeCloseTo(exp.lon, 0)); // within ~0.5°
    });
  }
});

describe("computeChart — invariants", () => {
  const chart = computeChart(REFERENCE);
  const byName = Object.fromEntries(chart.planets.map((p) => [p.planet, p]));

  it("keeps every planet in a valid sign, house and pada", () => {
    for (const p of chart.planets) {
      expect(p.signIndex).toBeGreaterThanOrEqual(0);
      expect(p.signIndex).toBeLessThan(12);
      expect(p.house).toBeGreaterThanOrEqual(1);
      expect(p.house).toBeLessThanOrEqual(12);
      expect(p.pada).toBeGreaterThanOrEqual(1);
      expect(p.pada).toBeLessThanOrEqual(4);
      expect(p.nakshatraIndex).toBeGreaterThanOrEqual(0);
      expect(p.nakshatraIndex).toBeLessThan(27);
    }
  });

  it("keeps Rahu and Ketu exactly 180° apart", () => {
    const sep =
      (((byName.Rahu.longitude - byName.Ketu.longitude) % 360) + 360) % 360;
    expect(sep).toBeCloseTo(180, 9);
  });

  it("assigns house 1 to the ascendant's sign under whole-sign houses", () => {
    expect(chart.houseSigns[0]).toBe(chart.ascendantSign);
    for (let h = 0; h < 12; h++) {
      expect(chart.houseSigns[h]).toBe((chart.ascendantSign + h) % 12);
    }
  });

  it("derives each planet's house consistently from its sign", () => {
    for (const p of chart.planets) {
      const expectedHouse = ((p.signIndex - chart.ascendantSign + 12) % 12) + 1;
      expect(p.house).toBe(expectedHouse);
    }
  });
});

describe("computeChart — ayanamsa and node options", () => {
  it("defaults to Lahiri ayanamsa and the mean node", () => {
    const chart = computeChart(REFERENCE);
    expect(chart.ayanamsaSystem).toBe("Lahiri");
    expect(chart.nodeType).toBe("mean");
  });

  it("shifts every sidereal longitude by the ayanamsa difference", () => {
    const lahiri = computeChart(REFERENCE, { ayanamsa: "Lahiri" });
    const raman = computeChart(REFERENCE, { ayanamsa: "Raman" });
    // Raman's smaller ayanamsa -> larger sidereal longitudes by a constant
    // offset (Lahiri.j2000 − Raman.j2000 ≈ 1.447°).
    const offset = 23.85293 - 22.40552;
    const l = Object.fromEntries(lahiri.planets.map((p) => [p.planet, p.longitude]));
    for (const p of raman.planets) {
      const diff = ((p.longitude - l[p.planet]) % 360 + 360) % 360;
      expect(diff).toBeCloseTo(offset, 3);
    }
    expect(raman.ayanamsaSystem).toBe("Raman");
  });

  it("uses the true node when asked, close to but not equal to the mean node", () => {
    const mean = computeChart(REFERENCE, { nodeType: "mean" });
    const tru = computeChart(REFERENCE, { nodeType: "true" });
    const meanRahu = mean.planets.find((p) => p.planet === "Rahu")!.longitude;
    const trueRahu = tru.planets.find((p) => p.planet === "Rahu")!.longitude;
    let diff = ((trueRahu - meanRahu + 540) % 360) - 180;
    expect(Math.abs(diff)).toBeGreaterThan(0); // genuinely different
    expect(Math.abs(diff)).toBeLessThan(1.9); // but within the oscillation band
    expect(tru.nodeType).toBe("true");

    // Rahu and Ketu stay opposite under the true node too.
    const trueKetu = tru.planets.find((p) => p.planet === "Ketu")!.longitude;
    const sep = ((trueRahu - trueKetu) % 360 + 360) % 360;
    expect(Math.abs(sep - 180)).toBeLessThan(1e-9);
  });
});
