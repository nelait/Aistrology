// Delta-T (ΔT = TT − UT): the gap between Terrestrial Time, in which the
// ephemeris series (Sun, Moon, planets, obliquity) are expressed, and Universal
// Time, in which civil clocks and sidereal time run. Ignoring it feeds the
// series a clock that is ΔT seconds slow — harmless for most placements, but at
// ~ΔT·(motion) it can nudge a fast body (the Moon) across a nakshatra/pada edge.
//
// Polynomial fits from Espenak & Meeus, "Five Millennium Canon of Solar
// Eclipses" (NASA). Accuracy is a few seconds across the app's realistic date
// range and degrades gracefully outside it.

/** Decimal (fractional) year for a Julian Day — adequate for slowly varying ΔT. */
export function decimalYear(jd: number): number {
  return 2000 + (jd - 2451545.0) / 365.25;
}

/** ΔT = TT − UT in seconds, for a Julian Day expressed in UT. */
export function deltaTSeconds(jd: number): number {
  return deltaTForYear(decimalYear(jd));
}

/** ΔT in seconds for a (decimal) calendar year, Espenak–Meeus expressions. */
export function deltaTForYear(y: number): number {
  if (y < -500) {
    const u = (y - 1820) / 100;
    return -20 + 32 * u * u;
  }
  if (y < 500) {
    const u = y / 100;
    return poly(u, [
      10583.6, -1014.41, 33.78311, -5.952053, -0.1798452, 0.022174192,
      0.0090316521,
    ]);
  }
  if (y < 1600) {
    const u = (y - 1000) / 100;
    return poly(u, [
      1574.2, -556.01, 71.23472, 0.319781, -0.8503463, -0.005050998,
      0.0083572073,
    ]);
  }
  if (y < 1700) {
    const t = y - 1600;
    return 120 - 0.9808 * t - 0.01532 * t * t + (t * t * t) / 7129;
  }
  if (y < 1800) {
    const t = y - 1700;
    return poly(t, [8.83, 0.1603, -0.0059285, 0.00013336, -1 / 1174000]);
  }
  if (y < 1860) {
    const t = y - 1800;
    return poly(t, [
      13.72, -0.332447, 0.0068612, 0.0041116, -0.00037436, 0.0000121272,
      -0.0000001699, 0.000000000875,
    ]);
  }
  if (y < 1900) {
    const t = y - 1860;
    return poly(t, [
      7.62, 0.5737, -0.251754, 0.01680668, -0.0004473624, 1 / 233174,
    ]);
  }
  if (y < 1920) {
    const t = y - 1900;
    return poly(t, [-2.79, 1.494119, -0.0598939, 0.0061966, -0.000197]);
  }
  if (y < 1941) {
    const t = y - 1920;
    return poly(t, [21.2, 0.84493, -0.0761, 0.0020936]);
  }
  if (y < 1961) {
    const t = y - 1950;
    return 29.07 + 0.407 * t - (t * t) / 233 + (t * t * t) / 2547;
  }
  if (y < 1986) {
    const t = y - 1975;
    return 45.45 + 1.067 * t - (t * t) / 260 - (t * t * t) / 718;
  }
  if (y < 2005) {
    const t = y - 2000;
    return poly(t, [
      63.86, 0.3345, -0.060374, 0.0017275, 0.000651814, 0.00002373599,
    ]);
  }
  if (y < 2050) {
    const t = y - 2000;
    return 62.92 + 0.32217 * t + 0.005589 * t * t;
  }
  if (y < 2150) {
    const u = (y - 1820) / 100;
    return -20 + 32 * u * u - 0.5628 * (2150 - y);
  }
  const u = (y - 1820) / 100;
  return -20 + 32 * u * u;
}

/** Horner evaluation of a polynomial given ascending-power coefficients. */
function poly(x: number, coeffs: number[]): number {
  let result = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) {
    result = result * x + coeffs[i];
  }
  return result;
}
