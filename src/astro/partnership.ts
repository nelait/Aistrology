// Business partnership compatibility engine for Vedic astrology.
// Assesses joint-venture suitability by examining factors that matter for
// professional collaboration: shared ambition, financial alignment, communication,
// trust/commitment, leadership dynamics and the strength of the 7th house
// (the classical house of partnerships and contracts).
//
// Scored out of 30 points across 6 factors.

import { Chart } from "./types";
import { NAKSHATRAS, RASHIS, PlanetName } from "./constants";

// ---- Types ----------------------------------------------------------------

export interface PartnershipFactor {
  name: string;
  maxPoints: number;
  points: number;
  description: string;
  detail: string;
}

export interface PartnershipResult {
  totalScore: number;
  maxScore: 30;
  percentage: number;
  verdict: "Power Duo" | "Strong Alliance" | "Workable" | "Challenging";
  verdictDescription: string;
  factors: PartnershipFactor[];
}

// ---- Shared tables --------------------------------------------------------

const SIGN_ELEMENT: number[] = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3];
const ELEMENT_NAMES = ["Fire", "Earth", "Air", "Water"];

// Element compatibility for business (Earth-Earth is excellent for stability)
const BIZ_ELEMENT_COMPAT: number[][] = [
  /* Fire  */ [3, 2, 3, 1],
  /* Earth */ [2, 3, 1, 2],
  /* Air   */ [3, 1, 3, 2],
  /* Water */ [1, 2, 2, 3],
];

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

/**
 * 1. Mercury Synergy — business communication, contracts, negotiation.
 * Checks Mercury element compatibility + sign harmony. Max 6.
 */
function scoreMercurySynergy(chart1: Chart, chart2: Chart): PartnershipFactor {
  const m1 = chart1.planets.find((p) => p.planet === "Mercury")!;
  const m2 = chart2.planets.find((p) => p.planet === "Mercury")!;
  const e1 = SIGN_ELEMENT[m1.signIndex];
  const e2 = SIGN_ELEMENT[m2.signIndex];
  const elemCompat = BIZ_ELEMENT_COMPAT[e1][e2];

  const signDist = ((m2.signIndex - m1.signIndex + 12) % 12) + 1;
  const trine = [1, 5, 9].includes(signDist);
  const sextile = [3, 11].includes(signDist);

  let points: number;
  if (m1.signIndex === m2.signIndex) points = 6;
  else if (trine) points = 6;
  else if (sextile || elemCompat === 3) points = 5;
  else if (elemCompat >= 2) points = 3;
  else points = 1;

  // Boost if both Mercury are strong (own/exalted)
  const strong1 = m1.dignity === "Exalted" || m1.dignity === "Own sign" || m1.dignity === "Moolatrikona";
  const strong2 = m2.dignity === "Exalted" || m2.dignity === "Own sign" || m2.dignity === "Moolatrikona";
  const dignityNote = strong1 && strong2
    ? " Both have dignified Mercury — sharp business minds."
    : strong1 || strong2
      ? ` One partner has dignified Mercury (${strong1 ? "Person 1" : "Person 2"}) — brings analytical edge.`
      : "";

  return {
    name: "Mercury Synergy",
    maxPoints: 6,
    points,
    description: "Business communication — how well you negotiate, strategise and handle contracts together.",
    detail: `Person 1: Mercury in ${RASHIS[m1.signIndex].name} (${ELEMENT_NAMES[e1]}), Person 2: Mercury in ${RASHIS[m2.signIndex].name} (${ELEMENT_NAMES[e2]}). ${points >= 5 ? "Excellent business communication." : points >= 3 ? "Workable communication with effort." : "Different business thinking styles."}${dignityNote}`,
  };
}

/**
 * 2. Jupiter Alignment — shared vision, growth, ethics, wealth expansion.
 * Max 5.
 */
