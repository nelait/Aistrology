// Rahu (north lunar node) and Ketu (south lunar node).
//
// Traditional Vedic astrology most often uses the MEAN node, which moves
// steadily retrograde around the zodiac once every ~18.6 years. Ketu is always
// exactly 180° from Rahu.

import { norm360, sinDeg } from "./math";
import { julianCenturies } from "./time";

/** Tropical (equinox of date) longitude of the mean ascending node, degrees. */
export function meanNodeLongitude(jd: number): number {
  const T = julianCenturies(jd);
  // Longitude of the Moon's mean ascending node (Meeus eq. 47.7).
  const omega =
    125.0445479 -
    1934.1362891 * T +
    0.0020754 * T * T +
    (T * T * T) / 467441 -
    (T * T * T * T) / 60616000;
  return norm360(omega);
}

/**
 * True (osculating) ascending node — the mean node plus the principal periodic
 * perturbations (Meeus). It oscillates about the mean node with an amplitude of
 * ~1.5° and a period of ~173 days, so it can briefly turn direct. The dominant
 * term has argument 2(D − F); the rest are refinements below 0.15°.
 */
export function trueNodeLongitude(jd: number): number {
  const T = julianCenturies(jd);

  const D = norm360(
    297.8501921 +
      445267.1114034 * T -
      0.0018819 * T * T +
      (T * T * T) / 545868 -
      (T * T * T * T) / 113065000,
  );
  const M = norm360(
    357.5291092 + 35999.0502909 * T - 0.0001536 * T * T + (T * T * T) / 24490000,
  );
  const Mp = norm360(
    134.9633964 +
      477198.8675055 * T +
      0.0087414 * T * T +
      (T * T * T) / 69699 -
      (T * T * T * T) / 14712000,
  );
  const F = norm360(
    93.272095 +
      483202.0175233 * T -
      0.0036539 * T * T -
      (T * T * T) / 3526000 +
      (T * T * T * T) / 863310000,
  );

  const correction =
    -1.4979 * sinDeg(2 * (D - F)) -
    0.15 * sinDeg(M) -
    0.1226 * sinDeg(2 * D) +
    0.1176 * sinDeg(2 * F) -
    0.0801 * sinDeg(2 * (Mp - F));

  return norm360(meanNodeLongitude(jd) + correction);
}

export function rahuLongitude(jd: number): number {
  return meanNodeLongitude(jd);
}

export function ketuLongitude(jd: number): number {
  return norm360(meanNodeLongitude(jd) + 180);
}
