import { describe, it, expect } from "vitest";
import { analyseVastu, type VastuQuestionnaire } from "./vastu";
import { computeChart } from "./engine";
import type { BirthData } from "./types";

const TEST_BIRTH: BirthData = {
  name: "Test",
  year: 1990,
  month: 1,
  day: 15,
  hour: 6,
  minute: 0,
  second: 0,
  tzOffsetHours: 5.5,
  latitude: 13.0827,
  longitude: 80.2707,
  placeLabel: "Chennai",
};

/** A perfectly Vastu-compliant property. */
const GOOD_PROPERTY: VastuQuestionnaire = {
  facingDirection: "E",
  entrancePosition: "NE",
  kitchenLocation: "SE",
  masterBedroom: "SW",
  bathroomLocation: "NW",
  waterSource: "NE",
  staircasePosition: "SW",
  poojaRoom: "NE",
  gardenOrOpenSpace: "N",
  garage: "NW",
  plotShape: "square",
  landSlope: "NE",
};

/** A property with several Vastu violations. */
const BAD_PROPERTY: VastuQuestionnaire = {
  facingDirection: "SW",
  entrancePosition: "SW",
  kitchenLocation: "NE",
  masterBedroom: "NE",
  bathroomLocation: "NE",
  waterSource: "SW",
  staircasePosition: "NE",
  poojaRoom: "SW",
  gardenOrOpenSpace: "SW",
  garage: "NE",
  plotShape: "irregular",
  landSlope: "SW",
};

describe("Vastu analysis", () => {
  const chart = computeChart(TEST_BIRTH);

  it("returns a scored result with all expected sections", () => {
    const r = analyseVastu(chart, GOOD_PROPERTY);
    expect(r.overallScore).toBeGreaterThanOrEqual(0);
    expect(r.overallScore).toBeLessThanOrEqual(100);
    expect(r.overallVerdict).toBeTruthy();
    expect(r.roomFactors.length).toBeGreaterThan(0);
    expect(r.astroFactors.length).toBeGreaterThan(0);
  });

  it("gives a high score for a Vastu-compliant property", () => {
    const r = analyseVastu(chart, GOOD_PROPERTY);
    expect(r.overallScore).toBeGreaterThanOrEqual(60);
    // Most room factors should be 'good'
    const goodCount = r.roomFactors.filter((f) => f.severity === "good").length;
    expect(goodCount).toBeGreaterThan(r.roomFactors.length / 2);
  });

  it("gives a low score for a Vastu-violated property", () => {
    const r = analyseVastu(chart, BAD_PROPERTY);
    expect(r.overallScore).toBeLessThan(60);
    // Should produce remedies
    expect(r.topRemedies.length).toBeGreaterThan(0);
  });

  it("provides remedies for problem areas", () => {
    const r = analyseVastu(chart, BAD_PROPERTY);
    const withRemedies = r.roomFactors.filter((f) => f.remedy);
    expect(withRemedies.length).toBeGreaterThan(0);
    for (const f of withRemedies) {
      expect(f.remedy!.length).toBeGreaterThan(10);
    }
  });

  it("analyses all room areas", () => {
    const r = analyseVastu(chart, GOOD_PROPERTY);
    const areas = r.roomFactors.map((f) => f.area);
    expect(areas).toContain("Kitchen");
    expect(areas).toContain("Master Bedroom");
    expect(areas).toContain("Bathroom");
    expect(areas).toContain("Main Entrance");
    expect(areas).toContain("Pooja Room");
    expect(areas).toContain("Plot Shape");
    expect(areas).toContain("Land Slope");
    expect(areas).toContain("Property Facing");
  });

  it("includes astrological factors", () => {
    const r = analyseVastu(chart, GOOD_PROPERTY);
    const factorNames = r.astroFactors.map((f) => f.factor);
    expect(factorNames).toContain("Lagna Direction Compatibility");
    expect(factorNames).toContain("4th House Lord (Property House)");
    // Mars and Venus factors depend on chart planets — at least one should be present
    const hasMarOrVen = factorNames.some((n) => n.includes("Mars") || n.includes("Venus"));
    expect(hasMarOrVen).toBe(true);
  });

  it("each factor has valid score and severity", () => {
    const r = analyseVastu(chart, GOOD_PROPERTY);
    for (const f of [...r.roomFactors, ...r.astroFactors]) {
      expect(f.score).toBeGreaterThanOrEqual(0);
      expect(f.score).toBeLessThanOrEqual(10);
      expect(["good", "moderate", "bad"]).toContain(f.severity);
    }
  });
});
