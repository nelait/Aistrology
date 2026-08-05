// Daily and weekly forecasts. These combine what the chart already knows how to
// compute — the running Vimshottari period (the "weather system") and the day's
// transits read from the natal Moon (the fast, day-to-day colour, "gochara").

import { PlanetName, RASHIS, NAKSHATRAS } from "./constants";
import { Chart } from "./types";
import { computeTransits, sadeSati, TransitPosition } from "./transits";
import { computeVimshottari, activePeriod } from "./dasha";
import { birthDateUT } from "./engine";

export type Tone = "Favorable" | "Mixed" | "Challenging";

export interface DailyForecast {
  date: Date;
  moonSign: number;
  moonNakshatra: number;
  moonHouseFromMoon: number; // Chandra transit house from the natal Moon
  dashaMaha?: PlanetName;
  dashaAntar?: PlanetName;
  favorable: number;
  challenging: number;
  tone: Tone;
  sadeSati: boolean;
  highlights: string[];
  summary: string;
}

export interface WeeklyForecast {
  start: Date;
  end: Date;
  days: DailyForecast[];
  dashaMaha?: PlanetName;
  dashaAntar?: PlanetName;
  tone: Tone;
  moonSigns: number[]; // distinct signs the Moon visits during the week
  summary: string;
}

const BENEFICS: PlanetName[] = ["Jupiter", "Venus", "Moon", "Mercury"];

function toneFrom(favorable: number, challenging: number): Tone {
  if (favorable >= challenging + 2) return "Favorable";
  if (challenging >= favorable + 2) return "Challenging";
  return "Mixed";
}

/** Noon UTC of a given day — representative for the slow bodies. */
function atNoon(day: Date): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12));
}

function runningDasha(chart: Chart, when: Date): { maha?: PlanetName; antar?: PlanetName } {
  const moonLon = chart.planets.find((p) => p.planet === "Moon")!.longitude;
  const timeline = computeVimshottari(moonLon, birthDateUT(chart.birth), 120, 2);
  const maha = activePeriod(timeline, when);
  const antar = maha?.children ? activePeriod(maha.children, when) : undefined;
  return { maha: maha?.lord, antar: antar?.lord };
}

function buildHighlights(transits: TransitPosition[], sadeSatiActive: boolean): string[] {
  const out: string[] = [];
  const by = (name: PlanetName) => transits.find((t) => t.planet === name)!;

  const jup = by("Jupiter");
  if (jup.gochara === "Favorable") {
    out.push(`Jupiter is favourable in the ${ordinal(jup.houseFromMoon)} from your Moon — support and growth.`);
  }
  const ven = by("Venus");
  if (ven.gochara === "Favorable") {
    out.push(`Venus favours the ${ordinal(ven.houseFromMoon)} — comfort, relationships and ease.`);
  }
  const sat = by("Saturn");
  if (sadeSatiActive) {
    out.push("Sade Sati is running — pace yourself; steady effort pays off.");
  } else if (sat.gochara === "Challenging") {
    out.push(`Saturn tests the ${ordinal(sat.houseFromMoon)} — patience and discipline are asked of you.`);
  }
  const mars = by("Mars");
  if (mars.gochara === "Challenging") {
    out.push(`Mars stirs the ${ordinal(mars.houseFromMoon)} — guard against haste and friction.`);
  }
  return out;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Forecast for a single day. */
export function dailyForecast(chart: Chart, day: Date): DailyForecast {
  const when = atNoon(day);
  const transits = computeTransits(chart, when);
  const moon = transits.find((t) => t.planet === "Moon")!;
  const favorable = transits.filter((t) => t.gochara === "Favorable").length;
  const challenging = transits.length - favorable;
  const tone = toneFrom(favorable, challenging);
  const { maha, antar } = runningDasha(chart, when);
  const sadeSatiActive = sadeSati(transits).active;
  const highlights = buildHighlights(transits, sadeSatiActive);

  const moonLine =
    `The Moon transits ${RASHIS[moon.signIndex].name} (${NAKSHATRAS[moon.nakshatraIndex].name}), ` +
    `the ${ordinal(moon.houseFromMoon)} from your birth Moon`;
  const dashaLine = maha
    ? ` Under your ${maha}${antar && antar !== maha ? `–${antar}` : ""} dasha, this ${tone.toLowerCase()} day`
    : ` This ${tone.toLowerCase()} day`;
  const summary =
    `${moonLine}.${dashaLine} favours ` +
    (tone === "Favorable"
      ? "initiative and putting yourself forward."
      : tone === "Challenging"
        ? "care, rest and finishing rather than starting."
        : "steady, measured progress on what already matters.");

  return {
    date: when,
    moonSign: moon.signIndex,
    moonNakshatra: moon.nakshatraIndex,
    moonHouseFromMoon: moon.houseFromMoon,
    dashaMaha: maha,
    dashaAntar: antar,
    favorable,
    challenging,
    tone,
    sadeSati: sadeSatiActive,
    highlights,
    summary,
  };
}

/** Forecast across a 7-day week beginning at `weekStart`. */
export function weeklyForecast(chart: Chart, weekStart: Date): WeeklyForecast {
  const days: DailyForecast[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate() + i));
    days.push(dailyForecast(chart, d));
  }
  const end = days[6].date;
  const favorable = days.reduce((s, d) => s + d.favorable, 0);
  const challenging = days.reduce((s, d) => s + d.challenging, 0);
  const tone = toneFrom(favorable / 7, challenging / 7);
  const { maha, antar } = runningDasha(chart, atNoon(weekStart));

  const moonSigns: number[] = [];
  for (const d of days) if (!moonSigns.includes(d.moonSign)) moonSigns.push(d.moonSign);

  const best = days.reduce((a, b) => (b.favorable > a.favorable ? b : a));
  const hardest = days.reduce((a, b) => (b.challenging > a.challenging ? b : a));
  const dayName = (d: Date) =>
    d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });

  const summary =
    (maha ? `With your ${maha}${antar && antar !== maha ? `–${antar}` : ""} dasha running, this ` : "This ") +
    `is a broadly ${tone.toLowerCase()} week. The Moon moves through ` +
    `${moonSigns.map((s) => RASHIS[s].name).join(", ")}. ` +
    `${dayName(best.date)} looks the most supportive; ` +
    `${dayName(hardest.date)} asks for the most care.`;

  return { start: days[0].date, end, days, dashaMaha: maha, dashaAntar: antar, tone, moonSigns, summary };
}
