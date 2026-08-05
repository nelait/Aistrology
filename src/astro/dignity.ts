// Planetary dignity: exaltation, debilitation, own sign, moolatrikona and a
// simple friendship model. Used to judge how strong / comfortable a planet is.

import { PlanetName } from "./constants";

export interface DignityTable {
  exaltation: { sign: number; deg: number }; // deep-exaltation sign & degree
  debilitation: { sign: number; deg: number };
  ownSigns: number[];
  moolatrikona?: { sign: number; from: number; to: number };
}

// Sign indices: 0 Aries … 11 Pisces.
export const DIGNITY: Partial<Record<PlanetName, DignityTable>> = {
  Sun: { exaltation: { sign: 0, deg: 10 }, debilitation: { sign: 6, deg: 10 }, ownSigns: [4], moolatrikona: { sign: 4, from: 0, to: 20 } },
  Moon: { exaltation: { sign: 1, deg: 3 }, debilitation: { sign: 7, deg: 3 }, ownSigns: [3], moolatrikona: { sign: 1, from: 4, to: 30 } },
  Mars: { exaltation: { sign: 9, deg: 28 }, debilitation: { sign: 3, deg: 28 }, ownSigns: [0, 7], moolatrikona: { sign: 0, from: 0, to: 12 } },
  Mercury: { exaltation: { sign: 5, deg: 15 }, debilitation: { sign: 11, deg: 15 }, ownSigns: [2, 5], moolatrikona: { sign: 5, from: 16, to: 20 } },
  Jupiter: { exaltation: { sign: 3, deg: 5 }, debilitation: { sign: 9, deg: 5 }, ownSigns: [8, 11], moolatrikona: { sign: 8, from: 0, to: 10 } },
  Venus: { exaltation: { sign: 11, deg: 27 }, debilitation: { sign: 5, deg: 27 }, ownSigns: [1, 6], moolatrikona: { sign: 6, from: 0, to: 15 } },
  Saturn: { exaltation: { sign: 6, deg: 20 }, debilitation: { sign: 0, deg: 20 }, ownSigns: [9, 10], moolatrikona: { sign: 10, from: 0, to: 20 } },
  // Nodes: schools differ; a commonly used assignment.
  Rahu: { exaltation: { sign: 1, deg: 20 }, debilitation: { sign: 7, deg: 20 }, ownSigns: [10] },
  Ketu: { exaltation: { sign: 7, deg: 20 }, debilitation: { sign: 1, deg: 20 }, ownSigns: [7] },
};

export type DignityStatus =
  | "Exalted"
  | "Debilitated"
  | "Moolatrikona"
  | "Own sign"
  | "Neutral";

/**
 * Sign-only dignity — exaltation / debilitation / own sign — without the
 * degree-based moolatrikona test. Used for divisional charts, where a planet's
 * strength is judged by the varga sign it lands in, not a precise degree.
 */
export function signDignity(planet: PlanetName, signIndex: number): DignityStatus {
  const table = DIGNITY[planet];
  if (!table) return "Neutral";
  if (table.exaltation.sign === signIndex) return "Exalted";
  if (table.debilitation.sign === signIndex) return "Debilitated";
  if (table.ownSigns.includes(signIndex)) return "Own sign";
  return "Neutral";
}

export function dignityOf(
  planet: PlanetName,
  signIndex: number,
  degInSign: number,
): DignityStatus {
  const table = DIGNITY[planet];
  if (!table) return "Neutral";
  if (table.exaltation.sign === signIndex) return "Exalted";
  if (table.debilitation.sign === signIndex) return "Debilitated";
  if (
    table.moolatrikona &&
    table.moolatrikona.sign === signIndex &&
    degInSign >= table.moolatrikona.from &&
    degInSign <= table.moolatrikona.to
  ) {
    return "Moolatrikona";
  }
  if (table.ownSigns.includes(signIndex)) return "Own sign";
  return "Neutral";
}

// Natural friendships (Naisargika Maitri). Values: friend / enemy / neutral.
const FRIENDS: Record<PlanetName, PlanetName[]> = {
  Sun: ["Moon", "Mars", "Jupiter"],
  Moon: ["Sun", "Mercury"],
  Mars: ["Sun", "Moon", "Jupiter"],
  Mercury: ["Sun", "Venus"],
  Jupiter: ["Sun", "Moon", "Mars"],
  Venus: ["Mercury", "Saturn"],
  Saturn: ["Mercury", "Venus"],
  Rahu: ["Venus", "Saturn"],
  Ketu: ["Mars", "Venus"],
};

const ENEMIES: Record<PlanetName, PlanetName[]> = {
  Sun: ["Venus", "Saturn"],
  Moon: [],
  Mars: ["Mercury"],
  Mercury: ["Moon"],
  Jupiter: ["Mercury", "Venus"],
  Venus: ["Sun", "Moon"],
  Saturn: ["Sun", "Moon", "Mars"],
  Rahu: ["Sun", "Moon", "Mars"],
  Ketu: ["Sun", "Moon"],
};

export function naturalRelation(
  from: PlanetName,
  to: PlanetName,
): "Friend" | "Enemy" | "Neutral" {
  if (FRIENDS[from]?.includes(to)) return "Friend";
  if (ENEMIES[from]?.includes(to)) return "Enemy";
  return "Neutral";
}
