import { describe, it, expect } from "vitest";
import { computeVimshottari, activePeriod } from "./dasha";
import {
  VIMSHOTTARI_ORDER,
  VIMSHOTTARI_YEARS,
  NAKSHATRA_SPAN,
  PlanetName,
} from "./constants";

const BIRTH = new Date(Date.UTC(1990, 0, 1, 6, 30)); // arbitrary birth instant

/** Position (0..8) of a lord in the Vimshottari cycle. */
function cyclePos(lord: PlanetName): number {
  return VIMSHOTTARI_ORDER.indexOf(lord);
}

/** Moon longitude that lands `fraction` of the way through nakshatra `nak`. */
function moonInNakshatra(nak: number, fraction: number): number {
  return (nak + fraction) * NAKSHATRA_SPAN;
}

describe("Vimshottari — sequence integrity", () => {
  it("full-cycle durations sum to 120 years", () => {
    const total = VIMSHOTTARI_ORDER.reduce(
      (s, lord) => s + VIMSHOTTARI_YEARS[lord],
      0,
    );
    expect(total).toBe(120);
  });

  it("starts with the nakshatra lord of the Moon", () => {
    // Dhanishta (index 22) -> ORDER[22 % 9] = ORDER[4] = Mars.
    const periods = computeVimshottari(moonInNakshatra(22, 0.5), BIRTH, 40);
    expect(periods[0].lord).toBe("Mars");
  });

  it("emits lords in strict cyclic order for a > 120-year span (regression)", () => {
    // Regression guard for the bug where the timeline restarted at Ketu after
    // the first cycle instead of continuing from the starting lord.
    const periods = computeVimshottari(moonInNakshatra(22, 0.5), BIRTH, 200);
    for (let i = 1; i < periods.length; i++) {
      const prev = cyclePos(periods[i - 1].lord);
      const cur = cyclePos(periods[i].lord);
      expect(cur).toBe((prev + 1) % 9);
    }
  });

  it("continues correctly across the first-cycle boundary at year ~120", () => {
    // Moon early in a nakshatra -> a near-full first Mahadasha balance, so the
    // 10th period lands just past 120 years and must be the starting lord again.
    const periods = computeVimshottari(moonInNakshatra(22, 0.01), BIRTH, 130);
    expect(periods[0].lord).toBe("Mars");
    // ORDER from Mars: Mars, Rahu, Jupiter, Saturn, Mercury, Ketu, Venus, Sun,
    // Moon, [Mars again].
    expect(periods[9].lord).toBe("Mars");
  });
});

describe("Vimshottari — timing", () => {
  it("produces a positive-length, shortened first balance period", () => {
    // 90% through the nakshatra -> 10% of Mars' 7 years remain (~0.7y).
    const periods = computeVimshottari(moonInNakshatra(22, 0.9), BIRTH, 40);
    const first = periods[0];
    const years =
      (first.end.getTime() - first.start.getTime()) /
      (365.25636 * 24 * 3600 * 1000);
    expect(first.end.getTime()).toBeGreaterThan(first.start.getTime());
    expect(years).toBeCloseTo(0.7, 1);
  });

  it("starts the first period exactly at birth", () => {
    const periods = computeVimshottari(moonInNakshatra(22, 0.3), BIRTH, 40);
    expect(periods[0].start.getTime()).toBe(BIRTH.getTime());
  });

  it("is contiguous — each period starts where the previous ended", () => {
    const periods = computeVimshottari(moonInNakshatra(5, 0.42), BIRTH, 120);
    for (let i = 1; i < periods.length; i++) {
      expect(periods[i].start.getTime()).toBe(periods[i - 1].end.getTime());
    }
  });

  it("covers a full 120-year cycle back to the starting lord", () => {
    const periods = computeVimshottari(moonInNakshatra(22, 0.5), BIRTH, 120);
    const span =
      (periods[periods.length - 1].end.getTime() - periods[0].start.getTime()) /
      (365.25636 * 24 * 3600 * 1000);
    expect(span).toBeGreaterThanOrEqual(120);
  });
});

