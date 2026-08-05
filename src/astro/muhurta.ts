// Muhurta — electional astrology. For a residence location and a date range it
// computes the local Panchanga (Vara, Tithi, Nakshatra, Yoga), the daily
// inauspicious windows (Rahu Kaal, Yamaganda, Gulika) and auspicious windows
// (Abhijit, Brahma Muhurta), and rates each day for starting auspicious work.
//
// Sunrise/sunset are computed from the Sun's altitude at the location, so all
// time-based windows are in the user's LOCAL clock time.

import { NAKSHATRAS } from "./constants";
import { norm360, sinDeg, cosDeg, atan2Deg } from "./math";
import { julianDayFromLocal, lstDegrees } from "./time";
import { meanObliquity } from "./obliquity";
import { sunApparentLongitude } from "./sun";
import { moonApparentLongitude } from "./moon";
import { ayanamsaValue } from "./ayanamsa";
import { deltaTSeconds } from "./deltat";
import { zoneOffsetHours } from "./timezone";

/** Ephemerides are referred to Terrestrial Time; sidereal time stays on UT. */
const toTT = (jdUT: number) => jdUT + deltaTSeconds(jdUT) / 86400;

const RAD = Math.PI / 180;
const asinDeg = (x: number) => Math.asin(Math.max(-1, Math.min(1, x))) / RAD;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TITHI_NAMES = [
  "Pratipada", "Dwitiya", "Tritiya", "Chaturthi", "Panchami", "Shashthi", "Saptami",
  "Ashtami", "Navami", "Dashami", "Ekadashi", "Dwadashi", "Trayodashi", "Chaturdashi", "Purnima",
];
const YOGA_NAMES = [
  "Vishkambha", "Priti", "Ayushman", "Saubhagya", "Shobhana", "Atiganda", "Sukarma", "Dhriti",
  "Shula", "Ganda", "Vriddhi", "Dhruva", "Vyaghata", "Harshana", "Vajra", "Siddhi", "Vyatipata",
  "Variyana", "Parigha", "Shiva", "Siddha", "Sadhya", "Shubha", "Shukla", "Brahma", "Indra", "Vaidhriti",
];

// Rahu Kaal / Yamaganda / Gulika: which of the 8 daytime parts (1 = from sunrise)
// belongs to each, indexed by weekday (0 = Sunday … 6 = Saturday).
const RAHU_PART = [8, 2, 7, 5, 6, 4, 3];
const YAMA_PART = [5, 4, 3, 2, 1, 7, 6];
const GULIKA_PART = [7, 6, 5, 4, 3, 2, 1];

// Auspicious / harsh Moon-nakshatras for general muhurta (by index 0..26).
const GOOD_NAKSHATRAS = new Set([0, 3, 4, 6, 7, 11, 12, 13, 14, 16, 20, 21, 22, 23, 25, 26]);
const HARSH_NAKSHATRAS = new Set([1, 2, 5, 8, 9, 17, 18, 19]); // Bharani, Krittika, Ashlesha, Magha, P.Phalguni, Jyeshtha, Moola, P.Ashadha

// Activity-specific favourable nakshatras (indices).
export const MUHURTA_ACTIVITIES = ["General", "Marriage", "Travel", "Business", "Housewarming", "Education"] as const;
export type MuhurtaActivity = (typeof MUHURTA_ACTIVITIES)[number];
const ACTIVITY_NAKSHATRAS: Record<MuhurtaActivity, Set<number>> = {
  General: GOOD_NAKSHATRAS,
  Marriage: new Set([3, 11, 12, 13, 20, 21, 25, 26]), // Rohini, Uttara Phalguni, Hasta, Chitra, Uttara Ashadha, Shravana, Uttara Bhadrapada, Revati
  Travel: new Set([0, 6, 7, 12, 13, 15, 22]), // Ashwini, Punarvasu, Pushya, Hasta, Chitra, Swati, Dhanishta
  Business: new Set([3, 6, 7, 12, 13, 22, 23]), // Rohini, Punarvasu, Pushya, Hasta, Chitra, Dhanishta, Shatabhisha
  Housewarming: new Set([3, 4, 11, 12, 20, 21, 25, 26]),
  Education: new Set([4, 6, 7, 12, 15, 16, 22, 26]), // Mrigashira, Punarvasu, Pushya, Hasta, Swati, Anuradha, Dhanishta, Revati
};

