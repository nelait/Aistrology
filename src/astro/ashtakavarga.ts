// Ashtakavarga — the classical points system for judging how much support each
// sign has, and therefore how a graha transiting it will actually behave.
//
// Each of the seven grahas (the nodes take no part) gets a Bhinnashtakavarga:
// twelve counts of benefic points, contributed by eight sources — the seven
// grahas and the Lagna. For each contributor there is a fixed list of houses,
// counted from where that contributor sits, which receive a point. Adding the
// seven Bhinnashtakavargas sign by sign gives the Sarvashtakavarga.
//
// The tables below are the Parashari ones. They carry their own proof: each
// graha's points sum to a fixed classical total (Sun 48, Moon 49, Mars 39,
// Mercury 54, Jupiter 56, Venus 52, Saturn 39) and those totals sum to 337 —
// the Sarvashtakavarga total every text quotes. A typo anywhere in the tables
// breaks one of those numbers, and the tests check all eight.

import { PlanetName } from "./constants";
import { Chart } from "./types";

/** The seven grahas that have an ashtakavarga. Rahu and Ketu do not. */
export const AV_PLANETS: PlanetName[] = [
  "Sun", "Moon", "Mars", "Mercury", "Jupiter", "Venus", "Saturn",
];

/** The eight contributors: the seven grahas and the Lagna. */
type Contributor = PlanetName | "Lagna";
const CONTRIBUTORS: Contributor[] = [...AV_PLANETS, "Lagna"];

/**
 * BENEFIC_PLACES[subject][contributor] — the houses, counted inclusively from
 * the contributor's sign, that receive a point in the subject's ashtakavarga.
 */
const BENEFIC_PLACES: Record<PlanetName, Record<Contributor, number[]>> = {
  Sun: {
    Sun: [1, 2, 4, 7, 8, 9, 10, 11],
    Moon: [3, 6, 10, 11],
    Mars: [1, 2, 4, 7, 8, 9, 10, 11],
    Mercury: [3, 5, 6, 9, 10, 11, 12],
    Jupiter: [5, 6, 9, 11],
    Venus: [6, 7, 12],
    Saturn: [1, 2, 4, 7, 8, 9, 10, 11],
    Lagna: [3, 4, 6, 10, 11, 12],
  },
  Moon: {
    Sun: [3, 6, 7, 8, 10, 11],
    Moon: [1, 3, 6, 7, 10, 11],
    Mars: [2, 3, 5, 6, 9, 10, 11],
    Mercury: [1, 3, 4, 5, 7, 8, 10, 11],
    Jupiter: [1, 4, 7, 8, 10, 11, 12],
    Venus: [3, 4, 5, 7, 9, 10, 11],
    Saturn: [3, 5, 6, 11],
    Lagna: [3, 6, 10, 11],
  },
  Mars: {
    Sun: [3, 5, 6, 10, 11],
    Moon: [3, 6, 11],
    Mars: [1, 2, 4, 7, 8, 10, 11],
    Mercury: [3, 5, 6, 11],
    Jupiter: [6, 10, 11, 12],
    Venus: [6, 8, 11, 12],
    Saturn: [1, 4, 7, 8, 9, 10, 11],
    Lagna: [1, 3, 6, 10, 11],
  },
  Mercury: {
    Sun: [5, 6, 9, 11, 12],
    Moon: [2, 4, 6, 8, 10, 11],
    Mars: [1, 2, 4, 7, 8, 9, 10, 11],
    Mercury: [1, 3, 5, 6, 9, 10, 11, 12],
    Jupiter: [6, 8, 11, 12],
    Venus: [1, 2, 3, 4, 5, 8, 9, 11],
    Saturn: [1, 2, 4, 7, 8, 9, 10, 11],
    Lagna: [1, 2, 4, 6, 8, 10, 11],
  },
  Jupiter: {
    Sun: [1, 2, 3, 4, 7, 8, 9, 10, 11],
    Moon: [2, 5, 7, 9, 11],
    Mars: [1, 2, 4, 7, 8, 10, 11],
    Mercury: [1, 2, 4, 5, 6, 9, 10, 11],
    Jupiter: [1, 2, 3, 4, 7, 8, 10, 11],
    Venus: [2, 5, 6, 9, 10, 11],
    Saturn: [3, 5, 6, 12],
    Lagna: [1, 2, 4, 5, 6, 7, 9, 10, 11],
  },
  Venus: {
    Sun: [8, 11, 12],
    Moon: [1, 2, 3, 4, 5, 8, 9, 11, 12],
    Mars: [3, 5, 6, 9, 11, 12],
    Mercury: [3, 5, 6, 9, 11],
    Jupiter: [5, 8, 9, 10, 11],
    Venus: [1, 2, 3, 4, 5, 8, 9, 10, 11],
    Saturn: [3, 4, 5, 8, 9, 10, 11],
    Lagna: [1, 2, 3, 4, 5, 8, 9, 11],
  },
  Saturn: {
    Sun: [1, 2, 4, 7, 8, 10, 11],
    Moon: [3, 6, 11],
    Mars: [3, 5, 6, 10, 11, 12],
    Mercury: [6, 8, 9, 10, 11, 12],
    Jupiter: [5, 6, 11, 12],
    Venus: [6, 11, 12],
    Saturn: [3, 5, 6, 11],
    Lagna: [1, 3, 4, 6, 10, 11],
  },
} as Record<PlanetName, Record<Contributor, number[]>>;