function scoreJupiterAlignment(chart1: Chart, chart2: Chart): PartnershipFactor {
  const j1 = chart1.planets.find((p) => p.planet === "Jupiter")!;
  const j2 = chart2.planets.find((p) => p.planet === "Jupiter")!;
  const e1 = SIGN_ELEMENT[j1.signIndex];
  const e2 = SIGN_ELEMENT[j2.signIndex];

  const signDist = ((j2.signIndex - j1.signIndex + 12) % 12) + 1;
  const trine = [1, 5, 9].includes(signDist);
  const sextile = [3, 11].includes(signDist);

  let points: number;
  if (j1.signIndex === j2.signIndex) points = 5;
  else if (trine) points = 5;
  else if (sextile) points = 4;
  else if (e1 === e2) points = 3;
  else if (BIZ_ELEMENT_COMPAT[e1][e2] >= 2) points = 2;
  else points = 1;

  return {
    name: "Jupiter Alignment",
    maxPoints: 5,
    points,
    description: "Shared vision and ethics — alignment in growth philosophy, risk appetite and moral compass.",
    detail: `Person 1: Jupiter in ${RASHIS[j1.signIndex].name}, Person 2: Jupiter in ${RASHIS[j2.signIndex].name}. ${points >= 4 ? "Well-aligned vision for growth." : points >= 2 ? "Some differences in growth strategy." : "Very different philosophies on expansion and risk."}`,
  };
}

/**
 * 3. Saturn Commitment — discipline, long-term staying power, work ethic.
 * Max 5.
 */
function scoreSaturnCommitment(chart1: Chart, chart2: Chart): PartnershipFactor {
  const s1 = chart1.planets.find((p) => p.planet === "Saturn")!;
  const s2 = chart2.planets.find((p) => p.planet === "Saturn")!;
  const e1 = SIGN_ELEMENT[s1.signIndex];
  const e2 = SIGN_ELEMENT[s2.signIndex];

  const signDist = ((s2.signIndex - s1.signIndex + 12) % 12) + 1;
  const trine = [1, 5, 9].includes(signDist);
  const sextile = [3, 11].includes(signDist);

  let points: number;
  if (s1.signIndex === s2.signIndex) points = 5;
  else if (trine) points = 5;
  else if (sextile) points = 4;
  else if (e1 === e2) points = 3;
  else if (BIZ_ELEMENT_COMPAT[e1][e2] >= 2) points = 2;
  else points = 1;

  return {
    name: "Saturn Commitment",
    maxPoints: 5,
    points,
    description: "Long-term commitment — shared work ethic, discipline and ability to weather business storms.",
    detail: `Person 1: Saturn in ${RASHIS[s1.signIndex].name}, Person 2: Saturn in ${RASHIS[s2.signIndex].name}. ${points >= 4 ? "Strong mutual commitment — both can sustain long-term effort." : points >= 2 ? "Different work rhythms but manageable." : "Very different approaches to discipline and structure."}`,
  };
}

/**
 * 4. Leadership Dynamics — Sun placement compatibility.
 * Complementary Suns avoid ego clashes; aligned Suns share ambition. Max 5.
 */
function scoreLeadership(chart1: Chart, chart2: Chart): PartnershipFactor {
  const sun1 = chart1.planets.find((p) => p.planet === "Sun")!;
  const sun2 = chart2.planets.find((p) => p.planet === "Sun")!;
  const e1 = SIGN_ELEMENT[sun1.signIndex];
  const e2 = SIGN_ELEMENT[sun2.signIndex];

  const signDist = ((sun2.signIndex - sun1.signIndex + 12) % 12) + 1;
  const trine = [1, 5, 9].includes(signDist);
  const sextile = [3, 11].includes(signDist);
  const square = [4, 10].includes(signDist);
  const opposition = signDist === 7;

  let points: number;
  if (sun1.signIndex === sun2.signIndex) points = 4; // same ego = potential clashes
  else if (trine) points = 5; // harmonious leadership
  else if (sextile) points = 4;
  else if (opposition) points = 3; // complementary but tension
  else if (square) points = 1; // ego clashes
  else points = 2;

  return {
    name: "Leadership Dynamics",
    maxPoints: 5,
    points,
    description: "Authority and ego — how leadership roles and decision-making power flow between partners.",
    detail: `Person 1: Sun in ${RASHIS[sun1.signIndex].name}, Person 2: Sun in ${RASHIS[sun2.signIndex].name}. ${points >= 4 ? "Complementary leadership — roles can be divided naturally." : points >= 3 ? "Some ego tension — clear role definition helps." : "Potential power struggles — explicit agreements needed."}`,
  };
}

/**
 * 5. Wealth Potential — 2nd house (capital) and 11th house (gains) lord compatibility.
 * Max 5.
 */
