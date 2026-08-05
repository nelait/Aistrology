// Friendship compatibility engine for Vedic astrology.
// Uses a modified scoring system that emphasises mental rapport, communication,
// temperament and shared values — rather than the sexual/physical/progeny factors
// that dominate marriage matching.
//
// Scored out of 30 points across 6 factors.

import { Chart } from "./types";
import { NAKSHATRAS, RASHIS, PlanetName } from "./constants";

// ---- Types ----------------------------------------------------------------

export interface FriendshipFactor {
  name: string;
  maxPoints: number;
  points: number;
  description: string;
  detail: string;
}

export interface FriendshipResult {
  totalScore: number;
  maxScore: 30;
  percentage: number;
  verdict: "Soul Mates" | "Great Friends" | "Good Friends" | "Acquaintances";
  verdictDescription: string;
  factors: FriendshipFactor[];
}

// ---- Reusable tables (shared with matchmaking.ts logic) -------------------

// Gana (temperament) for each nakshatra: 0=Deva, 1=Manushya, 2=Rakshasa
const NAKSHATRA_GANA: number[] = [
  0, 1, 2, 0, 0, 1, 0, 0, 2, 2, 1, 1, 0, 2, 0, 2, 0, 2, 2, 1, 1, 0, 2, 2, 1, 1, 0,
];
const GANA_NAMES = ["Deva", "Manushya", "Rakshasa"];

// Nadi: 0=Aadi(Vata), 1=Madhya(Pitta), 2=Antya(Kapha)
const NAKSHATRA_NADI: number[] = [
  0, 1, 2, 2, 1, 0, 0, 1, 2, 2, 1, 0, 0, 1, 2, 2, 1, 0, 0, 1, 2, 2, 1, 0, 0, 1, 2,
];
const NADI_NAMES = ["Aadi (Vata)", "Madhya (Pitta)", "Antya (Kapha)"];

// Element for each sign: 0=Fire, 1=Earth, 2=Air, 3=Water
const SIGN_ELEMENT: number[] = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3];
const ELEMENT_NAMES = ["Fire", "Earth", "Air", "Water"];

// Element compatibility (score 0-3)
// Fire-Air = great, Earth-Water = great, same = good, opposites = challenging
const ELEMENT_COMPAT: number[][] = [
  /* Fire  */ [3, 1, 3, 1],
  /* Earth */ [1, 3, 1, 3],
  /* Air   */ [3, 1, 3, 1],
  /* Water */ [1, 3, 1, 3],
];

// Natural friendship between sign lords (reused from matchmaking logic)
const FRIENDSHIP: Record<string, number> = {};
function setF(a: string, b: string, level: number) {
  FRIENDSHIP[[a, b].sort().join("-")] = level;
}
setF("Sun", "Moon", 2); setF("Sun", "Mars", 2); setF("Sun", "Jupiter", 2);
setF("Sun", "Venus", 0); setF("Sun", "Saturn", 0); setF("Sun", "Mercury", 1);
setF("Moon", "Mars", 1); setF("Moon", "Jupiter", 1); setF("Moon", "Venus", 1);
setF("Moon", "Saturn", 1); setF("Moon", "Mercury", 0);
setF("Mars", "Jupiter", 2); setF("Mars", "Venus", 1); setF("Mars", "Saturn", 1);
setF("Mars", "Mercury", 0);
setF("Mercury", "Jupiter", 1); setF("Mercury", "Venus", 2); setF("Mercury", "Saturn", 2);
setF("Jupiter", "Venus", 0); setF("Jupiter", "Saturn", 1);
setF("Venus", "Saturn", 2);

function getFriendship(a: string, b: string): number {
  if (a === b) return 2;
  const mapNode = (p: string) => (p === "Rahu" || p === "Ketu") ? "Saturn" : p;
  const aa = mapNode(a), bb = mapNode(b);
  if (aa === bb) return 2;
  return FRIENDSHIP[[aa, bb].sort().join("-")] ?? 1;
}

// ---- Individual Factor Scorers -------------------------------------------

