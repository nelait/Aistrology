// Historical timezone offsets. Instead of a static UTC offset + a manual DST
// checkbox, resolve the *actual* offset that was in force at a given place and
// instant — including daylight saving and historical changes (e.g. India's
// +06:30 wartime clock 1942–1945, or pre-1972 European DST rules).
//
// We lean on the JavaScript engine's bundled IANA time-zone database via
// Intl.DateTimeFormat, so no offset tables ship with the app.

/** UTC offset in minutes of an IANA zone at a specific absolute instant. */
export function zoneOffsetMinutesAt(zone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = Number(p.value);
  // The wall-clock the zone shows for this instant, read back as if it were UTC.
  const asUTC = Date.UTC(m.year, m.month - 1, m.day, m.hour, m.minute, m.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

/**
 * UTC offset in hours for a LOCAL civil date/time in a zone, with the correct
 * historical/DST rules applied. Two passes resolve the offset even across a DST
 * boundary (the local time first guesses the instant, then we refine).
 */
export function zoneOffsetHours(
  zone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const guessUTC = Date.UTC(year, month - 1, day, hour, minute);
  const o1 = zoneOffsetMinutesAt(zone, new Date(guessUTC));
  const o2 = zoneOffsetMinutesAt(zone, new Date(guessUTC - o1 * 60000));
  return o2 / 60;
}
