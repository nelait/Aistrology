// Event analysis: given a chart and a dated life event, work out what classical
// Jyotisha reads in that moment — and, just as importantly, how much better
// that reading is than one for a date picked at random.
//
// The scoring is entirely deterministic and driven by the prior in
// eventKaraka.ts. No LLM is involved: a model may later narrate these reasons,
// but it must never be the thing that produces them.
//
// This module is also the scoring function birth-time rectification will run in
// a loop over candidate birth times. See docs/rectification-and-event-analysis.md.

import { PlanetName, RASHIS } from "./constants";
import { Chart, DashaPeriod } from "./types";
import { computeVimshottari, activePeriod } from "./dasha";
import { birthDateUT } from "./engine";
import { computeTransits, sadeSati } from "./transits";
import { aspectedSigns } from "./aspects";
import { divisionalSign } from "./varga";
import { detectYogas, Yoga } from "./yogas";
import {
  EVENT_KARAKA_BY_ID,
  EventKaraka,
  EventTypeId,
  DatePrecision,
  EventConfidence,
  PRECISION_WINDOW_DAYS,
} from "./eventKaraka";

const DAY_MS = 86_400_000;

export interface LifeEventInput {
  id?: string;
  type: EventTypeId;
  date: Date;
  precision: DatePrecision;
  confidence: EventConfidence;
  note?: string;
}

export type ReasonLayer = "dasha" | "boundary" | "transit" | "varga" | "yoga";

export interface EventReason {
  layer: ReasonLayer;
  points: number;
  text: string;
  source?: string;
}

/**
 * Bands, not percentages. A raw score out of 100 invites being read as "94%
 * likely", which it is not — see `percentile` for the number that means
 * something.
 */
export type EventBand = "strong" | "moderate" | "weak" | "unsupported";

export interface EventAnalysis {
  type: EventTypeId;
  label: string;
  date: Date;
  /** Raw total, 0..100. UNCALIBRATED — do not present this as a percentage. */
  score: number;
  /**
   * Where this date's score falls against `nullSamples` random dates in the
   * same life, scored the same way for the same event type. 0..100, or null if
   * the null arm was disabled. THIS is the number worth showing a user: it is
   * self-calibrating and it collapses to ~50 when the scoring is meaningless.
   */
  percentile: number | null;
  band: EventBand;
  /** e.g. "Saturn / Mercury / Venus" — the MD / AD / PD lords on the date. */
  periodLabel: string;
  mahadasha: PlanetName | null;
  antardasha: PlanetName | null;
  pratyantardasha: PlanetName | null;
  reasons: EventReason[];
  /** What the chart does NOT support. A system that only ever agrees is broken. */
  dissent: string[];
  /** Set when the classically-indicated varga is not computed by this engine. */
  vargaNote?: string;
}

// ── Chart helpers ─────────────────────────────────────────────────────────

/** Lord of the sign occupying house `h` (1..12). */
function lordOfHouse(chart: Chart, h: number): PlanetName {
  return RASHIS[chart.houseSigns[h - 1]].lord as PlanetName;
}

/** Houses (1..12) whose sign is owned by `planet`. Rahu/Ketu own none. */
function housesOwnedBy(chart: Chart, planet: PlanetName): number[] {
  const out: number[] = [];
  for (let h = 1; h <= 12; h++) if (lordOfHouse(chart, h) === planet) out.push(h);
  return out;
}

/** The house a planet occupies, or 0 if it is not in the chart. */
function houseOf(chart: Chart, planet: PlanetName): number {
  return chart.planets.find((p) => p.planet === planet)?.house ?? 0;
}

/** Houses aspected by `planet` from where it sits. */
function housesAspectedBy(chart: Chart, planet: PlanetName): number[] {
  const p = chart.planets.find((x) => x.planet === planet);
  if (!p) return [];
  return aspectedSigns(planet, p.signIndex).map(
    (sign) => ((sign - chart.ascendantSign + 12) % 12) + 1,
  );
}

const DUSTHANAS = [6, 8, 12];

// ── The dasha layer ───────────────────────────────────────────────────────