describe("Vimshottari — antardashas", () => {
  const periods = computeVimshottari(moonInNakshatra(10, 0.4), BIRTH, 120);

  it("gives every Mahadasha a set of sub-periods", () => {
    for (const maha of periods) {
      expect(maha.children && maha.children.length).toBeGreaterThan(0);
    }
  });

  it("clips the running (birth) Mahadasha's antardashas to start at birth", () => {
    const first = periods[0];
    expect(first.children![0].start.getTime()).toBe(first.start.getTime());
  });

  it("ends each Mahadasha's last antardasha at the Mahadasha's end", () => {
    // Use a full (non-partial) Mahadasha — the second one.
    const maha = periods[1];
    const kids = maha.children!;
    expect(kids[kids.length - 1].end.getTime()).toBe(maha.end.getTime());
  });

  it("orders antardashas cyclically from the Mahadasha lord", () => {
    const maha = periods[1];
    const kids = maha.children!;
    expect(kids[0].lord).toBe(maha.lord);
    for (let i = 1; i < kids.length; i++) {
      const prev = cyclePos(kids[i - 1].lord);
      const cur = cyclePos(kids[i].lord);
      expect(cur).toBe((prev + 1) % 9);
    }
  });
});

describe("Vimshottari — pratyantardashas (level 3)", () => {
  const periods = computeVimshottari(moonInNakshatra(10, 0.4), BIRTH, 120);

  it("nests pratyantardashas at level 3 under each antardasha by default", () => {
    const antar = periods[1].children![2];
    expect(antar.level).toBe(2);
    expect(antar.children && antar.children.length).toBe(9);
    for (const praty of antar.children!) {
      expect(praty.level).toBe(3);
      expect(praty.children).toBeUndefined(); // no deeper nesting
    }
  });

  it("starts each antardasha's pratyantardashas with the antardasha lord", () => {
    const antar = periods[1].children![3];
    expect(antar.children![0].lord).toBe(antar.lord);
  });

  it("orders pratyantardashas cyclically and spans the whole antardasha", () => {
    const antar = periods[1].children![1];
    const kids = antar.children!;
    expect(kids[0].start.getTime()).toBe(antar.start.getTime());
    expect(kids[kids.length - 1].end.getTime()).toBe(antar.end.getTime());
    for (let i = 1; i < kids.length; i++) {
      expect(kids[i].start.getTime()).toBe(kids[i - 1].end.getTime());
      const prev = cyclePos(kids[i - 1].lord);
      expect(cyclePos(kids[i].lord)).toBe((prev + 1) % 9);
    }
  });

  it("clips the running pratyantardasha of the birth antardasha to birth", () => {
    const firstMaha = periods[0];
    const firstAntar = firstMaha.children![0];
    expect(firstAntar.start.getTime()).toBe(BIRTH.getTime());
    // Its first surviving pratyantardasha also starts exactly at birth.
    expect(firstAntar.children![0].start.getTime()).toBe(BIRTH.getTime());
  });

  it("honours maxLevel to limit nesting depth", () => {
    const antarOnly = computeVimshottari(moonInNakshatra(10, 0.4), BIRTH, 120, 2);
    expect(antarOnly[1].children![0].level).toBe(2);
    expect(antarOnly[1].children![0].children).toBeUndefined();

    const mahaOnly = computeVimshottari(moonInNakshatra(10, 0.4), BIRTH, 120, 1);
    expect(mahaOnly[1].children).toBeUndefined();
  });
});

describe("activePeriod", () => {
  const periods = computeVimshottari(moonInNakshatra(22, 0.5), BIRTH, 120);

  it("finds the period running on a given date", () => {
    const target = periods[2];
    const mid = new Date((target.start.getTime() + target.end.getTime()) / 2);
    expect(activePeriod(periods, mid)?.lord).toBe(target.lord);
  });

  it("returns the first period for the birth instant", () => {
    expect(activePeriod(periods, BIRTH)?.lord).toBe(periods[0].lord);
  });
});
