// Transits (Gochara): where the grahas are *now* (or on any chosen date) and
// how they fall on the natal chart. Vedic gochara is read primarily from the
// natal Moon sign (Janma Rashi); we also give the house counted from the Lagna.
//
// The transiting positions reuse the same validated sidereal engine as the
// birth chart, so nothing new needs verifying about the astronomy itself.

import { GRAHAS, NAKSHATRA_SPAN, PlanetName } from "./constants";
import { Chart } from "./types";
import { siderealLongitude, isRetrograde } from "./engine";
import { julianDayFromDate } from "./time";
import { deltaTSeconds } from "./deltat";

// Classical Chandra-gochara: the houses (counted from the natal Moon) in which
// each transiting graha gives favourable results.
const GOCHARA_FAVORABLE: Record<PlanetName, number[]> = {
  Sun: [3, 6, 10, 11],
  Moon: [1, 3, 6, 7, 10, 11],
  Mars: [3, 6, 11],
  Mercury: [2, 4, 6, 8, 10, 11],
  Jupiter: [2, 5, 7, 9, 11],
  Venus: [1, 2, 3, 4, 5, 8, 9, 11, 12],
  Saturn: [3, 6, 11],
  Rahu: [3, 6, 10, 11],
  Ketu: [3, 6, 10, 11],
};

export type Gochara = "Favorable" | "Challenging";

export interface TransitPosition {
  planet: PlanetName;
  longitude: number; // sidereal ecliptic longitude 0..360
  signIndex: number; // 0..11
  degreeInSign: number; // 0..30
  nakshatraIndex: number; // 0..26
  retrograde: boolean;
  houseFromMoon: number; // 1..12, counted from the natal Moon sign
  houseFromLagna: number; // 1..12, counted from the natal Ascendant sign
  gochara: Gochara; // classical favourability from the Moon
}

/** House (1..12) of `signIndex` counted inclusively from `referenceSign`. */
function houseFrom(referenceSign: number, signIndex: number): number {
  return ((signIndex - referenceSign + 12) % 12) + 1;
}

/** Transiting positions of every graha at `when`, laid over the natal chart. */
export function computeTransits(natal: Chart, when: Date): TransitPosition[] {
  const jd = julianDayFromDate(when);
  const jdTT = jd + deltaTSeconds(jd) / 86400;

  const moonSign = natal.planets.find((p) => p.planet === "Moon")!.signIndex;
  const lagnaSign = natal.ascendantSign;

  return GRAHAS.map((g) => {
    // Use the same ayanamsa and node convention as the natal chart, so transit
    // signs line up with the birth chart they are read against.
    const lon = siderealLongitude(g.name, jdTT, natal.ayanamsaSystem, natal.nodeType);
    const signIndex = Math.floor(lon / 30);
    const houseFromMoon = houseFrom(moonSign, signIndex);

    return {
      planet: g.name,
      longitude: lon,
      signIndex,
      degreeInSign: lon - signIndex * 30,
      nakshatraIndex: Math.floor(lon / NAKSHATRA_SPAN) % 27,
      retrograde: isRetrograde(g.name, jdTT, natal.nodeType),
      houseFromMoon,
      houseFromLagna: houseFrom(lagnaSign, signIndex),
      gochara: GOCHARA_FAVORABLE[g.name].includes(houseFromMoon)
        ? "Favorable"
        : "Challenging",
    };
  });
}

export interface SadeSatiStatus {
  active: boolean;
  // Which leg of Sade Sati, if any: Saturn in the 12th, 1st or 2nd from the Moon.
  phase?: "Rising (12th)" | "Peak (1st)" | "Setting (2nd)";
  saturnHouseFromMoon: number;
}

/**
 * Sade Sati — Saturn's ~7½-year passage over the 12th, 1st and 2nd signs from
 * the natal Moon. Determined purely from Saturn's transiting house-from-Moon.
 */
export function sadeSati(transits: TransitPosition[]): SadeSatiStatus {
  const saturn = transits.find((p) => p.planet === "Saturn")!;
  const h = saturn.houseFromMoon;
  const phase =
    h === 12
      ? "Rising (12th)"
      : h === 1
        ? "Peak (1st)"
        : h === 2
          ? "Setting (2nd)"
          : undefined;
  return { active: phase !== undefined, phase, saturnHouseFromMoon: h };
}
