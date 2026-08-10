import { describe, it, expect } from "vitest";
import {
  CELEBRITIES, CELEBRITY_REGIONS, celebrityToBirth, searchCelebrities,
} from "./celebrities";
import { computeChart } from "../astro/engine";

describe("celebrity dataset — integrity", () => {
  it("has the expected size and regional split", () => {
    expect(CELEBRITIES).toHaveLength(50);
    const by = (r: string) => CELEBRITIES.filter((c) => c.region === r).length;
    expect(by("South India")).toBe(20);
    expect(by("North India")).toBe(20);
    expect(by("United States")).toBe(10);
  });

  it("has no duplicate names", () => {
    const names = CELEBRITIES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps every coordinate inside valid bounds", () => {
    // The source table carried longitude -942 for one entry; this is the guard
    // that would have caught it.
    for (const c of CELEBRITIES) {
      expect(c.latitude, `${c.name} latitude`).toBeGreaterThanOrEqual(-90);
      expect(c.latitude, `${c.name} latitude`).toBeLessThanOrEqual(90);
      expect(c.longitude, `${c.name} longitude`).toBeGreaterThanOrEqual(-180);
      expect(c.longitude, `${c.name} longitude`).toBeLessThanOrEqual(180);
    }
  });

  it("puts each entry's coordinates in the right hemisphere for its region", () => {
    for (const c of CELEBRITIES) {
      if (c.region === "United States") {
        expect(c.longitude, `${c.name} should be western`).toBeLessThan(0);
      } else {
        expect(c.longitude, `${c.name} should be eastern`).toBeGreaterThan(0);
        expect(c.latitude, `${c.name} should be northern`).toBeGreaterThan(0);
      }
    }
  });

  it("has a real calendar date for everyone", () => {
    for (const c of CELEBRITIES) {
      expect(c.month).toBeGreaterThanOrEqual(1);
      expect(c.month).toBeLessThanOrEqual(12);
      expect(c.day).toBeGreaterThanOrEqual(1);
      expect(c.day).toBeLessThanOrEqual(31);
      expect(c.year).toBeGreaterThan(1700);
      expect(c.year).toBeLessThan(2020);
      // Round-trip through Date to reject impossible days (e.g. 31 February).
      const d = new Date(Date.UTC(c.year, c.month - 1, c.day));
      expect(d.getUTCFullYear()).toBe(c.year);
      expect(d.getUTCMonth() + 1).toBe(c.month);
      expect(d.getUTCDate()).toBe(c.day);
    }
  });

  it("declares a usable IANA zone for everyone", () => {
    for (const c of CELEBRITIES) {
      expect(c.zone).toMatch(/^[A-Za-z]+\/[A-Za-z_/-]+$/);
      expect(() =>
        new Intl.DateTimeFormat("en-GB", { timeZone: c.zone }),
      ).not.toThrow();
    }
  });

  it("labels every birth time as unknown (noon placeholder), so the UI can say so", () => {
    for (const c of CELEBRITIES) {
      expect(c.timeKnown).toBe(false);
      expect(c.hour).toBe(12);
      expect(c.minute).toBe(0);
    }
  });

  it("links every entry to Wikipedia", () => {
    for (const c of CELEBRITIES) {
      expect(c.wiki).toMatch(/^https:\/\/en\.wikipedia\.org\/wiki\/\S+$/);
    }
  });
});

describe("celebrityToBirth — timezone resolution", () => {
  it("produces a plausible UTC offset for every entry", () => {
    for (const c of CELEBRITIES) {
      const b = celebrityToBirth(c);
      expect(b.tzOffsetHours, `${c.name}`).toBeGreaterThanOrEqual(-12);
      expect(b.tzOffsetHours, `${c.name}`).toBeLessThanOrEqual(14);
      expect(Number.isFinite(b.tzOffsetHours)).toBe(true);
    }
  });

  it("resolves historical rules rather than assuming a fixed offset", () => {
    const at = (name: string) =>
      celebrityToBirth(CELEBRITIES.find((c) => c.name === name)!).tzOffsetHours;
    // Nov 1942 New York was on year-round "war time" (UTC-4), not EST (-5).
    expect(at("Martin Scorsese")).toBe(-4);
    // June 1949 New Jersey was on daylight time (-4).
    expect(at("Meryl Streep")).toBe(-4);
    // Hawaii has no DST.
    expect(at("Barack Obama")).toBe(-10);
    // Modern India is a flat +5:30.
    expect(at("Rajinikanth")).toBe(5.5);
  });

  it("carries the name and place through to the birth record", () => {
    const c = CELEBRITIES[0];
    const b = celebrityToBirth(c);
    expect(b.name).toBe(c.name);
    expect(b.placeLabel).toBe(c.placeLabel);
    expect(b.latitude).toBe(c.latitude);
    expect(b.longitude).toBe(c.longitude);
  });
});

describe("celebrity charts — every entry actually casts", () => {
  it("computes a valid chart for all 50 without throwing", () => {
    for (const c of CELEBRITIES) {
      const chart = computeChart(celebrityToBirth(c));
      expect(chart.ascendantSign, `${c.name} ascendant`).toBeGreaterThanOrEqual(0);
      expect(chart.ascendantSign).toBeLessThan(12);
      expect(chart.planets).toHaveLength(9);
      for (const p of chart.planets) {
        expect(Number.isFinite(p.longitude), `${c.name} ${p.planet}`).toBe(true);
        expect(p.signIndex).toBeGreaterThanOrEqual(0);
        expect(p.signIndex).toBeLessThan(12);
        expect(p.house).toBeGreaterThanOrEqual(1);
        expect(p.house).toBeLessThanOrEqual(12);
      }
    }
  });
});

describe("searchCelebrities", () => {
  it("returns everyone for an empty query", () => {
    expect(searchCelebrities("")).toHaveLength(CELEBRITIES.length);
  });

  it("matches on name, place and field, case-insensitively", () => {
    expect(searchCelebrities("rajini").map((c) => c.name)).toContain("Rajinikanth");
    expect(searchCelebrities("kerala").length).toBeGreaterThan(0);
    expect(searchCelebrities("POLITICS").length).toBeGreaterThan(0);
  });

  it("filters by region, and combines region with a query", () => {
    for (const r of CELEBRITY_REGIONS) {
      expect(searchCelebrities("", r).every((c) => c.region === r)).toBe(true);
    }
    const us = searchCelebrities("film", "United States");
    expect(us.length).toBeGreaterThan(0);
    expect(us.every((c) => c.region === "United States")).toBe(true);
  });

  it("returns nothing for a non-match", () => {
    expect(searchCelebrities("zzzzznotarealperson")).toHaveLength(0);
  });
});
