// Cusp (boundary) proximity. The engine's approximate theories place bodies to
// roughly an arc-minute, and the ayanamsa/ΔT carry their own small uncertainty.
// So when a body sits within a hair of a sign, nakshatra or pada boundary, the
// *discrete* placement (and everything keyed to it — house, birth star, dasha
// lord, navamsa) is genuinely borderline and worth flagging honestly.

import { NAKSHATRA_SPAN, PADA_SPAN } from "./constants";
import { norm360 } from "./math";

/** Within this many degrees of a boundary, a placement is called borderline. */
export const DEFAULT_CUSP_TOLERANCE = 0.1; // ≈ 6 arc-minutes

export interface EdgeProximity {
  near: boolean; // within tolerance of the nearest boundary
  distanceDeg: number; // degrees to that boundary
  neighborIndex: number; // the cell on the other side (sign 0..11 / nakshatra 0..26 / pada 1..4)
}

export interface CuspInfo {
  sign: EdgeProximity;
  nakshatra: EdgeProximity;
  pada: EdgeProximity;
  any: boolean;
}

/** Proximity of `lon` to the nearest boundary of a cell of width `span`. */
function proximity(
  lon: number,
  span: number,
  count: number,
  tol: number,
): EdgeProximity {
  const idx = Math.floor(lon / span);
  const within = lon - idx * span;
  const up = span - within; // distance forward to the next boundary
  const down = within; // distance back to the previous boundary
  if (up <= down) {
    return { near: up < tol, distanceDeg: up, neighborIndex: (idx + 1) % count };
  }
  return {
    near: down < tol,
    distanceDeg: down,
    neighborIndex: (idx + count - 1) % count,
  };
}

/**
 * How close a sidereal longitude sits to the sign / nakshatra / pada boundaries.
 */
export function cuspInfo(
  longitude: number,
  tolerance = DEFAULT_CUSP_TOLERANCE,
): CuspInfo {
  const lon = norm360(longitude);

  const sign = proximity(lon, 30, 12, tolerance);
  // Nakshatra indices repeat every 27; proximity's modulo count keeps them 0..26.
  const nakshatra = proximity(lon, NAKSHATRA_SPAN, 27, tolerance);

  // Pada boundaries recur every 3°20′. Convert the neighbouring global pada index
  // into a 1..4 pada number within its nakshatra.
  const padaGlobal = proximity(lon, PADA_SPAN, 108, tolerance);
  const pada: EdgeProximity = {
    ...padaGlobal,
    neighborIndex: (padaGlobal.neighborIndex % 4) + 1,
  };

  return { sign, nakshatra, pada, any: sign.near || nakshatra.near || pada.near };
}
