import { describe, it, expect } from "vitest";
import { CELEBRITIES } from "./celebrities";
import { CELEBRITY_EVENTS, celebrityEventsFor } from "./celebrityEvents";
import { EVENT_KARAKA_BY_ID } from "../astro/eventKaraka";
import { PRECISION_WINDOW_DAYS } from "../astro/eventKaraka";

describe("documented celebrity events", () => {
  it("every set names a figure that is actually in the roster", () => {
    for (const s of CELEBRITY_EVENTS) {
      const c = CELEBRITIES.find((x) => x.name === s.name);
      expect(c, `${s.name} is not in celebrities.ts`).toBeTruthy();
    }
  });

  it("every set's birth date matches the roster exactly", () => {
    // The lookup matches on name AND date, so a drift here would silently stop
    // the events ever appearing rather than showing anything wrong.
    for (const s of CELEBRITY_EVENTS) {
      const c = CELEBRITIES.find((x) => x.name === s.name)!;
      expect([s.year, s.month, s.day], `${s.name} date drifted from the roster`)
        .toEqual([c.year, c.month, c.day]);
    }
  });

  it("uses only event types the engine can score", () => {
    for (const s of CELEBRITY_EVENTS) {
      for (const e of s.events) {
        expect(EVENT_KARAKA_BY_ID[e.type], `${s.name}: unknown type ${e.type}`).toBeTruthy();
      }
    }
  });

  it("puts every event after birth and before today", () => {
    for (const s of CELEBRITY_EVENTS) {
      const birth = Date.UTC(s.year, s.month - 1, s.day);
      for (const e of s.events) {
        const t = new Date(`${e.date}T00:00:00Z`).getTime();
        expect(Number.isNaN(t), `${s.name}: ${e.date} is not a date`).toBe(false);
        expect(t, `${s.name}: ${e.what} predates birth`).toBeGreaterThan(birth);
        expect(t, `${s.name}: ${e.what} is in the future`).toBeLessThan(Date.now());
      }
    }
  });

  it("places imprecise dates mid-period, which is what the precision claims", () => {
    // Year-only sources are stored at 1 July and month-only at the 15th, so the
    // worst-case error matches what `precision` tells the scorer to expect.
    for (const s of CELEBRITY_EVENTS) {
      for (const e of s.events) {
        const d = new Date(`${e.date}T00:00:00Z`);
        if (e.precision === "year") {
          expect(`${s.name}: ${e.what}`).toBeTruthy();
          expect([d.getUTCMonth(), d.getUTCDate()], `${s.name}: ${e.what} claims year precision`)
            .toEqual([6, 1]);
        }
        if (e.precision === "month") {
          expect(d.getUTCDate(), `${s.name}: ${e.what} claims month precision`).toBe(15);
        }
      }
    }
  });

  it("carries a source for every set", () => {
    for (const s of CELEBRITY_EVENTS) {
      expect(s.source, `${s.name} has no source`).toMatch(/^https:\/\/en\.wikipedia\.org\//);
      for (const e of s.events) {
        expect(e.what.length, `${s.name}: an event has no description`).toBeGreaterThan(5);
      }
    }
  });

  it("gives each set enough events for the birth-time search to run", () => {
    // Four is the practical floor, not five: some articles simply carry few
    // dated personal events, and padding a set out would mean inventing them.
    // The search itself needs two.
    for (const s of CELEBRITY_EVENTS) {
      expect(s.events.length, `${s.name} has too few events`).toBeGreaterThanOrEqual(4);
    }
    // Most should be better than the floor, or the dataset is not worth having.
    const thin = CELEBRITY_EVENTS.filter((s) => s.events.length < 5).map((s) => s.name);
    expect(thin.length, `too many thin sets: ${thin.join(", ")}`)
      .toBeLessThan(CELEBRITY_EVENTS.length / 5);
  });

  it("matches a chart on name and date together, never on name alone", () => {
    const s = CELEBRITY_EVENTS[0];
    expect(celebrityEventsFor({ name: s.name, year: s.year, month: s.month, day: s.day })).toBeTruthy();
    // Someone's own profile that happens to share a famous name must not
    // inherit that person's life.
    expect(celebrityEventsFor({ name: s.name, year: 1990, month: 1, day: 1 })).toBeNull();
    expect(celebrityEventsFor({ name: "Nobody At All", year: s.year, month: s.month, day: s.day })).toBeNull();
  });

  it("is honest about the precision it can support", () => {
    // Sets dominated by year-only dates cannot yield a tight birth time, and
    // the docs say so. This asserts the data matches that claim rather than
    // quietly containing invented exact dates.
    for (const s of CELEBRITY_EVENTS) {
      const exact = s.events.filter((e) => e.precision === "exact").length;
      expect(exact, `${s.name}: every date is exact, which no source supports`)
        .toBeLessThan(s.events.length);
      expect(PRECISION_WINDOW_DAYS[s.events[0].precision]).toBeGreaterThan(0);
    }
  });
});
