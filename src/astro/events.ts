// Important life events derived from the chart: Mahadasha changes, Sade Sati
// windows, and the classic planetary "returns" (Saturn, Jupiter, nodal). All of
// it falls out of the same validated engine — dasha timing plus scanning slow
// transits against the natal positions.

import { PlanetName } from "./constants";
import { Chart } from "./types";
import { siderealLongitude, birthDateUT } from "./engine";
import { julianDayFromDate } from "./time";
import { deltaTSeconds } from "./deltat";
import { norm180 } from "./math";
import { computeVimshottari } from "./dasha";

const DAY_MS = 86_400_000;
const YEAR_MS = 365.2422 * DAY_MS;

export type EventCategory = "Dasha" | "Sade Sati" | "Saturn" | "Jupiter" | "Nodes";

export interface LifeEvent {
  date: Date;
  endDate?: Date; // for windows (Sade Sati)
  ageYears: number; // age at the (start) date
  category: EventCategory;
  title: string;
  description: string;
}

/** Sidereal longitude of a body at an instant, honouring the chart's settings. */
function lonAt(planet: PlanetName, when: Date, chart: Chart): number {
  const jd = julianDayFromDate(when);
  const jdTT = jd + deltaTSeconds(jd) / 86400;
  return siderealLongitude(planet, jdTT, chart.ayanamsaSystem, chart.nodeType);
}

function natalLongitude(chart: Chart, planet: PlanetName): number {
  return chart.planets.find((p) => p.planet === planet)!.longitude;
}

/** Refine a return time to ~day precision by bisecting where lon crosses natal. */
function bisectReturn(
  planet: PlanetName,
  natal: number,
  chart: Chart,
  a: Date,
  b: Date,
): Date {
  let lo = a.getTime();
  let hi = b.getTime();
  const dLo = norm180(lonAt(planet, new Date(lo), chart) - natal);
  for (let i = 0; i < 24 && hi - lo > DAY_MS; i++) {
    const mid = (lo + hi) / 2;
    const dMid = norm180(lonAt(planet, new Date(mid), chart) - natal);
    if (Math.sign(dMid) === Math.sign(dLo)) lo = mid;
    else hi = mid;
  }
  return new Date((lo + hi) / 2);
}

/** Times a body returns to its natal longitude, within [from, to]. */
function findReturns(planet: PlanetName, chart: Chart, from: Date, to: Date): Date[] {
  const natal = natalLongitude(chart, planet);
  const step = 15 * DAY_MS;
  const hits: Date[] = [];
  let prev = from;
  let prevDiff = norm180(lonAt(planet, prev, chart) - natal);
  for (let t = from.getTime() + step; t <= to.getTime(); t += step) {
    const cur = new Date(t);
    const diff = norm180(lonAt(planet, cur, chart) - natal);
    // A conjunction (not the 180° opposition) is a sign change near zero.
    if (Math.sign(diff) !== Math.sign(prevDiff) && Math.abs(diff) < 90 && Math.abs(prevDiff) < 90) {
      const hit = bisectReturn(planet, natal, chart, prev, cur);
      // Collapse multiple retrograde passes of one return into a single event.
      if (!hits.length || hit.getTime() - hits[hits.length - 1].getTime() > 400 * DAY_MS) {
        hits.push(hit);
      }
    }
    prev = cur;
    prevDiff = diff;
  }
  return hits;
}

/** Saturn's house (1..12) from the natal Moon at an instant. */
function saturnHouseFromMoon(chart: Chart, when: Date): number {
  const moonSign = chart.planets.find((p) => p.planet === "Moon")!.signIndex;
  const satSign = Math.floor(lonAt("Saturn", when, chart) / 30);
  return ((satSign - moonSign + 12) % 12) + 1;
}

/** Sade Sati windows (Saturn over the 12th→1st→2nd from the natal Moon). */
function findSadeSati(chart: Chart, from: Date, to: Date): Array<{ start: Date; end: Date }> {
  const step = 10 * DAY_MS;
  const active = (d: Date) => [12, 1, 2].includes(saturnHouseFromMoon(chart, d));
  const windows: Array<{ start: Date; end: Date }> = [];
  let inWindow = active(from);
  let windowStart = inWindow ? from : null;
  let prev = from;
  for (let t = from.getTime() + step; t <= to.getTime(); t += step) {
    const cur = new Date(t);
    const now = active(cur);
    if (now && !inWindow) windowStart = bisectBoundary(chart, prev, cur, true);
    if (!now && inWindow && windowStart) {
      windows.push({ start: windowStart, end: bisectBoundary(chart, prev, cur, false) });
      windowStart = null;
    }
    inWindow = now;
    prev = cur;
  }
  if (inWindow && windowStart) windows.push({ start: windowStart, end: to });

  // Saturn's retrograde loops near a sign boundary can briefly break contiguity;
  // merge windows separated by less than ~1.5 years, then drop any tiny residue.
  const merged: Array<{ start: Date; end: Date }> = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start.getTime() - last.end.getTime() < 1.5 * YEAR_MS) {
      last.end = w.end;
    } else {
      merged.push({ ...w });
    }
  }
  return merged.filter((w) => w.end.getTime() - w.start.getTime() > YEAR_MS);
}