export interface Panchanga {
  weekday: string;
  tithiNum: number; // 1..30
  tithiName: string; // e.g. "Shukla Panchami"
  paksha: "Shukla" | "Krishna";
  nakshatra: string;
  nakshatraIndex: number;
  yoga: string;
}
export interface TimeWindow { name: string; from: string; to: string }
export type MuhurtaRating = "excellent" | "good" | "average" | "avoid";

export interface MuhurtaDay {
  date: string; // YYYY-MM-DD (local)
  weekday: string;
  sunrise: string | null; // local HH:MM
  sunset: string | null;
  panchanga: Panchanga;
  rating: MuhurtaRating;
  score: number;
  reasons: string[];
  auspicious: TimeWindow[];
  inauspicious: TimeWindow[];
}

export interface MuhurtaLocation {
  latitude: number; // north positive
  longitude: number; // east positive
  tzOffsetHours: number; // e.g. +5.5 for IST — used when `zone` is absent
  /**
   * IANA zone (e.g. "America/Los_Angeles"). When given, the UTC offset is
   * resolved *per date*, so a range spanning a DST transition stays correct.
   * Without it a single fixed offset applies to every day in the range.
   */
  zone?: string;
  label?: string;
}

/** Sun's altitude (degrees) at a Julian day for a location. */
function sunAltitude(jd: number, lat: number, lonEast: number): number {
  const jdTT = toTT(jd);
  const lambda = sunApparentLongitude(jdTT);
  const eps = meanObliquity(jdTT);
  const decl = asinDeg(sinDeg(eps) * sinDeg(lambda));
  const ra = norm360(atan2Deg(cosDeg(eps) * sinDeg(lambda), cosDeg(lambda)));
  const ha = lstDegrees(jd, lonEast) - ra; // hour angle — sidereal time is a function of UT
  return asinDeg(sinDeg(lat) * sinDeg(decl) + cosDeg(lat) * cosDeg(decl) * cosDeg(ha));
}

const HORIZON = -0.833; // standard refraction + solar semi-diameter

/**
 * Find sunrise and the sunset that FOLLOWS it, as local decimal hours for the
 * given local civil date. Returns null for polar day/night. Because we scan
 * minutes from local midnight, the minute offset *is* the local clock time.
 *
 * The sunset is deliberately paired with the sunrise rather than taken as the
 * first sunset of the local day: when the declared UTC offset is badly mismatched
 * to the longitude (e.g. hand-entered coordinates with the wrong timezone), the
 * sun can already be up at local midnight, so the first crossing found is the
 * *previous* day's sunset. Pairing keeps the daylight span positive, which every
 * downstream window (Rahu Kaal, Abhijit, …) divides by.
 */
function sunriseSunset(
  y: number, m: number, d: number, loc: MuhurtaLocation,
): { rise: number | null; set: number | null } {
  const jdMid = julianDayFromLocal(y, m, d, 0, 0, 0, loc.tzOffsetHours);
  const STEP = 4; // minutes
  const SPAN = 2880; // scan two local days so a paired sunset is always reachable
  let rise: number | null = null;
  let set: number | null = null;
  let prevAlt = sunAltitude(jdMid, loc.latitude, loc.longitude);
  for (let min = STEP; min <= SPAN; min += STEP) {
    const jd = jdMid + min / 1440;
    const alt = sunAltitude(jd, loc.latitude, loc.longitude);
    if (rise === null && prevAlt < HORIZON && alt >= HORIZON) {
      rise = refine(jdMid, min - STEP, min, loc, true);
    } else if (rise !== null && set === null && prevAlt >= HORIZON && alt < HORIZON) {
      set = refine(jdMid, min - STEP, min, loc, false);
      break; // sunrise and its sunset are both known
    }
    prevAlt = alt;
  }
  // Only report a day that actually starts within this local date.
  if (rise !== null && rise >= 24) return { rise: null, set: null };
  return { rise, set: set === null ? null : set };
}