interface LordVerdict {
  /** 0..1 — how strongly this lord connects to the event's karaka houses. */
  relevance: number;
  why: string | null;
}

/**
 * How strongly one dasha lord relates to an event's significations.
 *
 * The ladder is ordered by how directly the classical texts make the link:
 * being the karaka itself, then owning the primary bhava, then occupying it,
 * then the secondary bhavas, then aspect. Only the strongest link is counted —
 * a lord that owns AND occupies the 7th does not score twice, because the
 * texts do not make it twice as likely, and stacking is exactly how a scorer
 * starts explaining everything.
 */
function lordRelevance(chart: Chart, lord: PlanetName, k: EventKaraka): LordVerdict {
  const owns = housesOwnedBy(chart, lord);
  const occupies = houseOf(chart, lord);
  const aspects = housesAspectedBy(chart, lord);
  const inPrimary = (hs: number[]) => hs.filter((h) => k.primaryHouses.includes(h));
  const inSecondary = (hs: number[]) => hs.filter((h) => k.secondaryHouses.includes(h));

  if (k.karakas.includes(lord)) {
    return { relevance: 1, why: `${lord} is the natural karaka of this matter` };
  }
  const ownPrimary = inPrimary(owns);
  if (ownPrimary.length) {
    return { relevance: 0.95, why: `${lord} owns the ${ordinalHouse(ownPrimary[0])}` };
  }
  if (k.primaryHouses.includes(occupies)) {
    return { relevance: 0.8, why: `${lord} occupies the ${ordinalHouse(occupies)}` };
  }
  const ownSecondary = inSecondary(owns);
  if (ownSecondary.length) {
    return { relevance: 0.6, why: `${lord} owns the ${ordinalHouse(ownSecondary[0])}` };
  }
  if (k.secondaryHouses.includes(occupies)) {
    return { relevance: 0.5, why: `${lord} occupies the ${ordinalHouse(occupies)}` };
  }
  const aspPrimary = inPrimary(aspects);
  if (aspPrimary.length) {
    return { relevance: 0.4, why: `${lord} aspects the ${ordinalHouse(aspPrimary[0])}` };
  }
  const aspSecondary = inSecondary(aspects);
  if (aspSecondary.length) {
    return { relevance: 0.25, why: `${lord} aspects the ${ordinalHouse(aspSecondary[0])}` };
  }
  return { relevance: 0, why: null };
}

/**
 * Polarity adjustment. Saturn ruling the 8th is evidence FOR a job loss and
 * evidence AGAINST a promotion; a scorer blind to direction would score both
 * identically and would therefore be measuring nothing.
 */
function polarityAdjustment(chart: Chart, lord: PlanetName, k: EventKaraka): number {
  if (k.polarity === "neutral") return 1;
  const ownsDusthana = housesOwnedBy(chart, lord).some((h) => DUSTHANAS.includes(h));
  const inDusthana = DUSTHANAS.includes(houseOf(chart, lord));
  const afflicted = ownsDusthana || inDusthana;
  if (k.polarity === "malefic") return afflicted ? 1.15 : 0.85;
  return afflicted ? 0.85 : 1.15;
}

function ordinalHouse(h: number): string {
  const s = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th", "11th", "12th"];
  return `${s[h]} house`;
}

// ── The scorer ────────────────────────────────────────────────────────────

const MAX_DASHA = 48; // MD 24 + AD 16 + PD 8
const MAX_BOUNDARY = 14;
const MAX_TRANSIT = 22;
const MAX_VARGA = 10;
const MAX_YOGA = 6;

export interface AnalyseOptions {
  /**
   * How many random dates to score for the null comparison. 0 disables it.
   * ~200 costs a few milliseconds and is what makes `percentile` meaningful.
   */
  nullSamples?: number;
  /** Precomputed dasha tree, to avoid rebuilding it per event. */
  dashas?: DashaPeriod[];
  /** Precomputed natal yogas — chart-level, so hoisted out of the date loop. */
  yogas?: Yoga[];
  /** Deterministic seed for the null sampling, so results are reproducible. */
  seed?: number;
}

