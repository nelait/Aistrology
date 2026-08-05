// Geocentric ecliptic longitude of the classical planets (Mercury..Saturn)
// using the JPL "Keplerian Elements for Approximate Positions of the Major
// Planets" (E. M. Standish), valid 1800 AD – 2050 AD to roughly an arc-minute.
//
// We compute each planet's heliocentric position and the Earth–Moon barycentre
// position in the J2000 ecliptic frame, subtract to get the geocentric vector,
// then read off its ecliptic longitude. Retrograde motion falls out naturally.

import { atan2Deg, norm180, DEG2RAD, RAD2DEG } from "./math";
import { precessionSinceJ2000 } from "./obliquity";

interface Elements {
  a: number; // semi-major axis (au)
  e: number; // eccentricity
  I: number; // inclination (deg)
  L: number; // mean longitude (deg)
  peri: number; // longitude of perihelion (deg)
  node: number; // longitude of ascending node (deg)
  // rates per Julian century
  aDot: number;
  eDot: number;
  IDot: number;
  LDot: number;
  periDot: number;
  nodeDot: number;
}

// J2000 elements and centennial rates (Standish, 1800–2050 set).
const ELEMENTS: Record<string, Elements> = {
  Mercury: {
    a: 0.38709927, e: 0.20563593, I: 7.00497902, L: 252.2503235,
    peri: 77.45779628, node: 48.33076593,
    aDot: 0.00000037, eDot: 0.00001906, IDot: -0.00594749,
    LDot: 149472.67411175, periDot: 0.16047689, nodeDot: -0.12534081,
  },
  Venus: {
    a: 0.72333566, e: 0.00677672, I: 3.39467605, L: 181.9790995,
    peri: 131.60246718, node: 76.67984255,
    aDot: 0.0000039, eDot: -0.00004107, IDot: -0.0007889,
    LDot: 58517.81538729, periDot: 0.00268329, nodeDot: -0.27769418,
  },
  Earth: {
    a: 1.00000261, e: 0.01671123, I: -0.00001531, L: 100.46457166,
    peri: 102.93768193, node: 0.0,
    aDot: 0.00000562, eDot: -0.00004392, IDot: -0.01294668,
    LDot: 35999.37244981, periDot: 0.32327364, nodeDot: 0.0,
  },
  Mars: {
    a: 1.52371034, e: 0.0933941, I: 1.84969142, L: -4.55343205,
    peri: -23.94362959, node: 49.55953891,
    aDot: 0.00001847, eDot: 0.00007882, IDot: -0.00813131,
    LDot: 19140.30268499, periDot: 0.44441088, nodeDot: -0.29257343,
  },
  Jupiter: {
    a: 5.202887, e: 0.04838624, I: 1.30439695, L: 34.39644051,
    peri: 14.72847983, node: 100.47390909,
    aDot: -0.00011607, eDot: -0.00013253, IDot: -0.00183714,
    LDot: 3034.74612775, periDot: 0.21252668, nodeDot: 0.20469106,
  },
  Saturn: {
    a: 9.53667594, e: 0.05386179, I: 2.48599187, L: 49.95424423,
    peri: 92.59887831, node: 113.66242448,
    aDot: -0.0012506, eDot: -0.00050991, IDot: 0.00193609,
    LDot: 1222.49362201, periDot: -0.41897216, nodeDot: -0.28867794,
  },
};

/** Heliocentric ecliptic (J2000) rectangular coordinates for a planet, in au. */
function heliocentric(el: Elements, T: number): [number, number, number] {
  const a = el.a + el.aDot * T;
  const e = el.e + el.eDot * T;
  const I = (el.I + el.IDot * T) * DEG2RAD;
  const L = el.L + el.LDot * T;
  const peri = el.peri + el.periDot * T;
  const node = el.node + el.nodeDot * T;

  const omega = (peri - node) * DEG2RAD; // argument of perihelion
  const Omega = node * DEG2RAD;

  // Mean anomaly, reduced to (-180, 180].
  let M = norm180(L - peri) * DEG2RAD;

  // Solve Kepler's equation E - e sinE = M (radians) by Newton iteration.
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 8; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-9) break;
  }

  // Position in the orbital plane.
  const xv = a * (Math.cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);

  // Rotate into J2000 ecliptic coordinates.
  const cosO = Math.cos(Omega);
  const sinO = Math.sin(Omega);
  const cosw = Math.cos(omega);
  const sinw = Math.sin(omega);
  const cosI = Math.cos(I);
  const sinI = Math.sin(I);

  const x =
    (cosw * cosO - sinw * sinO * cosI) * xv +
    (-sinw * cosO - cosw * sinO * cosI) * yv;
  const y =
    (cosw * sinO + sinw * cosO * cosI) * xv +
    (-sinw * sinO + cosw * cosO * cosI) * yv;
  const z = sinw * sinI * xv + cosw * sinI * yv;

  return [x, y, z];
}

/**
 * Geocentric ecliptic longitude of a planet, referred to the equinox of date
 * (J2000 longitude plus accumulated precession), in degrees [0, 360).
 */
export function planetLongitude(name: string, jd: number): number {
  const el = ELEMENTS[name];
  if (!el) throw new Error(`Unknown planet: ${name}`);
  const T = (jd - 2451545.0) / 36525;

  const [px, py] = geocentricVector(el, T);
  const lonJ2000 = atan2Deg(py, px);
  return (lonJ2000 + precessionSinceJ2000(jd)) % 360;
}

function geocentricVector(el: Elements, T: number): [number, number, number] {
  const [px, py, pz] = heliocentric(el, T);
  const [ex, ey, ez] = heliocentric(ELEMENTS.Earth, T);
  return [px - ex, py - ey, pz - ez];
}

export const PLANET_NAMES = ["Mercury", "Venus", "Mars", "Jupiter", "Saturn"];

// Exposed for unit checks / ecliptic latitude if ever needed.
export function planetEclipticLatitude(name: string, jd: number): number {
  const el = ELEMENTS[name];
  const T = (jd - 2451545.0) / 36525;
  const [x, y, z] = geocentricVector(el, T);
  const r = Math.sqrt(x * x + y * y + z * z);
  return Math.asin(z / r) * RAD2DEG;
}