/** 1. Graha Maitri — mental wavelength (Moon sign lord friendship). Max 6. */
function scoreGrahaMaitri(sign1: number, sign2: number): FriendshipFactor {
  const lord1 = RASHIS[sign1].lord;
  const lord2 = RASHIS[sign2].lord;
  const f12 = getFriendship(lord1, lord2);
  const f21 = getFriendship(lord2, lord1);
  const total = f12 + f21; // 0-4
  let points: number;
  if (total >= 4) points = 6;
  else if (total === 3) points = 5;
  else if (total === 2) points = 3;
  else if (total === 1) points = 1;
  else points = 0;
  const label = (n: number) => n === 2 ? "Friend" : n === 1 ? "Neutral" : "Enemy";
  return {
    name: "Graha Maitri",
    maxPoints: 6,
    points,
    description: "Mental wavelength — how naturally you understand each other's thinking.",
    detail: `Person 1's lord ${lord1} and Person 2's lord ${lord2}: ${label(f12)} / ${label(f21)}. Score ${points}/6.`,
  };
}

/** 2. Gana — temperament and social style. Max 5. */
function scoreGana(nak1: number, nak2: number): FriendshipFactor {
  const g1 = NAKSHATRA_GANA[nak1];
  const g2 = NAKSHATRA_GANA[nak2];
  let points: number;
  if (g1 === g2) points = 5;
  else if ((g1 <= 1 && g2 <= 1)) points = 3; // Deva-Manushya or Manushya-Deva
  else if (g1 === 2 && g2 === 2) points = 5; // both Rakshasa
  else if ((g1 === 0 && g2 === 2) || (g1 === 2 && g2 === 0)) points = 1; // Deva-Rakshasa
  else points = 2; // Manushya-Rakshasa
  return {
    name: "Gana",
    maxPoints: 5,
    points,
    description: "Temperament match — whether your social styles and energy levels align.",
    detail: `Person 1: ${GANA_NAMES[g1]} (${NAKSHATRAS[nak1].name}), Person 2: ${GANA_NAMES[g2]} (${NAKSHATRAS[nak2].name}). ${points >= 4 ? "Natural harmony in temperament." : points >= 2 ? "Workable differences." : "Very different temperaments."}`,
  };
}

/** 3. Tara — destiny alignment. Max 5. */
function scoreTara(nak1: number, nak2: number): FriendshipFactor {
  const dist1 = ((nak2 - nak1 + 27) % 27) + 1;
  const dist2 = ((nak1 - nak2 + 27) % 27) + 1;
  const group1 = dist1 % 9 || 9;
  const group2 = dist2 % 9 || 9;
  const bad = [1, 3, 5, 7];
  const ok1 = !bad.includes(group1);
  const ok2 = !bad.includes(group2);
  const points = ok1 && ok2 ? 5 : ok1 || ok2 ? 3 : 0;
  const TARA_NAMES = ["", "Janma", "Sampat", "Vipat", "Kshema", "Pratyari", "Sadhaka", "Vadha", "Mitra", "Ati-Mitra"];
  return {
    name: "Tara",
    maxPoints: 5,
    points,
    description: "Destiny alignment — how your life paths support or challenge each other.",
    detail: `Person 1→2: ${TARA_NAMES[group1]}, Person 2→1: ${TARA_NAMES[group2]}. ${points === 5 ? "Both auspicious — supportive destiny alignment." : points > 0 ? "One direction auspicious." : "Both challenging."}`,
  };
}

/** 4. Element Harmony — elemental compatibility of Moon signs. Max 5. */
function scoreElementHarmony(sign1: number, sign2: number): FriendshipFactor {
  const e1 = SIGN_ELEMENT[sign1];
  const e2 = SIGN_ELEMENT[sign2];
  const compat = ELEMENT_COMPAT[e1][e2];
  const points = compat === 3 ? 5 : compat === 2 ? 3 : 1;
  return {
    name: "Element Harmony",
    maxPoints: 5,
    points,
    description: "Elemental affinity — Fire-Air and Earth-Water pairs energise each other naturally.",
    detail: `Person 1: ${ELEMENT_NAMES[e1]} (${RASHIS[sign1].name}), Person 2: ${ELEMENT_NAMES[e2]} (${RASHIS[sign2].name}). ${e1 === e2 ? "Same element — natural understanding." : compat === 3 ? "Complementary elements — energising." : "Different elemental needs — requires effort."}`,
  };
}

/** 5. Nadi — energy compatibility. Max 4. */
function scoreNadi(nak1: number, nak2: number): FriendshipFactor {
  const n1 = NAKSHATRA_NADI[nak1];
  const n2 = NAKSHATRA_NADI[nak2];
  // In friendship, same nadi is less problematic than in marriage,
  // but different nadis still create a more dynamic exchange.
  const points = n1 !== n2 ? 4 : 2;
  return {
    name: "Nadi",
    maxPoints: 4,
    points,
    description: "Energy exchange — different nadis create a more dynamic and enriching friendship.",
    detail: `Person 1: ${NADI_NAMES[n1]} (${NAKSHATRAS[nak1].name}), Person 2: ${NADI_NAMES[n2]} (${NAKSHATRAS[nak2].name}). ${n1 !== n2 ? "Different nadis — complementary energies." : "Same nadi — similar constitution; less dynamic exchange but comfortable familiarity."}`,
  };
}

