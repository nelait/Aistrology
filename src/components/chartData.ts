// Turn a computed Chart into a per-house arrangement suitable for drawing, for
// any supported divisional chart (Varga). House 1 is always the sign the Lagna
// falls in within that division.

import { GRAHA_BY_NAME, PlanetName } from "../astro/constants";
import { Chart } from "../astro/types";
import { divisionalSign, Varga } from "../astro/varga";

export interface HouseCell {
  house: number; // 1..12
  signIndex: number; // 0..11 occupying this house
  planets: Array<{
    name: PlanetName;
    short: string;
    retro: boolean;
    degInSign: number;
  }>;
}

// Re-exported so components can keep importing the chart-mode type from here.
export type { Varga } from "../astro/varga";
// Backwards-compatible alias for the previous rasi/navamsa-only mode type.
export type ChartMode = Varga;

/** Sign the Lagna occupies in the given divisional chart (becomes house 1). */
export function ascSignForVarga(chart: Chart, varga: Varga): number {
  return divisionalSign(chart.ascendant, varga);
}

export function buildHouseCells(chart: Chart, varga: Varga): HouseCell[] {
  const ascSign = ascSignForVarga(chart, varga);

  const cells: HouseCell[] = [];
  for (let h = 0; h < 12; h++) {
    const signIndex = (ascSign + h) % 12;
    cells.push({ house: h + 1, signIndex, planets: [] });
  }

  for (const p of chart.planets) {
    const sign = divisionalSign(p.longitude, varga);
    const house = ((sign - ascSign + 12) % 12) + 1;
    cells[house - 1].planets.push({
      name: p.planet,
      short: GRAHA_BY_NAME[p.planet].shortName,
      retro: p.retrograde,
      degInSign: p.degreeInSign,
    });
  }

  return cells;
}

// Kept for backwards compatibility with existing imports.
export const ascSignForMode = ascSignForVarga;
