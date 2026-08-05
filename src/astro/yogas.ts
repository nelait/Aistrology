// Yoga detection — a curated set of the most widely-taught planetary
// combinations. Each detected yoga carries a plain-language explanation so the
// app can teach *why* it forms, not just that it did.

import { PlanetName } from "./constants";
import { Chart, PlanetPosition } from "./types";

export interface Yoga {
  name: string;
  sanskrit?: string;
  category: "Raja" | "Dhana" | "Benefic" | "Challenging" | "Mahapurusha";
  planets: PlanetName[];
  description: string;
  effect: string;
}

function byName(chart: Chart): Record<PlanetName, PlanetPosition> {
  return Object.fromEntries(chart.planets.map((p) => [p.planet, p])) as Record<
    PlanetName,
    PlanetPosition
  >;
}

/** House distance from a to b (1..12, inclusive count). */
function houseDistance(fromSign: number, toSign: number): number {
  return ((toSign - fromSign + 12) % 12) + 1;
}

const KENDRAS = [1, 4, 7, 10];

export function detectYogas(chart: Chart): Yoga[] {
  const p = byName(chart);
  const yogas: Yoga[] = [];

  // --- Gaja Kesari Yoga: Jupiter in a kendra (1,4,7,10) from the Moon. ---
  const jupFromMoon = houseDistance(p.Moon.signIndex, p.Jupiter.signIndex);
  if (KENDRAS.includes(jupFromMoon)) {
    yogas.push({
      name: "Gaja Kesari Yoga",
      sanskrit: "गजकेसरी योग",
      category: "Benefic",
      planets: ["Jupiter", "Moon"],
      description:
        "Jupiter occupies a kendra (1st, 4th, 7th or 10th) counted from the Moon.",
      effect:
        "The elephant-and-lion yoga: a well-regarded combination for intelligence, good reputation, moral courage and lasting respect in society.",
    });
  }

  // --- Budha-Aditya Yoga: Sun and Mercury in the same sign. ---
  if (p.Sun.signIndex === p.Mercury.signIndex) {
    yogas.push({
      name: "Budha-Aditya Yoga",
      category: "Benefic",
      planets: ["Sun", "Mercury"],
      description: "The Sun and Mercury occupy the same sign.",
      effect:
        "Sharp intellect, skill in communication and administration, and success through learning — provided Mercury is not too close to the Sun (combust).",
    });
  }

  // --- Chandra-Mangala Yoga: Moon and Mars conjunct. ---
  if (p.Moon.signIndex === p.Mars.signIndex) {
    yogas.push({
      name: "Chandra-Mangala Yoga",
      category: "Dhana",
      planets: ["Moon", "Mars"],
      description: "The Moon and Mars occupy the same sign.",
      effect:
        "A wealth-generating combination associated with enterprise, drive and earning power, though it can bring emotional intensity.",
    });
  }

  // --- Pancha Mahapurusha Yogas: Mars/Mercury/Jupiter/Venus/Saturn in own or
  //     exalted sign AND in a kendra from the Lagna. ---
  const mahapurusha: Array<[PlanetName, string, string]> = [
    ["Mars", "Ruchaka", "courage, leadership, a commanding physique and martial ability"],
    ["Mercury", "Bhadra", "eloquence, intelligence, business acumen and a youthful nature"],
    ["Jupiter", "Hamsa", "wisdom, righteousness, spirituality and a respected, teacher-like character"],
    ["Venus", "Malavya", "beauty, luxury, artistic talent, comforts and marital happiness"],
    ["Saturn", "Sasa", "discipline, authority over others, endurance and rise through hard work"],
  ];
  for (const [planet, yogaName, effect] of mahapurusha) {
    const pos = p[planet];
    const inKendra = KENDRAS.includes(pos.house);
    const strong = pos.dignity === "Exalted" || pos.dignity === "Own sign" || pos.dignity === "Moolatrikona";
    if (inKendra && strong) {
      yogas.push({
        name: `${yogaName} Yoga`,
        category: "Mahapurusha",
        planets: [planet],
        description: `${planet} sits in its own or exaltation sign and in a kendra (angular house) from the Lagna.`,
        effect: `One of the five "great person" yogas, granting ${effect}.`,
      });
    }
  }

  // --- Kemadruma Yoga: no planet (other than Sun) in the 2nd or 12th from the
  //     Moon and no planet with the Moon — an isolated, unsupported Moon. ---
  const occupied = new Set(chart.planets.map((x) => x.signIndex));
  const twoFromMoon = (p.Moon.signIndex + 1) % 12;
  const twelveFromMoon = (p.Moon.signIndex + 11) % 12;
  const conjunctMoon = chart.planets.some(
    (x) => x.planet !== "Moon" && x.planet !== "Sun" && x.signIndex === p.Moon.signIndex,
  );
  const support =
    occupied.has(twoFromMoon) || occupied.has(twelveFromMoon) || conjunctMoon;
  if (!support) {
    yogas.push({
      name: "Kemadruma Yoga",
      category: "Challenging",
      planets: ["Moon"],
      description:
        "The Moon has no planets in the signs immediately before or after it, and none alongside it.",
      effect:
        "An unsupported Moon can indicate emotional isolation, instability of fortune or struggle — but it is readily cancelled by benefic aspects and a strong Moon.",
    });
  }

  // --- Sunapha / Anapha / Durudhara: planets (not Sun) in 2nd / 12th / both
  //     from the Moon — the counterpoints to Kemadruma. ---
  const has2 = chart.planets.some((x) => x.planet !== "Sun" && x.planet !== "Moon" && x.signIndex === twoFromMoon);
  const has12 = chart.planets.some((x) => x.planet !== "Sun" && x.planet !== "Moon" && x.signIndex === twelveFromMoon);
  if (has2 && has12) {
    yogas.push({
      name: "Durudhara Yoga",
      category: "Dhana",
      planets: ["Moon"],
      description: "Planets flank the Moon on both sides (2nd and 12th from it).",
      effect: "Comfort, generosity, wealth and a well-supported, balanced mind.",
    });
  } else if (has2) {
    yogas.push({
      name: "Sunapha Yoga",
      category: "Benefic",
      planets: ["Moon"],
      description: "A planet (other than the Sun) occupies the 2nd from the Moon.",
      effect: "Self-earned wealth, intelligence and a good reputation.",
    });
  } else if (has12) {
    yogas.push({
      name: "Anapha Yoga",
      category: "Benefic",
      planets: ["Moon"],
      description: "A planet (other than the Sun) occupies the 12th from the Moon.",
      effect: "Health, character, comforts and a well-known, pleasant personality.",
    });
  }

  return yogas;
}
