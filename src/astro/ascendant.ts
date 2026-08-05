// Ascendant (Lagna) and Midheaven (MC) — the tropical ecliptic longitudes of
// the eastern horizon and upper meridian at the moment and place of birth.

import { atan2Deg, cosDeg, sinDeg, tanDeg, norm360 } from "./math";
import { lstDegrees } from "./time";
import { meanObliquity } from "./obliquity";

export interface AscMc {
  ascendant: number; // tropical ecliptic longitude, degrees
  mc: number; // tropical ecliptic longitude, degrees
  ramc: number; // right ascension of the meridian (local sidereal time), degrees
}

/**
 * Compute the tropical Ascendant and Midheaven.
 *
 * @param jd            Julian Day in UT
 * @param longitudeEast Observer longitude, east positive (degrees)
 * @param latitude      Observer latitude, north positive (degrees)
 */
export function ascendantMc(
  jd: number,
  longitudeEast: number,
  latitude: number,
): AscMc {
  const ramc = lstDegrees(jd, longitudeEast); // 0..360 degrees
  const eps = meanObliquity(jd);

  // Midheaven: ecliptic longitude of the meridian.
  const mc = atan2Deg(sinDeg(ramc), cosDeg(ramc) * cosDeg(eps));

  // Ascendant: ecliptic longitude of the eastern horizon.
  // asc = atan2( cos(RAMC), -(sin(RAMC) cosε + tanφ sinε) )
  const y = cosDeg(ramc);
  const x = -(sinDeg(ramc) * cosDeg(eps) + tanDeg(latitude) * sinDeg(eps));
  let asc = atan2Deg(y, x);

  // The formula yields the ascending point directly, but guard the quadrant so
  // the ascendant is always within 180° "ahead" of the MC (the rising point is
  // east of the meridian). This keeps polar/edge cases well-behaved.
  const diff = norm360(asc - mc);
  if (diff < 0 || diff > 180) {
    asc = norm360(asc + 180);
  }

  return { ascendant: norm360(asc), mc: norm360(mc), ramc };
}
