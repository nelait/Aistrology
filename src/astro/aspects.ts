// Vedic aspects (Drishti). Every graha aspects the 7th house/sign from itself
// (full opposition). Mars, Jupiter and Saturn have additional special aspects.
// Rahu/Ketu are commonly given 5th, 7th and 9th aspects.

import { PlanetName } from "./constants";
import { PlanetPosition } from "./types";

// House-distances (counted inclusively, 1 = same sign) that each planet aspects.
const SPECIAL_ASPECTS: Record<PlanetName, number[]> = {
  Sun: [7],
  Moon: [7],
  Mars: [4, 7, 8],
  Mercury: [7],
  Jupiter: [5, 7, 9],
  Venus: [7],
  Saturn: [3, 7, 10],
  Rahu: [5, 7, 9],
  Ketu: [5, 7, 9],
};

export interface Aspect {
  from: PlanetName;
  toSign: number; // 0..11 sign index being aspected
  distance: number; // 3,4,5,7,8,9,10
}

/** Signs (0..11) aspected by a planet sitting in `signIndex`. */
export function aspectedSigns(planet: PlanetName, signIndex: number): number[] {
  return SPECIAL_ASPECTS[planet].map((d) => (signIndex + d - 1) % 12);
}

/** All aspects thrown in a chart, one entry per (planet, aspected sign). */
export function allAspects(planets: PlanetPosition[]): Aspect[] {
  const out: Aspect[] = [];
  for (const p of planets) {
    for (const d of SPECIAL_ASPECTS[p.planet]) {
      out.push({ from: p.planet, toSign: (p.signIndex + d - 1) % 12, distance: d });
    }
  }
  return out;
}

/** Which planets aspect a given house number (1..12) in the chart. */
export function planetsAspectingHouse(
  planets: PlanetPosition[],
  houseSigns: number[],
  house: number,
): PlanetName[] {
  const targetSign = houseSigns[house - 1];
  const aspecting: PlanetName[] = [];
  for (const p of planets) {
    if (aspectedSigns(p.planet, p.signIndex).includes(targetSign)) {
      aspecting.push(p.planet);
    }
  }
  return aspecting;
}
