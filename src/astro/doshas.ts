// Dosha detection — the classic afflictions of a birth chart. Each detected
// dosha explains *why* it forms in this chart, what it traditionally signifies,
// and a customary remedy (upaya). Tone is educational and non-fatalistic: most
// doshas have well-known cancellations and remedies.

import { PlanetName, RASHIS } from "./constants";
import { Chart, PlanetPosition } from "./types";

export type DoshaSeverity = "high" | "moderate" | "low";

export interface Dosha {
  name: string;
  sanskrit?: string;
  severity: DoshaSeverity;
  planets: PlanetName[];
  houses?: number[];
  description: string; // why it forms in THIS chart
  effect: string; // what it traditionally signifies
  remedy: string; // customary upaya
  cancellation?: string; // mitigating factors present in this chart
}

function byName(chart: Chart): Record<PlanetName, PlanetPosition> {
  return Object.fromEntries(chart.planets.map((p) => [p.planet, p])) as Record<
    PlanetName,
    PlanetPosition
  >;
}

const KAAL_SARPA_TYPES = [
  "Anant", "Kulik", "Vasuki", "Shankhpal", "Padma", "Mahapadma",
  "Takshak", "Karkotak", "Shankhachud", "Ghatak", "Vishdhar", "Sheshnag",
];

/** House distance 1..12 (inclusive count) from one sign to another. */
function houseFrom(fromSign: number, toSign: number): number {
  return ((toSign - fromSign + 12) % 12) + 1;
}

