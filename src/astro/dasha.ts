// Vimshottari Dasha — the 120-year planetary period system keyed to the Moon's
// nakshatra at birth. Produces Mahadashas and their nested Antardasha (bhukti)
// and Pratyantardasha (sub-sub-period) sub-periods.

import {
  NAKSHATRA_SPAN,
  PlanetName,
  VIMSHOTTARI_ORDER,
  VIMSHOTTARI_YEARS,
} from "./constants";
import { DashaPeriod } from "./types";

const SIDEREAL_YEAR_DAYS = 365.25636;

function addYears(date: Date, years: number): Date {
  const ms = years * SIDEREAL_YEAR_DAYS * 24 * 60 * 60 * 1000;
  return new Date(date.getTime() + ms);
}

/** Index into VIMSHOTTARI_ORDER for a given dasha lord. */
function orderIndex(lord: PlanetName): number {
  return VIMSHOTTARI_ORDER.indexOf(lord);
}

/**
 * Build the full Vimshottari Mahadasha timeline starting at birth, with nested
 * Antardasha (level 2) and Pratyantardasha (level 3) sub-periods.
 *
 * @param moonLongitude sidereal longitude of the Moon (degrees)
 * @param birthDate     the birth instant as a Date (in UT)
 * @param spanYears     total years of timeline to generate (default 120)
 * @param maxLevel      deepest sub-period level to nest (1=Maha, 2=Antar, 3=Pratyantar)
 */
export function computeVimshottari(
  moonLongitude: number,
  birthDate: Date,
  spanYears = 120,
  maxLevel = 3,
): DashaPeriod[] {
  // Which nakshatra is the Moon in, and how far through it?
  const nakFloat = moonLongitude / NAKSHATRA_SPAN; // 0..27
  const nakIndex = Math.floor(nakFloat) % 27;
  const fractionTraversed = nakFloat - Math.floor(nakFloat);

  // The dasha lord is the nakshatra lord; nakshatra lords cycle every 9.
  const startLord = VIMSHOTTARI_ORDER[nakIndex % 9];
  const startIdx = orderIndex(startLord);

  const firstLordYears = VIMSHOTTARI_YEARS[startLord];
  const consumedYears = firstLordYears * fractionTraversed; // elapsed at birth
  const balanceYears = firstLordYears - consumedYears;

  const periods: DashaPeriod[] = [];
  let cursor = new Date(birthDate.getTime());
  let elapsed = 0;

  // Walk the Vimshottari order cyclically from the starting lord. The first
  // period is the (partial) balance of the running Mahadasha at birth; every
  // subsequent lord is the next one in sequence, wrapping past the ninth back
  // to the starting lord — so the cycle stays contiguous for any span.
  for (let i = 0; elapsed < spanYears; i++) {
    const lord = VIMSHOTTARI_ORDER[(startIdx + i) % 9];
    const fullYears = VIMSHOTTARI_YEARS[lord];
    const isFirst = i === 0;
    // Only the first Mahadasha is partial: its sub-periods are laid out over the
    // FULL span that began before birth, then clipped so the running one starts
    // exactly at birth. Later Mahadashas begin fully, so full start == start.
    const fullStart = isFirst ? addYears(cursor, -consumedYears) : new Date(cursor.getTime());
    const fullEnd = addYears(fullStart, fullYears);

    periods.push({
      lord,
      start: new Date(cursor.getTime()), // birth for the first, else the full start
      end: new Date(fullEnd.getTime()),
      level: 1,
      children:
        maxLevel >= 2
          ? subPeriods(lord, fullStart, fullEnd, 2, birthDate, maxLevel)
          : undefined,
    });

    cursor = fullEnd;
    elapsed += isFirst ? balanceYears : fullYears;
  }

  return periods;
}

/**
 * Recursively subdivide a period into its sub-periods (Antardashas, then
 * Pratyantardashas). Sub-periods run in Vimshottari order starting from the
 * parent's own lord, each proportional to its lord's years out of 120. The tree
 * is built over the parent's FULL, unclipped span [parentFullStart, parentFullEnd];
 * anything ending at or before `notBefore` (birth) is dropped, and the running
 * sub-period is clipped to it.
 *
 * Boundaries are derived from integer-millisecond cumulative proportions of the
 * parent span, and adjacent siblings share the exact same boundary instant, so
 * the tree is contiguous to the millisecond and the final child ends exactly at
 * `parentFullEnd`.
 */
function subPeriods(
  parentLord: PlanetName,
  parentFullStart: Date,
  parentFullEnd: Date,
  level: number,
  notBefore: Date,
  maxLevel: number,
): DashaPeriod[] {
  const startIdx = orderIndex(parentLord);
  const startMs = parentFullStart.getTime();
  const totalMs = parentFullEnd.getTime() - startMs;

  // Lords in cyclic order and the millisecond boundaries between them.
  const lords: PlanetName[] = [];
  const boundaries: number[] = [startMs];
  let cumYears = 0;
  for (let i = 0; i < 9; i++) {
    const lord = VIMSHOTTARI_ORDER[(startIdx + i) % 9];
    lords.push(lord);
    cumYears += VIMSHOTTARI_YEARS[lord];
    boundaries.push(startMs + Math.round((cumYears / 120) * totalMs));
  }

  const children: DashaPeriod[] = [];
  for (let i = 0; i < 9; i++) {
    const subStartMs = boundaries[i];
    const subEndMs = boundaries[i + 1];
    if (subEndMs <= notBefore.getTime()) continue; // wholly before birth

    const subFullStart = new Date(subStartMs);
    const subEnd = new Date(subEndMs);
    const start =
      subStartMs < notBefore.getTime() ? new Date(notBefore.getTime()) : subFullStart;

    children.push({
      lord: lords[i],
      start,
      end: subEnd,
      level,
      children:
        level < maxLevel
          ? subPeriods(lords[i], subFullStart, subEnd, level + 1, notBefore, maxLevel)
          : undefined,
    });
  }

  return children;
}

/** Find the dasha period (at a given level) active on a specific date. */
export function activePeriod(
  periods: DashaPeriod[],
  when: Date,
): DashaPeriod | undefined {
  return periods.find((p) => when >= p.start && when < p.end);
}
