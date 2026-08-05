// Apparent geocentric ecliptic longitude of the Sun (equinox of date),
// Meeus "Astronomical Algorithms" chapter 25 (low-accuracy solar coordinates).
// Accuracy ~0.01°, far better than needed for sign/nakshatra placement.

import { norm360, sinDeg } from "./math";
import { julianCenturies } from "./time";

export function sunApparentLongitude(jd: number): number {
  const T = julianCenturies(jd);

  // Geometric mean longitude of the Sun.
  const L0 = norm360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
  // Mean anomaly of the Sun.
  const M = norm360(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
  // Sun's equation of the centre.
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * sinDeg(M) +
    (0.019993 - 0.000101 * T) * sinDeg(2 * M) +
    0.000289 * sinDeg(3 * M);

  const trueLong = L0 + C;

  // Correction to apparent longitude (nutation + aberration).
  const omega = 125.04 - 1934.136 * T;
  const apparent = trueLong - 0.00569 - 0.00478 * sinDeg(omega);

  return norm360(apparent);
}
