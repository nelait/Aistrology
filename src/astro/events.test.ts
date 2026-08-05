import { describe, it, expect } from "vitest";
import { computeChart, birthDateUT } from "./engine";
import { importantEvents } from "./events";
import { BirthData } from "./types";

const REFERENCE: BirthData = {
  name: "Reference",
  year: 1990, month: 1, day: 1, hour: 12, minute: 0, second: 0,
  tzOffsetHours: 5.5, latitude: 28.6139, longitude: 77.209,
  placeLabel: "New Delhi, India",
};

const chart = computeChart(REFERENCE);
const birth = birthDateUT(REFERENCE);
const YEAR_MS = 365.2422 * 86_400_000;
const events = importantEvents(chart, { spanYears: 90 });

describe("importantEvents — structure", () => {
  it("returns a non-empty, chronologically sorted list", () => {
    expect(events.length).toBeGreaterThan(5);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].date.getTime()).toBeGreaterThanOrEqual(events[i - 1].date.getTime());
    }
  });

  it("stays within the requested window", () => {
    for (const e of events) {
      expect(e.date.getTime()).toBeGreaterThanOrEqual(birth.getTime() - 1000);
      expect(e.date.getTime()).toBeLessThanOrEqual(birth.getTime() + 90 * YEAR_MS + 1000);
    }
  });

  it("includes each category", () => {
    const cats = new Set(events.map((e) => e.category));
    expect(cats.has("Dasha")).toBe(true);
    expect(cats.has("Saturn")).toBe(true);
    expect(cats.has("Jupiter")).toBe(true);
    expect(cats.has("Nodes")).toBe(true);
  });
});

describe("importantEvents — astronomical spacing", () => {
  it("places Saturn returns near multiples of ~29.5 years", () => {
    const sat = events.filter((e) => e.category === "Saturn");
    expect(sat.length).toBeGreaterThanOrEqual(2);
    for (const e of sat) {
      const k = Math.round(e.ageYears / 29.46);
      expect(Math.abs(e.ageYears - k * 29.46)).toBeLessThan(2);
    }
  });

  it("places Jupiter returns near multiples of ~11.86 years", () => {
    const jup = events.filter((e) => e.category === "Jupiter");
    expect(jup.length).toBeGreaterThanOrEqual(4);
    for (const e of jup) {
      const k = Math.round(e.ageYears / 11.86);
      expect(Math.abs(e.ageYears - k * 11.86)).toBeLessThan(1.5);
    }
  });

  it("places nodal returns near multiples of ~18.6 years", () => {
    const nodes = events.filter((e) => e.category === "Nodes");
    expect(nodes.length).toBeGreaterThanOrEqual(2);
    for (const e of nodes) {
      const k = Math.round(e.ageYears / 18.6);
      expect(Math.abs(e.ageYears - k * 18.6)).toBeLessThan(2);
    }
  });

  it("gives Sade Sati windows a ~7½-year span when present", () => {
    for (const e of events.filter((x) => x.category === "Sade Sati")) {
      expect(e.endDate).toBeDefined();
      const years = (e.endDate!.getTime() - e.date.getTime()) / YEAR_MS;
      expect(years).toBeGreaterThan(6);
      expect(years).toBeLessThan(9);
    }
  });
});
