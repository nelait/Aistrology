// Ayanamsa systems: the sidereal↔tropical offset. Different schools fix the
// sidereal zodiac to slightly different points, so they differ mainly by a
// (near-)constant amount. We model each as its value at J2000.0 plus the shared
// general-precession growth, keeping every system mutually consistent with the
// planet longitudes (whose precession uses the same rate — see obliquity.ts).
//
// The J2000 offsets are derived from the Swiss Ephemeris reference epochs for
// each system, projected to J2000 with this app's linear precession rate.

import { precessionSinceJ2000 } from "./obliquity";

export type Ayanamsa = "Lahiri" | "Raman" | "KP" | "FaganBradley";

export interface AyanamsaInfo {
  code: Ayanamsa;
  name: string;
  j2000: number; // ayanamsa value at J2000.0, degrees
  note: string;
}

export const AYANAMSAS: AyanamsaInfo[] = [
  {
    code: "Lahiri",
    name: "Lahiri (Chitrapaksha)",
    j2000: 23.85293,
    note: "Government of India standard; the most widely used in Vedic astrology.",
  },
  {
    code: "Raman",
    name: "B. V. Raman",
    j2000: 22.40552,
    note: "Followers of B. V. Raman; about 1.4° less than Lahiri.",
  },
  {
    code: "KP",
    name: "Krishnamurti (KP)",
    j2000: 23.756,
    note: "Krishnamurti Paddhati; roughly 6′ less than Lahiri.",
  },
  {
    code: "FaganBradley",
    name: "Fagan–Bradley",
    j2000: 24.7398,
    note: "The Western sidereal standard; about 0.9° more than Lahiri.",
  },
];

export const AYANAMSA_BY_CODE: Record<Ayanamsa, AyanamsaInfo> =
  Object.fromEntries(AYANAMSAS.map((a) => [a.code, a])) as Record<
    Ayanamsa,
    AyanamsaInfo
  >;

/** Ayanamsa (degrees) for a Julian Day under the chosen system. */
export function ayanamsaValue(jd: number, system: Ayanamsa = "Lahiri"): number {
  return AYANAMSA_BY_CODE[system].j2000 + precessionSinceJ2000(jd);
}