/** Bisect within a 1-minute window to the crossing; returns local decimal hours. */
function refine(jdMid: number, lo: number, hi: number, loc: MuhurtaLocation, rising: boolean): number {
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    const alt = sunAltitude(jdMid + mid / 1440, loc.latitude, loc.longitude);
    const above = alt >= HORIZON;
    if (above === rising) hi = mid; else lo = mid;
  }
  return ((lo + hi) / 2) / 60; // minutes → hours
}

function hhmm(hours: number): string {
  let h = hours % 24;
  if (h < 0) h += 24;
  const hr = Math.floor(h);
  const mn = Math.round((h - hr) * 60);
  const H = mn === 60 ? hr + 1 : hr;
  const M = mn === 60 ? 0 : mn;
  return `${String(H).padStart(2, "0")}:${String(M).padStart(2, "0")}`;
}

function computePanchanga(jd: number, weekday: string): Panchanga {
  const jdTT = toTT(jd);
  const sunTrop = sunApparentLongitude(jdTT);
  const moonTrop = moonApparentLongitude(jdTT);
  const ayan = ayanamsaValue(jdTT, "Lahiri");
  const moonSid = norm360(moonTrop - ayan);
  const sunSid = norm360(sunTrop - ayan);

  const tithiIdx = Math.floor(norm360(moonTrop - sunTrop) / 12); // 0..29
  const tithiNum = tithiIdx + 1;
  const paksha: "Shukla" | "Krishna" = tithiIdx < 15 ? "Shukla" : "Krishna";
  const nameIdx = tithiIdx % 15;
  // The 15th tithi of each paksha is named outright (Purnima / Amavasya) —
  // prefixing it with the paksha would be redundant.
  const isSyzygy = nameIdx === 14;
  const baseName = isSyzygy ? (paksha === "Shukla" ? "Purnima" : "Amavasya") : TITHI_NAMES[nameIdx];
  const nakIdx = Math.floor(moonSid / (360 / 27)) % 27;
  const yogaIdx = Math.floor(norm360(sunSid + moonSid) / (360 / 27)) % 27;

  return {
    weekday,
    tithiNum,
    tithiName: isSyzygy ? baseName : `${paksha} ${baseName}`,
    paksha,
    nakshatra: NAKSHATRAS[nakIdx].name,
    nakshatraIndex: nakIdx,
    yoga: YOGA_NAMES[yogaIdx],
  };
}

function rateDay(p: Panchanga, weekdayIdx: number, activity: MuhurtaActivity): { rating: MuhurtaRating; score: number; reasons: string[] } {
  let score = 50;
  const reasons: string[] = [];
  const favSet = ACTIVITY_NAKSHATRAS[activity];

  // Nakshatra
  if (favSet.has(p.nakshatraIndex)) { score += 20; reasons.push(`${p.nakshatra} is favourable${activity !== "General" ? ` for ${activity.toLowerCase()}` : ""}.`); }
  else if (HARSH_NAKSHATRAS.has(p.nakshatraIndex)) { score -= 20; reasons.push(`${p.nakshatra} is a harsh nakshatra — generally avoided for new beginnings.`); }
  else { reasons.push(`${p.nakshatra} is neutral.`); }

  // Tithi — Rikta (4,9,14) and Amavasya are avoided; Purnima and Nanda/Jaya are good.
  const withinPaksha = ((p.tithiNum - 1) % 15) + 1;
  if ([4, 9, 14].includes(withinPaksha)) { score -= 15; reasons.push(`${p.tithiName} is a Rikta (empty) tithi — inauspicious for auspicious work.`); }
  else if (p.tithiName.includes("Amavasya")) { score -= 20; reasons.push("Amavasya (new moon) is avoided for auspicious beginnings."); }
  else if (p.tithiName.includes("Purnima")) { score += 5; reasons.push("Purnima (full moon) is generally auspicious."); }
  else { score += 8; reasons.push(`${p.tithiName} is a supportive tithi.`); }

  // Vara (weekday) — benefic-ruled days score higher.
  if ([1, 3, 4, 5].includes(weekdayIdx)) { score += 6; } // Mon, Wed, Thu, Fri
  else if ([2, 6].includes(weekdayIdx)) { score -= 6; reasons.push(`${WEEKDAYS[weekdayIdx]} (ruled by ${weekdayIdx === 2 ? "Mars" : "Saturn"}) is a harder day for auspicious starts.`); }

  // Inauspicious yogas
  if (["Vyatipata", "Vaidhriti", "Vishkambha", "Vajra", "Vyaghata", "Parigha", "Ganda", "Atiganda", "Shula"].includes(p.yoga)) {
    score -= 8; reasons.push(`${p.yoga} yoga is considered inauspicious.`);
  }

  const rating: MuhurtaRating = score >= 72 ? "excellent" : score >= 56 ? "good" : score >= 42 ? "average" : "avoid";
  return { rating, score, reasons };
}