export function detectDoshas(chart: Chart): Dosha[] {
  const p = byName(chart);
  const doshas: Dosha[] = [];
  const sign = (pl: PlanetName) => RASHIS[p[pl].signIndex].name;
  const sameSign = (a: PlanetName, b: PlanetName) => p[a].signIndex === p[b].signIndex;

  // ── Mangal (Manglik / Kuja) Dosha ─────────────────────────────────────
  // Mars in the 1st, 2nd, 4th, 7th, 8th or 12th house from the Lagna.
  const MANGLIK_HOUSES = [1, 2, 4, 7, 8, 12];
  if (MANGLIK_HOUSES.includes(p.Mars.house)) {
    const strong =
      p.Mars.dignity === "Exalted" ||
      p.Mars.dignity === "Own sign" ||
      p.Mars.dignity === "Moolatrikona";
    // Mars from the Moon too — a common cross-check.
    const fromMoon = houseFrom(p.Moon.signIndex, p.Mars.signIndex);
    const alsoFromMoon = MANGLIK_HOUSES.includes(fromMoon);
    doshas.push({
      name: "Mangal Dosha",
      sanskrit: "मंगल दोष (Manglik)",
      severity: strong ? "low" : p.Mars.house === 7 || p.Mars.house === 8 ? "high" : "moderate",
      planets: ["Mars"],
      houses: [p.Mars.house],
      description:
        `Mars occupies the ${ordinal(p.Mars.house)} house from the Lagna (in ${sign("Mars")})` +
        (alsoFromMoon ? `, and also falls in a Manglik house from the Moon` : "") +
        ". Mars in the 1st, 2nd, 4th, 7th, 8th or 12th is the classic Manglik placement.",
      effect:
        "Traditionally linked to friction, delay or intensity in marriage and partnerships, and a fiery, assertive temperament. Its impact is greatest for the 7th (marriage) and 8th (longevity of union) houses.",
      remedy:
        "Worship of Hanuman and recitation of the Hanuman Chalisa on Tuesdays; Mars mantra (Om Angarakaya Namah); matching with another Manglik chart is the classic mitigation. A red coral only after qualified advice.",
      cancellation: strong
        ? `Mars is ${p.Mars.dignity.toLowerCase()} here, which strongly reduces the dosha — a dignified Mars behaves constructively.`
        : (p.Mars.signIndex === 0 || p.Mars.signIndex === 7 || p.Mars.signIndex === 9)
          ? `Mars sits in ${sign("Mars")} (its own/exaltation sign), a recognised mitigating factor.`
          : undefined,
    });
  }

  // ── Kaal Sarpa Dosha ──────────────────────────────────────────────────
  // All seven planets hemmed on one side of the Rahu–Ketu axis.
  const arc = (lon: number) => (lon - p.Rahu.longitude + 360) % 360;
  const SEVEN: PlanetName[] = ["Sun", "Moon", "Mars", "Mercury", "Jupiter", "Venus", "Saturn"];
  const arcs = SEVEN.map((pl) => arc(p[pl].longitude));
  const firstHalf = arcs.every((a) => a <= 180);
  const secondHalf = arcs.every((a) => a >= 180);
  if (firstHalf || secondHalf) {
    const onAxis = arcs.some((a) => a < 1 || a > 359 || Math.abs(a - 180) < 1);
    const type = KAAL_SARPA_TYPES[(p.Rahu.house - 1 + 12) % 12];
    doshas.push({
      name: `Kaal Sarpa Dosha (${type})`,
      sanskrit: "काल सर्प दोष",
      severity: onAxis ? "moderate" : "high",
      planets: ["Rahu", "Ketu"],
      houses: [p.Rahu.house, p.Ketu.house],
      description:
        `Every one of the seven planets falls on one side of the Rahu–Ketu axis (Rahu in the ${ordinal(p.Rahu.house)}, Ketu in the ${ordinal(p.Ketu.house)} house). This "${type}" type is named for Rahu's house.` +
        (onAxis ? " One planet sits close to the axis, making this a partial Kaal Sarpa." : ""),
      effect:
        "Associated with a sense of struggle, sudden ups and downs, and effort that meets obstacles before results come — often with delayed but eventual success. Its felt strength depends heavily on the overall chart.",
      remedy:
        "Rahu–Ketu shanti / Kaal Sarpa puja (often at Trimbakeshwar or Kalahasti); Rahu and Ketu mantras; charity on Saturdays; a strong benefic (Jupiter) greatly softens it.",
    });
  }

  // ── Grahan Dosha (eclipse) — luminary with a node ─────────────────────
  const sunNode = sameSign("Sun", "Rahu") || sameSign("Sun", "Ketu");
  const moonNode = sameSign("Moon", "Rahu") || sameSign("Moon", "Ketu");
  if (sunNode) {
    const node: PlanetName = sameSign("Sun", "Rahu") ? "Rahu" : "Ketu";
    doshas.push({
      name: "Surya Grahan Dosha",
      sanskrit: "सूर्य ग्रहण दोष",
      severity: "moderate",
      planets: ["Sun", node],
      houses: [p.Sun.house],
      description: `The Sun is conjunct ${node} in ${sign("Sun")} (${ordinal(p.Sun.house)} house) — a "solar eclipse" combination.`,
      effect: "Can cloud confidence, vitality and the relationship with authority/father; often gives an unconventional but intense drive.",
      remedy: "Surya Namaskar and offering water (arghya) to the Sun at dawn; Aditya Hridaya Stotra; Sun and Rahu/Ketu mantras.",
    });
  }
  if (moonNode) {
    const node: PlanetName = sameSign("Moon", "Rahu") ? "Rahu" : "Ketu";
    doshas.push({
      name: "Chandra Grahan Dosha",
      sanskrit: "चंद्र ग्रहण दोष",
      severity: "moderate",
      planets: ["Moon", node],
      houses: [p.Moon.house],
      description: `The Moon is conjunct ${node} in ${sign("Moon")} (${ordinal(p.Moon.house)} house) — a "lunar eclipse" combination.`,
      effect: "Linked to emotional restlessness, anxiety or a vivid, impressionable mind. A strong, well-placed Moon eases it considerably.",
      remedy: "Monday fasting and worship of Shiva; chanting the Chandra mantra; a pearl only on qualified advice.",
    });
  }

  // ── Guru Chandal Dosha — Jupiter with a node ──────────────────────────
  if (sameSign("Jupiter", "Rahu") || sameSign("Jupiter", "Ketu")) {
    const node: PlanetName = sameSign("Jupiter", "Rahu") ? "Rahu" : "Ketu";
    doshas.push({
      name: node === "Rahu" ? "Guru Chandal Dosha" : "Guru Chandal Dosha (Ketu)",
      sanskrit: "गुरु चांडाल दोष",
      severity: "moderate",
      planets: ["Jupiter", node],
      houses: [p.Jupiter.house],
      description: `Jupiter (the guru) is conjunct ${node} in ${sign("Jupiter")} — wisdom meets the shadow planet.`,
      effect: "Can bring unconventional or questioning views on ethics, faith and teachers — brilliant and original, but sometimes at odds with tradition.",
      remedy: "Worship of Vishnu/Brihaspati and Thursday observance; Guru mantra; respect towards teachers and elders as a lived remedy.",
    });
  }

  // ── Angarak Dosha — Mars + Rahu ───────────────────────────────────────
  if (sameSign("Mars", "Rahu")) {
    doshas.push({
      name: "Angarak Dosha",
      sanskrit: "अंगारक दोष",
      severity: "moderate",
      planets: ["Mars", "Rahu"],
      houses: [p.Mars.house],
      description: `Mars and Rahu share ${sign("Mars")} (${ordinal(p.Mars.house)} house) — a fiery, explosive pairing.`,
      effect: "Associated with anger, impulsiveness, accidents or conflicts when uncontrolled; channelled well it gives fearless drive.",
      remedy: "Hanuman worship on Tuesdays; Mars and Rahu mantras; disciplined physical outlets for the energy.",
    });
  }

  // ── Shrapit Dosha — Saturn + Rahu ─────────────────────────────────────
  if (sameSign("Saturn", "Rahu")) {
    doshas.push({
      name: "Shrapit Dosha",
      sanskrit: "श्रापित दोष",
      severity: "high",
      planets: ["Saturn", "Rahu"],
      houses: [p.Saturn.house],
      description: `Saturn and Rahu are together in ${sign("Saturn")} (${ordinal(p.Saturn.house)} house) — the "cursed" combination.`,
      effect: "Traditionally indicates persistent delays, karmic burdens and slow-yielding effort — but great resilience and eventual, hard-won mastery.",
      remedy: "Saturn (Shani) worship on Saturdays; service to the elderly and needy; Shani and Rahu mantras; consistent, patient effort as the truest remedy.",
    });
  }

  // ── Pitra Dosha — afflicted Sun / 9th (ancestors) ─────────────────────
  const rahuOrKetuIn9 = p.Rahu.house === 9 || p.Ketu.house === 9;
  const sunAfflicted = sameSign("Sun", "Rahu") || sameSign("Sun", "Ketu") || sameSign("Sun", "Saturn");
  if (rahuOrKetuIn9 || sunAfflicted) {
    doshas.push({
      name: "Pitra Dosha",
      sanskrit: "पितृ दोष",
      severity: "moderate",
      planets: sunAfflicted ? ["Sun"] : p.Rahu.house === 9 ? ["Rahu"] : ["Ketu"],
      houses: [9],
      description: rahuOrKetuIn9
        ? `A shadow planet (${p.Rahu.house === 9 ? "Rahu" : "Ketu"}) sits in the 9th house of father, ancestors and dharma.`
        : `The Sun (father/ancestors) is conjunct ${sameSign("Sun", "Saturn") ? "Saturn" : sameSign("Sun", "Rahu") ? "Rahu" : "Ketu"} in ${sign("Sun")}.`,
      effect: "Points to unresolved ancestral karma — sometimes felt as recurring obstacles in progeny, lineage matters or fatherly relationships.",
      remedy: "Shraddha and Tarpan for ancestors (especially in Pitru Paksha); feeding of Brahmins, cows and crows; charity in the ancestors' name.",
    });
  }

  // ── Kemadruma Dosha — an isolated Moon ────────────────────────────────
  const occupied = new Set(chart.planets.map((x) => x.signIndex));
  const twoFromMoon = (p.Moon.signIndex + 1) % 12;
  const twelveFromMoon = (p.Moon.signIndex + 11) % 12;
  const conjunctMoon = chart.planets.some(
    (x) => x.planet !== "Moon" && x.planet !== "Sun" && x.signIndex === p.Moon.signIndex,
  );
  if (!(occupied.has(twoFromMoon) || occupied.has(twelveFromMoon) || conjunctMoon)) {
    doshas.push({
      name: "Kemadruma Dosha",
      sanskrit: "केमद्रुम दोष",
      severity: "moderate",
      planets: ["Moon"],
      houses: [p.Moon.house],
      description: "The Moon has no planet in the sign before or after it, and none alongside — an unsupported Moon.",
      effect: "Can bring emotional isolation or fluctuating fortune, but is readily cancelled by benefic aspects, a kendra Moon, or a strong Jupiter/Venus.",
      remedy: "Monday worship of Shiva; strengthening the Moon (white foods, water charity); cultivating steady emotional support and routine.",
    });
  }

  // ── Shakata Dosha — Moon in 6/8/12 from Jupiter ───────────────────────
  const moonFromJup = houseFrom(p.Jupiter.signIndex, p.Moon.signIndex);
  if ([6, 8, 12].includes(moonFromJup)) {
    doshas.push({
      name: "Shakata Dosha",
      sanskrit: "शकट दोष",
      severity: "low",
      planets: ["Moon", "Jupiter"],
      description: `The Moon lies in the ${ordinal(moonFromJup)} house from Jupiter (a 6/8/12 "shakata" relationship).`,
      effect: "The 'cartwheel' dosha — fortune that rises and falls in cycles. Mild, and cancelled when the Moon is in a kendra from the Lagna.",
      remedy: "Strengthen Jupiter (Thursday worship, respect for mentors) and the Moon; patience through the down-cycles.",
    });
  }

  return doshas;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
