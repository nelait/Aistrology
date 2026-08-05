// Small angle / trig helpers used across the astronomy engine.
// Angles are in degrees at the public boundary; radians internally where noted.

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/** Normalise an angle in degrees to the range [0, 360). */
export function norm360(deg: number): number {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

/** Normalise an angle in degrees to the range (-180, 180]. */
export function norm180(deg: number): number {
  let d = norm360(deg);
  if (d > 180) d -= 360;
  return d;
}

export function sinDeg(deg: number): number {
  return Math.sin(deg * DEG2RAD);
}

export function cosDeg(deg: number): number {
  return Math.cos(deg * DEG2RAD);
}

export function tanDeg(deg: number): number {
  return Math.tan(deg * DEG2RAD);
}

/** atan2 returning degrees in [0, 360). */
export function atan2Deg(y: number, x: number): number {
  return norm360(Math.atan2(y, x) * RAD2DEG);
}

/**
 * The smallest absolute separation between two ecliptic longitudes (degrees).
 * Result is in [0, 180].
 */
export function angularSeparation(a: number, b: number): number {
  return Math.abs(norm180(a - b));
}
