import { describe, it, expect } from "vitest";
import { ayanamsaValue, AYANAMSAS, AYANAMSA_BY_CODE, Ayanamsa } from "./ayanamsa";
import { precessionSinceJ2000 } from "./obliquity";

const J2000 = 2451545.0;
const codes = AYANAMSAS.map((a) => a.code);

describe("ayanamsaValue", () => {
  it("equals each system's J2000 offset at J2000.0", () => {
    for (const a of AYANAMSAS) {
      expect(ayanamsaValue(J2000, a.code)).toBeCloseTo(a.j2000, 9);
    }
  });

  it("grows with the shared precession rate", () => {
    const jd = J2000 + 36525; // one century later
    for (const a of AYANAMSAS) {
      expect(ayanamsaValue(jd, a.code) - a.j2000).toBeCloseTo(
        precessionSinceJ2000(jd),
        9,
      );
    }
  });

  it("keeps the difference between any two systems constant over time", () => {
    const diffAt = (jd: number, x: Ayanamsa, y: Ayanamsa) =>
      ayanamsaValue(jd, x) - ayanamsaValue(jd, y);
    const d1 = diffAt(J2000, "Lahiri", "Raman");
    const d2 = diffAt(J2000 + 50000, "Lahiri", "Raman");
    expect(d1).toBeCloseTo(d2, 9);
  });

  it("orders Raman < KP < Lahiri < Fagan–Bradley at a modern date", () => {
    const jd = 2451545 + 9000; // ~2024
    expect(ayanamsaValue(jd, "Raman")).toBeLessThan(ayanamsaValue(jd, "KP"));
    expect(ayanamsaValue(jd, "KP")).toBeLessThan(ayanamsaValue(jd, "Lahiri"));
    expect(ayanamsaValue(jd, "Lahiri")).toBeLessThan(
      ayanamsaValue(jd, "FaganBradley"),
    );
  });

  it("defaults to Lahiri", () => {
    expect(ayanamsaValue(J2000)).toBeCloseTo(AYANAMSA_BY_CODE.Lahiri.j2000, 9);
  });

  it("indexes every system by code", () => {
    for (const c of codes) expect(AYANAMSA_BY_CODE[c].code).toBe(c);
  });
});
