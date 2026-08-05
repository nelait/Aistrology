// Mean obliquity of the ecliptic and the Lahiri (Chitrapaksha) ayanamsa.

import { julianCenturies } from "./time";

/**
 * Mean obliquity of the ecliptic in degrees (Meeus eq. 22.2).
 * Accurate to better than an arc-second over the app's date range.
 */
export function meanObliquity(jd: number): number {
  const T = julianCenturies(jd);
  return (
    23.4392911 -
    0.0130041667 * T -
    1.6388889e-7 * T * T +
    5.036111e-7 * T * T * T
  );
}

/**
 * General precession in ecliptic longitude accumulated since J2000, in degrees.
 * We use the same rate that defines the Lahiri ayanamsa's growth so that the
 * two are mutually consistent and cancel exactly for a fixed sidereal frame.
 */
export function precessionSinceJ2000(jd: number): number {
  const T = julianCenturies(jd);
  return 1.3955208 * T; // 5023.875"/century -> degrees/century
}

// The ayanamsa systems (Lahiri, Raman, KP, Fagan–Bradley) build on this shared
// precession rate; see ayanamsa.ts.
