// Time handling: convert a civil birth date/time + timezone offset into
// Julian Day (UT), plus sidereal-time helpers.

import { norm360 } from "./math";

/**
 * Julian Day for a Gregorian calendar date/time given in Universal Time.
 * Valid for the Gregorian calendar (dates after 1582-10-15), which covers
 * every realistic birth date this app serves.
 */
export function julianDay(
  year: number,
  month: number,
  day: number,
  hourUT: number,
): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  const jd =
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    day +
    hourUT / 24 +
    b -
    1524.5;
  return jd;
}

/**
 * Julian Day (UT) from local civil time and a timezone offset in hours
 * (east of UTC positive, e.g. India Standard Time = +5.5).
 */
export function julianDayFromLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tzOffsetHours: number,
): number {
  const localHours = hour + minute / 60 + second / 3600;
  const utHours = localHours - tzOffsetHours;
  return julianDay(year, month, day, utHours);
}

/** Julian Day (UT) for a JavaScript Date, read from its UTC fields. */
export function julianDayFromDate(date: Date): number {
  const hourUT =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600 +
    date.getUTCMilliseconds() / 3600000;
  return julianDay(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    hourUT,
  );
}

/** Julian centuries since J2000.0 (2000 Jan 1.5 TT). */
export function julianCenturies(jd: number): number {
  return (jd - 2451545.0) / 36525;
}

/**
 * Greenwich Mean Sidereal Time in degrees (0..360), from JD in UT.
 * Meeus, Astronomical Algorithms, eq. 12.4.
 */
export function gmstDegrees(jd: number): number {
  const T = julianCenturies(jd);
  const theta =
    280.46061837 +
    360.98564736629 * (jd - 2451545.0) +
    0.000387933 * T * T -
    (T * T * T) / 38710000;
  return norm360(theta);
}

/**
 * Local (apparent) sidereal time in degrees. `longitudeEast` is the observer's
 * geographic longitude, east positive.
 */
export function lstDegrees(jd: number, longitudeEast: number): number {
  return norm360(gmstDegrees(jd) + longitudeEast);
}
