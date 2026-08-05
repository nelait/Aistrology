// Apparent geocentric ecliptic longitude of the Moon (equinox of date).
// Truncated ELP-2000/82 as tabulated by Meeus, "Astronomical Algorithms"
// chapter 47 (table 47.A, the full 60 longitude terms). Accuracy is a few
// arc-seconds in longitude — more than enough for nakshatra/pada placement.

import { norm360, sinDeg } from "./math";
import { julianCenturies } from "./time";

// Each row: [D, M, M', F, coefficient in 1e-6 degrees].
const TERMS: number[][] = [
  [0, 0, 1, 0, 6288774],
  [2, 0, -1, 0, 1274027],
  [2, 0, 0, 0, 658314],
  [0, 0, 2, 0, 213618],
  [0, 1, 0, 0, -185116],
  [0, 0, 0, 2, -114332],
  [2, 0, -2, 0, 58793],
  [2, -1, -1, 0, 57066],
  [2, 0, 1, 0, 53322],
  [2, -1, 0, 0, 45758],
  [0, 1, -1, 0, -40923],
  [1, 0, 0, 0, -34720],
  [0, 1, 1, 0, -30383],
  [2, 0, 0, -2, 15327],
  [0, 0, 1, 2, -12528],
  [0, 0, 1, -2, 10980],
  [4, 0, -1, 0, 10675],
  [0, 0, 3, 0, 10034],
  [4, 0, -2, 0, 8548],
  [2, 1, -1, 0, -7888],
  [2, 1, 0, 0, -6766],
  [1, 0, -1, 0, -5163],
  [1, 1, 0, 0, 4987],
  [2, -1, 1, 0, 4036],
  [2, 0, 2, 0, 3994],
  [4, 0, 0, 0, 3861],
  [2, 0, -3, 0, 3665],
  [0, 1, -2, 0, -2689],
  [2, 0, -1, 2, -2602],
  [2, -1, -2, 0, 2390],
  [1, 0, 1, 0, -2348],
  [2, -2, 0, 0, 2236],
  [0, 1, 2, 0, -2120],
  [0, 2, 0, 0, -2069],
  [2, -2, -1, 0, 2048],
  [2, 0, 1, -2, -1773],
  [2, 0, 0, 2, -1595],
  [4, -1, -1, 0, 1215],
  [0, 0, 2, 2, -1110],
  [3, 0, -1, 0, -892],
  [2, 1, 1, 0, -810],
  [4, -1, -2, 0, 759],
  [0, 2, -1, 0, -713],
  [2, 2, -1, 0, -700],
  [2, 1, -2, 0, 691],
  [2, -1, 0, -2, 596],
  [4, 0, 1, 0, 549],
  [0, 0, 4, 0, 537],
  [4, -1, 0, 0, 520],
  [1, 0, -2, 0, -487],
  [2, 1, 0, -2, -399],
  [0, 0, 2, -2, -381],
  [1, 1, 1, 0, 351],
  [3, 0, -2, 0, -340],
  [4, 0, -3, 0, 330],
  [2, -1, 2, 0, 327],
  [0, 2, 1, 0, -323],
  [1, 1, -1, 0, 299],
  [2, 0, 3, 0, 294],
];

export function moonApparentLongitude(jd: number): number {
  const T = julianCenturies(jd);

  const Lp = norm360(
    218.3164477 +
      481267.88123421 * T -
      0.0015786 * T * T +
      (T * T * T) / 538841 -
      (T * T * T * T) / 65194000,
  );
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

  const A1 = norm360(119.75 + 131.849 * T);
  const A2 = norm360(53.09 + 479264.29 * T);
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;

  let sumL = 0;
  for (const [cd, cm, cmp, cf, coeff] of TERMS) {
    const arg = cd * D + cm * M + cmp * Mp + cf * F;
    let term = coeff * sinDeg(arg);
    const absM = Math.abs(cm);
    if (absM === 1) term *= E;
    else if (absM === 2) term *= E * E;
    sumL += term;
  }

  // Additive corrections (Meeus, p. 342).
  sumL += 3958 * sinDeg(A1);
  sumL += 1962 * sinDeg(Lp - F);
  sumL += 318 * sinDeg(A2);

  return norm360(Lp + sumL / 1000000);
}