function partWindows(riseH: number, setH: number, partIdx: number, count = 8): { from: string; to: string } {
  const dur = (setH - riseH) / count;
  const from = riseH + (partIdx - 1) * dur;
  return { from: hhmm(from), to: hhmm(from + dur) };
}

/** Compute the muhurta profile for one local date at a location. */
export function muhurtaForDate(date: Date, loc: MuhurtaLocation, activity: MuhurtaActivity = "General"): MuhurtaDay {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  const weekdayIdx = date.getUTCDay();
  const weekday = WEEKDAYS[weekdayIdx];
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  // Resolve the offset for THIS date when an IANA zone is known, so a range
  // crossing a DST transition doesn't carry a stale offset (which would shift
  // sunrise and every derived window by a full hour).
  const resolved: MuhurtaLocation = loc.zone
    ? { ...loc, tzOffsetHours: zoneOffsetHours(loc.zone, y, m, d, 12, 0) }
    : loc;
  loc = resolved;

  const { rise, set } = sunriseSunset(y, m, d, loc);
  // Panchanga computed at sunrise (Vedic convention); fall back to 6 am local.
  const jdSunrise = julianDayFromLocal(y, m, d, rise ?? 6, 0, 0, loc.tzOffsetHours);
  const panchanga = computePanchanga(jdSunrise, weekday);
  const { rating, score, reasons } = rateDay(panchanga, weekdayIdx, activity);

  const auspicious: TimeWindow[] = [];
  const inauspicious: TimeWindow[] = [];
  if (rise !== null && set !== null) {
    // Abhijit Muhurta — the 8th of 15 daytime parts (around local noon).
    const dayDur = set - rise;
    const abhijitStart = rise + (7 / 15) * dayDur;
    auspicious.push({ name: "Abhijit Muhurta", from: hhmm(abhijitStart), to: hhmm(abhijitStart + dayDur / 15) });
    // Brahma Muhurta — ~96 to ~48 minutes before sunrise.
    auspicious.push({ name: "Brahma Muhurta", from: hhmm(rise - 96 / 60), to: hhmm(rise - 48 / 60) });

    inauspicious.push({ name: "Rahu Kaal", ...partWindows(rise, set, RAHU_PART[weekdayIdx]) });
    inauspicious.push({ name: "Yamaganda", ...partWindows(rise, set, YAMA_PART[weekdayIdx]) });
    inauspicious.push({ name: "Gulika Kaal", ...partWindows(rise, set, GULIKA_PART[weekdayIdx]) });
  }

  return {
    date: iso, weekday,
    sunrise: rise === null ? null : hhmm(rise),
    sunset: set === null ? null : hhmm(set),
    panchanga, rating, score, reasons, auspicious, inauspicious,
  };
}

/** Muhurta profiles for `days` consecutive local dates starting at `start`. */
export function findMuhurta(start: Date, days: number, loc: MuhurtaLocation, activity: MuhurtaActivity = "General"): MuhurtaDay[] {
  const out: MuhurtaDay[] = [];
  const base = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  for (let i = 0; i < days; i++) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    out.push(muhurtaForDate(d, loc, activity));
  }
  return out;
}