function scoreWealthPotential(chart1: Chart, chart2: Chart): PartnershipFactor {
  // 2nd house lord friendship with partner's 11th house lord
  const sign2nd_1 = chart1.houseSigns[1]; // 2nd house sign, person 1
  const sign11th_1 = chart1.houseSigns[10]; // 11th house sign, person 1
  const sign2nd_2 = chart2.houseSigns[1];
  const sign11th_2 = chart2.houseSigns[10];

  const lord2nd_1 = RASHIS[sign2nd_1].lord;
  const lord11th_1 = RASHIS[sign11th_1].lord;
  const lord2nd_2 = RASHIS[sign2nd_2].lord;
  const lord11th_2 = RASHIS[sign11th_2].lord;

  // Cross-check: P1's 2nd lord with P2's 11th lord and vice versa
  const cross1 = getFriendship(lord2nd_1, lord11th_2);
  const cross2 = getFriendship(lord2nd_2, lord11th_1);
  const total = cross1 + cross2; // 0-4

  let points: number;
  if (total >= 4) points = 5;
  else if (total === 3) points = 4;
  else if (total === 2) points = 3;
  else if (total === 1) points = 1;
  else points = 0;

  const friendLabel = (n: number) => n === 2 ? "Friend" : n === 1 ? "Neutral" : "Enemy";

  return {
    name: "Wealth Potential",
    maxPoints: 5,
    points,
    description: "Financial synergy — compatibility between capital (2nd house) and gains (11th house) lords.",
    detail: `P1 2nd lord ${lord2nd_1} × P2 11th lord ${lord11th_2}: ${friendLabel(cross1)}. P2 2nd lord ${lord2nd_2} × P1 11th lord ${lord11th_1}: ${friendLabel(cross2)}. Score ${points}/5.`,
  };
}

/**
 * 6. Graha Maitri — baseline mental compatibility (Moon sign lords). Max 4.
 */
function scoreGrahaMaitri(chart1: Chart, chart2: Chart): PartnershipFactor {
  const moon1 = chart1.planets.find((p) => p.planet === "Moon")!;
  const moon2 = chart2.planets.find((p) => p.planet === "Moon")!;
  const lord1 = RASHIS[moon1.signIndex].lord;
  const lord2 = RASHIS[moon2.signIndex].lord;
  const f12 = getFriendship(lord1, lord2);
  const f21 = getFriendship(lord2, lord1);
  const total = f12 + f21;

  let points: number;
  if (total >= 4) points = 4;
  else if (total === 3) points = 3;
  else if (total === 2) points = 2;
  else if (total === 1) points = 1;
  else points = 0;

  const label = (n: number) => n === 2 ? "Friend" : n === 1 ? "Neutral" : "Enemy";

  return {
    name: "Graha Maitri",
    maxPoints: 4,
    points,
    description: "Mental wavelength — baseline emotional rapport and mutual understanding.",
    detail: `Person 1's lord ${lord1} and Person 2's lord ${lord2}: ${label(f12)} / ${label(f21)}. Score ${points}/4.`,
  };
}

// ---- Main Scoring ---------------------------------------------------------

export function computePartnership(chart1: Chart, chart2: Chart): PartnershipResult {
  const factors: PartnershipFactor[] = [
    scoreMercurySynergy(chart1, chart2),
    scoreJupiterAlignment(chart1, chart2),
    scoreSaturnCommitment(chart1, chart2),
    scoreLeadership(chart1, chart2),
    scoreWealthPotential(chart1, chart2),
    scoreGrahaMaitri(chart1, chart2),
  ];

  const totalScore = factors.reduce((s, f) => s + f.points, 0);
  const percentage = Math.round((totalScore / 30) * 100);

  let verdict: PartnershipResult["verdict"];
  let verdictDescription: string;
  if (totalScore >= 25) {
    verdict = "Power Duo";
    verdictDescription = "An exceptional business pairing (25+ out of 30). Your charts indicate powerful synergy across communication, vision, commitment and financial potential. This partnership has strong foundations for long-term success.";
  } else if (totalScore >= 19) {
    verdict = "Strong Alliance";
    verdictDescription = "A strong partnership (19-24 out of 30). You complement each other well in most business-critical areas. Define clear roles and leverage each partner's strengths for maximum impact.";
  } else if (totalScore >= 13) {
    verdict = "Workable";
    verdictDescription = "A workable partnership (13-18 out of 30). There are areas of natural alignment and areas requiring conscious effort. Detailed partnership agreements and regular check-ins will help bridge the gaps.";
  } else {
    verdict = "Challenging";
    verdictDescription = "A challenging match (under 13 out of 30). Significant differences in business style, vision or financial approach. Success is possible but requires clear legal frameworks, well-defined roles and strong external advisors.";
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