/** 6. Communication Style — Mercury placement compatibility. Max 5. */
function scoreCommunication(chart1: Chart, chart2: Chart): FriendshipFactor {
  const merc1 = chart1.planets.find((p) => p.planet === "Mercury")!;
  const merc2 = chart2.planets.find((p) => p.planet === "Mercury")!;
  const e1 = SIGN_ELEMENT[merc1.signIndex];
  const e2 = SIGN_ELEMENT[merc2.signIndex];
  const elemCompat = ELEMENT_COMPAT[e1][e2];

  // Also check if Mercury signs are the same, trine (1-5-9), or square (4-10)
  const signDist = ((merc2.signIndex - merc1.signIndex + 12) % 12) + 1;
  const trine = [1, 5, 9].includes(signDist);
  const sextile = [3, 11].includes(signDist);

  let points: number;
  if (merc1.signIndex === merc2.signIndex) points = 5;
  else if (trine) points = 5;
  else if (sextile || elemCompat === 3) points = 4;
  else if (elemCompat >= 2) points = 3;
  else points = 1;

  // Bonus description based on dignity
  const dignityNote = (merc1.dignity === "Exalted" || merc1.dignity === "Own sign") &&
    (merc2.dignity === "Exalted" || merc2.dignity === "Own sign")
    ? " Both have strong Mercury — articulate and insightful conversations."
    : "";

  return {
    name: "Communication",
    maxPoints: 5,
    points,
    description: "Communication style — how well you express and receive ideas with each other.",
    detail: `Person 1: Mercury in ${RASHIS[merc1.signIndex].name} (${ELEMENT_NAMES[e1]}), Person 2: Mercury in ${RASHIS[merc2.signIndex].name} (${ELEMENT_NAMES[e2]}). ${points >= 4 ? "Naturally flowing communication." : points >= 3 ? "Decent communication with some effort." : "Different communication styles — requires patience."}${dignityNote}`,
  };
}

// ---- Main Scoring ---------------------------------------------------------

export function computeFriendship(chart1: Chart, chart2: Chart): FriendshipResult {
  const moon1 = chart1.planets.find((p) => p.planet === "Moon")!;
  const moon2 = chart2.planets.find((p) => p.planet === "Moon")!;

  const factors: FriendshipFactor[] = [
    scoreGrahaMaitri(moon1.signIndex, moon2.signIndex),
    scoreGana(moon1.nakshatraIndex, moon2.nakshatraIndex),
    scoreTara(moon1.nakshatraIndex, moon2.nakshatraIndex),
    scoreElementHarmony(moon1.signIndex, moon2.signIndex),
    scoreNadi(moon1.nakshatraIndex, moon2.nakshatraIndex),
    scoreCommunication(chart1, chart2),
  ];

  const totalScore = factors.reduce((s, f) => s + f.points, 0);
  const percentage = Math.round((totalScore / 30) * 100);

  let verdict: FriendshipResult["verdict"];
  let verdictDescription: string;
  if (totalScore >= 25) {
    verdict = "Soul Mates";
    verdictDescription = "An extraordinary connection (25+ out of 30). You share a deep mental, emotional and communicative bond. This friendship is a rare gift — cherish it. Classical texts consider such connections to be carried across lifetimes.";
  } else if (totalScore >= 19) {
    verdict = "Great Friends";
    verdictDescription = "A strong friendship (19-24 out of 30). You complement each other well across most dimensions. Shared interests, natural understanding and mutual growth define this bond.";
  } else if (totalScore >= 13) {
    verdict = "Good Friends";
    verdictDescription = "A solid friendship (13-18 out of 30). You connect well in several areas, with some differences that can actually enrich the relationship. Patience and openness strengthen this bond.";
  } else {
    verdict = "Acquaintances";
    verdictDescription = "A casual connection (under 13 out of 30). Your natural wavelengths differ, which means the friendship requires more conscious effort. Shared activities and goals can bridge the gap.";
  }

  return {
    totalScore,
    maxScore: 30,
    percentage,
    verdict,
    verdictDescription,
    factors,
  };
}
