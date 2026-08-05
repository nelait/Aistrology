import { describe, it, expect } from "vitest";
import { computeChart } from "./engine";
import {
  planetReferences,
  yogaReferences,
  houseReferences,
  dashaReferences,
} from "./references";
import { detectYogas } from "./yogas";
import { BirthData } from "./types";
import { PlanetName } from "./constants";

const REFERENCE: BirthData = {
  name: "Reference",
  year: 1990, month: 1, day: 1, hour: 12, minute: 0, second: 0,
  tzOffsetHours: 5.5, latitude: 28.6139, longitude: 77.209,
  placeLabel: "New Delhi, India",
};

const chart = computeChart(REFERENCE);

describe("planetReferences", () => {
  it("returns facts and attributed references for every planet", () => {
    for (const p of chart.planets) {
      const g = planetReferences(chart, p);
      expect(g.facts.length).toBeGreaterThanOrEqual(3);
      expect(g.references.length).toBeGreaterThanOrEqual(1);
      for (const r of g.references) {
        expect(r.source.length).toBeGreaterThan(0);
        expect(r.text.length).toBeGreaterThan(10);
      }
    }
  });

  it("cites the exaltation rule for an exalted planet", () => {
    const exalted = chart.planets.find((p) => p.dignity === "Exalted");
    if (exalted) {
      const g = planetReferences(chart, exalted);
      expect(g.references.some((r) => /exaltation|uccha/i.test(r.text))).toBe(true);
    }
    // Mars in the reference chart is in its own sign (Scorpio) — check that path.
    const mars = chart.planets.find((p) => p.planet === "Mars")!;
    const gm = planetReferences(chart, mars);
    expect(gm.facts.some((f) => /karaka/.test(f))).toBe(true);
  });

  it("adds a kendra reference for a planet in an angular house", () => {
    const kendraPlanet = chart.planets.find((p) => [1, 4, 7, 10].includes(p.house));
    if (kendraPlanet) {
      const g = planetReferences(chart, kendraPlanet);
      expect(g.references.some((r) => /kendra/i.test(r.text))).toBe(true);
    }
  });
});

describe("yogaReferences", () => {
  it("provides a specific reference for each detected yoga", () => {
    const yogas = detectYogas(chart);
    for (const y of yogas) {
      const g = yogaReferences(y);
      expect(g.references.length).toBeGreaterThanOrEqual(1);
      expect(g.facts[0]).toContain(y.name);
    }
  });

  it("names the yoga's classical source", () => {
    const g = yogaReferences({
      name: "Gaja Kesari Yoga",
      category: "Benefic",
      planets: ["Jupiter", "Moon"],
      description: "Jupiter in a kendra from the Moon.",
      effect: "Fame and intelligence.",
    });
    expect(g.references[0].text).toMatch(/Gaja Kesari|Jupiter/);
  });
});

describe("houseReferences", () => {
  it("grounds every house with facts and references", () => {
    for (let h = 1; h <= 12; h++) {
      const g = houseReferences(chart, h);
      expect(g.facts.length).toBeGreaterThanOrEqual(3);
      expect(g.references.length).toBeGreaterThanOrEqual(2);
      expect(g.facts[0]).toContain(`${h === 1 ? "1st" : h === 2 ? "2nd" : h === 3 ? "3rd" : `${h}th`} house`);
    }
  });

  it("adds a dusthana reference for the 8th house", () => {
    const g = houseReferences(chart, 8);
    expect(g.references.some((r) => /dusthana/i.test(r.text))).toBe(true);
  });
});

describe("dashaReferences", () => {
  it("grounds each dasha lord with dignity and placement facts", () => {
    const lords: PlanetName[] = ["Sun", "Moon", "Mars", "Jupiter", "Saturn", "Venus", "Mercury", "Rahu", "Ketu"];
    for (const lord of lords) {
      const g = dashaReferences(chart, lord);
      expect(g.facts.some((f) => f.includes(lord))).toBe(true);
      expect(g.references.some((r) => /dasha/i.test(r.text))).toBe(true);
    }
  });
});