/** The totals the classical texts quote. Used as a self-check, not a source. */
export const CLASSICAL_BAV_TOTALS: Record<string, number> = {
  Sun: 48, Moon: 49, Mars: 39, Mercury: 54, Jupiter: 56, Venus: 52, Saturn: 39,
};
export const CLASSICAL_SAV_TOTAL = 337;

export interface Bhinnashtakavarga {
  planet: PlanetName;
  /** Points per sign, indexed 0..11 by sign. */
  bindus: number[];
  total: number;
}

export interface AshtakavargaResult {
  bav: Bhinnashtakavarga[];
  /** Sarvashtakavarga: the seven added together, per sign. */
  sav: number[];
  savTotal: number;
}

/** Sign each contributor occupies, Lagna included. */
function contributorSigns(chart: Chart): Record<Contributor, number> {
  const out = {} as Record<Contributor, number>;
  for (const p of AV_PLANETS) {
    out[p] = chart.planets.find((x) => x.planet === p)!.signIndex;
  }
  out.Lagna = chart.ascendantSign;
  return out;
}

export function computeAshtakavarga(chart: Chart): AshtakavargaResult {
  const at = contributorSigns(chart);

  const bav: Bhinnashtakavarga[] = AV_PLANETS.map((subject) => {
    const bindus = new Array(12).fill(0);
    for (const c of CONTRIBUTORS) {
      for (const house of BENEFIC_PLACES[subject][c]) {
        // House numbers are counted inclusively from the contributor's own
        // sign, so the 1st house IS that sign.
        bindus[(at[c] + house - 1) % 12] += 1;
      }
    }
    return {
      planet: subject,
      bindus,
      total: bindus.reduce((s: number, v: number) => s + v, 0),
    };
  });

  const sav = new Array(12).fill(0);
  for (const b of bav) for (let s = 0; s < 12; s++) sav[s] += b.bindus[s];

  return { bav, sav, savTotal: sav.reduce((s: number, v: number) => s + v, 0) };
}

/** Points a graha's own ashtakavarga gives the sign it is transiting. */
export function binduInSign(av: AshtakavargaResult, planet: PlanetName, sign: number): number | null {
  const b = av.bav.find((x) => x.planet === planet);
  return b ? b.bindus[sign] : null; // null for Rahu/Ketu, which have no varga
}

export type AvStrength = "strong" | "average" | "weak";

/**
 * Classical reading of a Bhinnashtakavarga count for a transit. Four or more
 * points and the graha gives its better results in that sign; three or fewer
 * and it struggles there regardless of how well placed it looks.
 */
export function binduStrength(bindus: number): AvStrength {
  if (bindus >= 5) return "strong";
  if (bindus >= 4) return "average";
  return "weak";
}

/**
 * Sarvashtakavarga reading for a sign. The 337 points spread over twelve signs
 * average a little over 28, so the classical thresholds sit either side of it.
 */
export function savStrength(points: number): AvStrength {
  if (points >= 30) return "strong";
  if (points >= 25) return "average";
  return "weak";
}