/** Small deterministic PRNG — the null arm must be reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build the 120-year Vimshottari tree for a chart, anchored correctly in UT. */
export function dashaTreeFor(chart: Chart): DashaPeriod[] {
  const moonLon = chart.planets.find((p) => p.planet === "Moon")!.longitude;
  return computeVimshottari(moonLon, birthDateUT(chart.birth), 120, 3);
}

interface RawScore {
  total: number;
  reasons: EventReason[];
  dissent: string[];
  md: PlanetName | null;
  ad: PlanetName | null;
  pd: PlanetName | null;
}

/** The whole scoring pipeline for one date. Called once for the real event and
 *  once per null sample, so it must stay cheap and side-effect free. */
function scoreDate(
  chart: Chart,
  dashas: DashaPeriod[],
  yogas: Yoga[],
  k: EventKaraka,
  when: Date,
  windowDays: number,
  collectReasons: boolean,
): RawScore {
  const reasons: EventReason[] = [];
  const dissent: string[] = [];
  let total = 0;

  // ── Layer 1: dasha lords ────────────────────────────────────────────────
  const maha = activePeriod(dashas, when);
  const antar = maha?.children ? activePeriod(maha.children, when) : undefined;
  const praty = antar?.children ? activePeriod(antar.children, when) : undefined;

  const levels: Array<{ lord: PlanetName | undefined; cap: number; name: string }> = [
    { lord: maha?.lord, cap: 24, name: "Mahadasha" },
    { lord: antar?.lord, cap: 16, name: "Antardasha" },
    { lord: praty?.lord, cap: 8, name: "Pratyantardasha" },
  ];

  let dashaHits = 0;
  for (const lvl of levels) {
    if (!lvl.lord) continue;
    const v = lordRelevance(chart, lvl.lord, k);
    if (v.relevance <= 0) continue;
    const pts = v.relevance * lvl.cap * polarityAdjustment(chart, lvl.lord, k);
    total += pts;
    dashaHits++;
    if (collectReasons) {
      reasons.push({
        layer: "dasha",
        points: round1(pts),
        text: `${lvl.name} of ${lvl.lord}: ${v.why}.`,
        source: k.source,
      });
    }
  }
  if (collectReasons && dashaHits === 0) {
    dissent.push(
      `No dasha lord running on this date (${levels.filter((l) => l.lord).map((l) => l.lord).join(", ")}) ` +
        `connects to the ${k.primaryHouses.map(ordinalHouse).join(" or ")} or to ` +
        `${k.karakas.join("/")} — classically the chart does not indicate this event here.`,
    );
  }

  // ── Layer 2: boundary proximity ─────────────────────────────────────────
  // Only for events the texts treat as happening AT a moment. A long illness
  // has no reason to coincide with a period change, and rewarding it for one
  // would be manufacturing agreement.
  if (k.timing !== "state") {
    const boundaries: Array<{ at: Date; label: string }> = [];
    if (maha) boundaries.push({ at: maha.start, label: `${maha.lord} Mahadasha` });
    if (antar) boundaries.push({ at: antar.start, label: `${antar.lord} Antardasha` });
    let best = 0;
    let bestLabel = "";
    for (const b of boundaries) {
      const days = Math.abs(when.getTime() - b.at.getTime()) / DAY_MS;
      const reach = k.timing === "change" ? windowDays + 60 : windowDays + 20;
      if (days > reach) continue;
      const near = 1 - days / reach;
      if (near > best) { best = near; bestLabel = b.label; }
    }
    if (best > 0) {
      const pts = best * MAX_BOUNDARY * (k.timing === "change" ? 1 : 0.5);
      total += pts;
      if (collectReasons) {
        reasons.push({
          layer: "boundary",
          points: round1(pts),
          text: `The date falls close to the start of the ${bestLabel} — classically a hinge where matters turn over.`,
          source: "Brihat Parashara Hora Shastra",
        });
      }
    }
  }

  // ── Layer 3: transits ───────────────────────────────────────────────────
  const transits = computeTransits(chart, when);
  const jup = transits.find((t) => t.planet === "Jupiter")!;
  const sat = transits.find((t) => t.planet === "Saturn")!;
  const ss = sadeSati(transits);
  let transitPts = 0;

  if (k.primaryHouses.includes(jup.houseFromLagna)) {
    const pts = k.polarity === "malefic" ? 3 : 9;
    transitPts += pts;
    if (collectReasons) {
      reasons.push({
        layer: "transit",
        points: pts,
        text: `Transiting Jupiter was in the ${ordinalHouse(jup.houseFromLagna)}, supporting it by presence.`,
        source: "Phaladeepika",
      });
    }
  }
  if (k.primaryHouses.includes(sat.houseFromLagna)) {
    const pts = k.polarity === "malefic" ? 9 : 3;
    transitPts += pts;
    if (collectReasons) {
      reasons.push({
        layer: "transit",
        points: pts,
        text: `Transiting Saturn was in the ${ordinalHouse(sat.houseFromLagna)}, pressing on the matter.`,
        source: "Phaladeepika",
      });
    }
  }
  if (ss.active && k.polarity === "malefic") {
    transitPts += 7;
    if (collectReasons) {
      reasons.push({
        layer: "transit",
        points: 7,
        text: `Sade Sati was running (${ss.phase}) — Saturn's passage over the natal Moon.`,
        source: "Traditional Jyotisha practice",
      });
    }
  }
  if (ss.active && k.polarity === "benefic" && collectReasons) {
    dissent.push(
      `Sade Sati was running (${ss.phase}), which classically weighs against an easy outcome here.`,
    );
  }
  total += Math.min(transitPts, MAX_TRANSIT);

  // ── Layer 4: varga ──────────────────────────────────────────────────────
  // The lord of the relevant divisional lagna, and whether the running dasha
  // lords touch it.
  if (k.varga !== "D1") {
    const vLagnaSign = divisionalSign(chart.ascendant, k.varga);
    const vLord = RASHIS[vLagnaSign].lord as PlanetName;
    const running = [maha?.lord, antar?.lord].filter(Boolean) as PlanetName[];
    if (running.includes(vLord)) {
      total += MAX_VARGA;
      if (collectReasons) {
        reasons.push({
          layer: "varga",
          points: MAX_VARGA,
          text: `${vLord} rules the ${k.varga} lagna and was running as a dasha lord — the divisional chart for this matter was active.`,
          source: k.source,
        });
      }
    } else if (collectReasons) {
      dissent.push(
        `${vLord}, lord of the ${k.varga} lagna (the divisional chart classically read for this), was not among the running dasha lords.`,
      );
    }
  }

  // ── Layer 5: yogas activated by the running lords ───────────────────────
  // NB: this must run for null samples too, not only when reasons are being
  // collected. It did not, at first — the real event could pick up 6 points the
  // null pool could never earn, which pushed every percentile up by about six.
  // The null test caught it; nothing else would have.
  {
    const running = [maha?.lord, antar?.lord].filter(Boolean) as PlanetName[];
    const wantChallenging = k.polarity === "malefic";
    for (const y of yogas) {
      if (!y.planets.some((p) => running.includes(p))) continue;
      const aligned =
        k.polarity === "neutral" ||
        (wantChallenging ? y.category === "Challenging" : y.category !== "Challenging");
      if (!aligned) continue;
      total += MAX_YOGA;
      if (collectReasons) {
        reasons.push({
          layer: "yoga",
          points: MAX_YOGA,
          text: `${y.name} involves ${y.planets.join(" and ")}, and one of them was running — the yoga was live in this period.`,
          source: "Brihat Parashara Hora Shastra",
        });
      }
      break; // one yoga only; stacking them is how a score stops meaning anything
    }
  }

  return {
    total: Math.min(100, total),
    reasons,
    dissent,
    md: maha?.lord ?? null,
    ad: antar?.lord ?? null,
    pd: praty?.lord ?? null,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function bandFor(percentile: number | null, score: number): EventBand {
  // Prefer the calibrated number whenever it is available.
  const basis = percentile ?? score;
  if (basis >= 85) return "strong";
  if (basis >= 60) return "moderate";
  if (basis >= 35) return "weak";
  return "unsupported";
}

/**
 * Analyse one dated event against a chart.
 *
 * The `percentile` in the result is the honest output: the same scoring run
 * against `nullSamples` random dates in the same life. If the classical rules
 * carry no signal for this chart, real dates score like random ones and the
 * percentile sits near 50 — which is exactly what should be shown.
 */
export function analyseEvent(
  chart: Chart,
  event: LifeEventInput,
  options: AnalyseOptions = {},
): EventAnalysis {
  const k = EVENT_KARAKA_BY_ID[event.type];
  const dashas = options.dashas ?? dashaTreeFor(chart);
  const yogas = options.yogas ?? detectYogas(chart);
  const windowDays = PRECISION_WINDOW_DAYS[event.precision];

  const real = scoreDate(chart, dashas, yogas, k, event.date, windowDays, true);

  // ── Null arm ────────────────────────────────────────────────────────────
  const n = options.nullSamples ?? 200;
  let percentile: number | null = null;
  if (n > 0) {
    const birth = birthDateUT(chart.birth).getTime();
    // Sample from birth to the later of the event and today, so the comparison
    // pool is the span of life in which the event could have fallen at all.
    const until = Math.max(event.date.getTime(), Date.now());
    const span = until - birth;
    if (span > 365 * DAY_MS) {
      const rnd = mulberry32(options.seed ?? hashSeed(chart, event));
      let below = 0;
      let ties = 0;
      for (let i = 0; i < n; i++) {
        const at = new Date(birth + rnd() * span);
        const s = scoreDate(chart, dashas, yogas, k, at, windowDays, false).total;
        if (s < real.total) below++;
        else if (s === real.total) ties++;
      }
      // Mid-rank convention. The scoring is coarse — long stretches of a life
      // share the same dasha lords and score identically — so ties are common,
      // and counting them as "beaten" inflated every result by ~6 points.
      // Measured over 480 random chart/event/date triples: 55.9 before, 50.2
      // after, against the 50.0 a meaningless scorer must produce.
      percentile = Math.round(((below + ties / 2) / n) * 100);
    }
  }

  return {
    type: event.type,
    label: k.label,
    date: event.date,
    score: round1(real.total),
    percentile,
    band: bandFor(percentile, real.total),
    periodLabel: [real.md, real.ad, real.pd].filter(Boolean).join(" / "),
    mahadasha: real.md,
    antardasha: real.ad,
    pratyantardasha: real.pd,
    reasons: real.reasons.sort((a, b) => b.points - a.points),
    dissent: real.dissent,
    vargaNote: k.vargaWanted
      ? `Classically this is read in the ${k.vargaWanted}, which this engine does not yet compute; ${k.varga} is used instead.`
      : undefined,
  };
}

/**
 * The raw score for one date, with no reasons collected and no null arm.
 *
 * This is the hot path birth-time rectification will call once per candidate
 * birth time per event, and it is also the exact invariant worth testing:
 * scoring must not depend on whether anyone is listening. `analyseEvent` on the
 * same date must return this number — when it did not, the real event was
 * quietly earning points the null pool could never match.
 */
export function scoreEventDate(
  chart: Chart,
  event: LifeEventInput,
  options: Pick<AnalyseOptions, "dashas" | "yogas"> = {},
): number {
  const k = EVENT_KARAKA_BY_ID[event.type];
  const dashas = options.dashas ?? dashaTreeFor(chart);
  const yogas = options.yogas ?? detectYogas(chart);
  return round1(
    scoreDate(chart, dashas, yogas, k, event.date, PRECISION_WINDOW_DAYS[event.precision], false)
      .total,
  );
}

/** Stable seed per (chart, event) so the null arm is reproducible. */
function hashSeed(chart: Chart, event: LifeEventInput): number {
  const s = `${chart.julianDayUT}|${event.type}|${event.date.getTime()}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

/** Analyse a list of events, building the dasha tree once. */
export function analyseEvents(
  chart: Chart,
  events: LifeEventInput[],
  options: AnalyseOptions = {},
): EventAnalysis[] {
  const dashas = options.dashas ?? dashaTreeFor(chart);
  const yogas = options.yogas ?? detectYogas(chart);
  return events
    .map((e) => analyseEvent(chart, e, { ...options, dashas, yogas }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}