/** Bisect the moment Sade Sati turns on (entering) or off (leaving). */
function bisectBoundary(chart: Chart, a: Date, b: Date, entering: boolean): Date {
  let lo = a.getTime();
  let hi = b.getTime();
  for (let i = 0; i < 20 && hi - lo > DAY_MS; i++) {
    const mid = (lo + hi) / 2;
    const on = [12, 1, 2].includes(saturnHouseFromMoon(chart, new Date(mid)));
    if (on === entering) hi = mid;
    else lo = mid;
  }
  return new Date((lo + hi) / 2);
}

const ORDINAL = ["", "1st", "2nd", "3rd", "4th", "5th", "6th"];

export interface EventsOptions {
  spanYears?: number; // how far past birth to look (default 90)
}

/** Build the chronological list of important events for a chart. */
export function importantEvents(chart: Chart, options: EventsOptions = {}): LifeEvent[] {
  const birth = birthDateUT(chart.birth);
  const span = options.spanYears ?? 90;
  const to = new Date(birth.getTime() + span * YEAR_MS);
  const events: LifeEvent[] = [];
  const age = (d: Date) => (d.getTime() - birth.getTime()) / YEAR_MS;

  // --- Mahadasha changes ---
  const moonLon = chart.planets.find((p) => p.planet === "Moon")!.longitude;
  const dashas = computeVimshottari(moonLon, birth, span, 1);
  dashas.forEach((d, i) => {
    events.push({
      date: d.start,
      ageYears: age(d.start),
      category: "Dasha",
      title:
        i === 0
          ? `${d.lord} Mahadasha (running at birth)`
          : `${d.lord} Mahadasha begins`,
      description:
        `A major ${((d.end.getTime() - d.start.getTime()) / YEAR_MS).toFixed(0)}-year life chapter ` +
        `ruled by ${d.lord}, colouring its themes until ${d.end.getFullYear()}.`,
    });
  });

  // --- Sade Sati windows ---
  findSadeSati(chart, birth, to).forEach((w, i) => {
    events.push({
      date: w.start,
      endDate: w.end,
      ageYears: age(w.start),
      category: "Sade Sati",
      title: `Sade Sati${i > 0 ? ` (cycle ${i + 1})` : ""}`,
      description:
        `Saturn's ~7½-year passage over the 12th, 1st and 2nd from your natal Moon — ` +
        `a demanding but formative period of responsibility and maturation, ending ${w.end.getFullYear()}.`,
    });
  });

  // --- Saturn returns ---
  findReturns("Saturn", chart, new Date(birth.getTime() + 10 * YEAR_MS), to).forEach((d) => {
    const n = Math.round(age(d) / 29.5);
    events.push({
      date: d,
      ageYears: age(d),
      category: "Saturn",
      title: `${ORDINAL[n] ?? `${n}th`} Saturn Return`,
      description:
        "Transiting Saturn returns to its natal sign — a milestone of maturity, restructuring " +
        "and taking on (or shedding) long-term commitments.",
    });
  });

  // --- Jupiter returns ---
  findReturns("Jupiter", chart, new Date(birth.getTime() + 6 * YEAR_MS), to).forEach((d) => {
    events.push({
      date: d,
      ageYears: age(d),
      category: "Jupiter",
      title: "Jupiter Return",
      description:
        "Transiting Jupiter returns to its natal sign (~every 12 years) — often a season of growth, " +
        "opportunity, optimism and expansion.",
    });
  });

  // --- Nodal (Rahu–Ketu) returns ---
  findReturns("Rahu", chart, new Date(birth.getTime() + 10 * YEAR_MS), to).forEach((d) => {
    events.push({
      date: d,
      ageYears: age(d),
      category: "Nodes",
      title: "Nodal Return (Rahu–Ketu)",
      description:
        "The lunar nodes return to their natal axis (~every 18.6 years) — a karmic turning point that " +
        "can realign direction, desires and life purpose.",
    });
  });

  events.sort((a, b) => a.date.getTime() - b.date.getTime());
  return events;
}
