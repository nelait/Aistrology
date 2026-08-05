/**
 * Vastu Shastra analysis engine.
 *
 * Combines a user's Vedic birth chart with property questionnaire data
 * to produce a suitability report. Pure functions — no network calls.
 *
 * Key Vedic–Vastu cross-references:
 *  - Lagna (ascendant) maps to an auspicious direction for the native
 *  - 4th house lord strength indicates property luck
 *  - Mars (Bhoomi Karaka — significator of land) placement affects property
 *  - Current dasha periods can favour or disfavour property decisions
 */

import type { Chart, PlanetPosition } from "./types";
import { RASHIS, GRAHAS } from "./constants";

// ── Types ──────────────────────────────────────────────────────────────────

export type Direction = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
export type PlotShape = "square" | "rectangle" | "L-shaped" | "irregular";
export type SlopeDirection = "N" | "NE" | "E" | "SE" | "flat" | "S" | "SW" | "W" | "NW";

export interface VastuQuestionnaire {
  facingDirection: Direction;         // Main entrance / plot facing
  entrancePosition: Direction;        // Door placement within the face
  kitchenLocation: Direction;         // Kitchen quadrant
  masterBedroom: Direction;           // Master bedroom quadrant
  bathroomLocation: Direction;        // Main bathroom quadrant
  waterSource: Direction;             // Borewell / overhead tank
  staircasePosition: Direction;       // Staircase quadrant
  poojaRoom: Direction;               // Prayer room / altar
  gardenOrOpenSpace: Direction;       // Garden / courtyard
  garage: Direction;                  // Parking / garage
  plotShape: PlotShape;
  landSlope: SlopeDirection;
}

export type Severity = "good" | "moderate" | "bad";

export interface VastuFactor {
  area: string;          // e.g. "Kitchen", "Entrance", "Bedroom"
  finding: string;       // Human-readable finding
  severity: Severity;
  score: number;         // 0–10, 10 = perfect
  remedy?: string;       // Remedy if score < 7
}

export interface AstroVastuFactor {
  factor: string;        // e.g. "Lagna direction", "4th lord strength"
  finding: string;
  severity: Severity;
  score: number;
}

export interface VastuResult {
  overallScore: number;  // 0–100
  overallVerdict: string;
  roomFactors: VastuFactor[];
  astroFactors: AstroVastuFactor[];
  topRemedies: string[];
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Classical Vastu direction assignments for rooms / elements. */
const IDEAL_PLACEMENT: Record<string, Direction[]> = {
  kitchen:       ["SE"],                // Agni (fire) corner
  masterBedroom: ["SW"],                // Stability / earth element
  bathroom:      ["NW", "W"],           // Vayu (wind) corner
  waterSource:   ["NE"],                // Ishanya — purest corner
  staircase:     ["SW", "S", "W"],      // Heavy in SW quadrant
  poojaRoom:     ["NE", "E"],           // Ishanya or east (sunrise)
  garden:        ["N", "NE", "E"],      // Open / light directions
  garage:        ["NW", "SE"],          // Wind or fire corners
};

/** Auspicious facing directions for each Lagna sign (index 0 = Aries). */
const LAGNA_AUSPICIOUS_DIRECTION: Direction[][] = [
  /* Aries   */ ["E", "N"],
  /* Taurus  */ ["N", "W"],
  /* Gemini  */ ["N", "E"],
  /* Cancer  */ ["N", "NE"],
  /* Leo     */ ["E", "NE"],
  /* Virgo   */ ["N", "E"],
  /* Libra   */ ["W", "N"],
  /* Scorpio */ ["N", "E"],
  /* Sag     */ ["NE", "E"],
  /* Cap     */ ["S", "W"],
  /* Aqua    */ ["W", "N"],
  /* Pisces  */ ["NE", "N"],
];

/** Good plot shapes (square best, then rectangle). */
const SHAPE_SCORE: Record<PlotShape, number> = {
  square: 10,
  rectangle: 8,
  "L-shaped": 4,
  irregular: 3,
};

/** Land slope: NE slope is best (water flows to NE). */
const SLOPE_SCORE: Record<SlopeDirection, number> = {
  NE: 10,
  N: 8,
  E: 8,
  flat: 7,
  NW: 5,
  SE: 4,
  S: 3,
  SW: 2,
  W: 4,
};

// ── Helpers ────────────────────────────────────────────────────────────────

function directionMatch(actual: Direction, ideals: Direction[]): { match: boolean; score: number } {
  if (ideals.includes(actual)) return { match: true, score: 10 };
  // Adjacent direction is partially acceptable
  const all: Direction[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = all.indexOf(actual);
  const adjacent = [all[(idx + 1) % 8], all[(idx + 7) % 8]];
  if (ideals.some((d) => adjacent.includes(d))) return { match: false, score: 6 };
  // Opposite direction is worst
  const opposite = all[(idx + 4) % 8];
  if (ideals.includes(opposite)) return { match: false, score: 2 };
  return { match: false, score: 4 };
}

function severityFromScore(score: number): Severity {
  if (score >= 8) return "good";
  if (score >= 5) return "moderate";
  return "bad";
}

function findPlanet(chart: Chart, name: string): PlanetPosition | undefined {
  return chart.planets.find((p) => p.planet === name);
}

/** Get the lord of a sign (0-indexed). */
function signLord(signIndex: number): string {
  const lords = ["Mars", "Venus", "Mercury", "Moon", "Sun", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Saturn", "Jupiter"];
  return lords[signIndex % 12];
}

/** Map a sign index to its associated Vastu direction. */
function signToDirection(signIndex: number): Direction {
  const map: Direction[] = ["E", "SE", "S", "SW", "W", "NW", "N", "NE", "E", "SE", "S", "SW"];
  // Aries=E, Taurus=SE, Gemini=S, Cancer=SW(approx), Leo=W(E really), ...
  // Classical mapping: Fire=E, Earth=S, Air=W, Water=N
  const elementMap: Direction[] = ["E", "S", "W", "N", "E", "S", "W", "N", "E", "S", "W", "N"];
  return elementMap[signIndex % 12];
}

// ── Room analysis ──────────────────────────────────────────────────────────

function analyseRoom(
  area: string,
  actual: Direction,
  ideals: Direction[],
  remedyIfBad: string,
): VastuFactor {
  const { match, score } = directionMatch(actual, ideals);
  const severity = severityFromScore(score);
  const idealStr = ideals.join(" / ");

  let finding: string;
  if (match) {
    finding = `${area} is correctly placed in the ${actual} direction (ideal: ${idealStr}). Excellent Vastu compliance.`;
  } else if (severity === "moderate") {
    finding = `${area} is in the ${actual} direction. Ideal placement is ${idealStr}. This is acceptable but not optimal.`;
  } else {
    finding = `${area} is in the ${actual} direction, but the ideal placement is ${idealStr}. This is a significant Vastu defect.`;
  }

  return {
    area,
    finding,
    severity,
    score,
    ...(severity !== "good" ? { remedy: remedyIfBad } : {}),
  };
}

// ── Astrological cross-referencing ─────────────────────────────────────────

function analyseAstroFactors(chart: Chart, q: VastuQuestionnaire): AstroVastuFactor[] {
  const factors: AstroVastuFactor[] = [];
  const lagnaSign = chart.ascendantSign;

  // 1. Lagna direction compatibility
  const auspiciousDirs = LAGNA_AUSPICIOUS_DIRECTION[lagnaSign] ?? ["E", "N"];
  const { score: lagnaScore } = directionMatch(q.facingDirection, auspiciousDirs);
  factors.push({
    factor: "Lagna Direction Compatibility",
    finding: lagnaScore >= 8
      ? `Your Lagna is ${RASHIS[lagnaSign]} — the ${q.facingDirection}-facing property aligns well with your auspicious directions (${auspiciousDirs.join(", ")}).`
      : lagnaScore >= 5
        ? `Your Lagna is ${RASHIS[lagnaSign]}. The ${q.facingDirection}-facing property is acceptable, but ${auspiciousDirs.join(" or ")} facing would be ideal.`
        : `Your Lagna is ${RASHIS[lagnaSign]}, and ${auspiciousDirs.join(" or ")} facing is ideal. The ${q.facingDirection}-facing direction is not favourable for your chart.`,
    severity: severityFromScore(lagnaScore),
    score: lagnaScore,
  });

  // 2. 4th house lord strength (property house)
  const fourthHouseSign = chart.houseSigns[3]; // 0-indexed
  const fourthLord = signLord(fourthHouseSign);
  const fourthPlanet = findPlanet(chart, fourthLord);
  let fourthScore = 6; // default moderate
  let fourthFinding = "";

  if (fourthPlanet) {
    // Exalted or own sign = strong; debilitated = weak
    const isRetrograde = fourthPlanet.retrograde;
    const planetSign = fourthPlanet.signIndex;

    // Simplified dignity check
    const ownSigns: Record<string, number[]> = {
      Sun: [4], Moon: [3], Mars: [0, 7], Mercury: [2, 5],
      Jupiter: [8, 11], Venus: [1, 6], Saturn: [9, 10],
    };
    const exaltedSign: Record<string, number> = {
      Sun: 0, Moon: 1, Mars: 9, Mercury: 5,
      Jupiter: 3, Venus: 11, Saturn: 6,
    };
    const debilitatedSign: Record<string, number> = {
      Sun: 6, Moon: 7, Mars: 3, Mercury: 11,
      Jupiter: 9, Venus: 5, Saturn: 0,
    };

    const isOwn = ownSigns[fourthLord]?.includes(planetSign);
    const isExalted = exaltedSign[fourthLord] === planetSign;
    const isDebilitated = debilitatedSign[fourthLord] === planetSign;

    if (isExalted) {
      fourthScore = 10;
      fourthFinding = `4th house lord ${fourthLord} is exalted in ${RASHIS[planetSign]} — excellent property karma. This chart strongly supports property ownership and domestic happiness.`;
    } else if (isOwn) {
      fourthScore = 9;
      fourthFinding = `4th house lord ${fourthLord} is in own sign ${RASHIS[planetSign]} — strong property fortunes. The native is likely to benefit from real estate.`;
    } else if (isDebilitated) {
      fourthScore = 3;
      fourthFinding = `4th house lord ${fourthLord} is debilitated in ${RASHIS[planetSign]} — caution advised with property matters. Remedies recommended before major property decisions.`;
    } else {
      fourthScore = isRetrograde ? 5 : 7;
      fourthFinding = `4th house lord ${fourthLord} is in ${RASHIS[planetSign]}${isRetrograde ? " (retrograde)" : ""} — ${isRetrograde ? "some delays in property matters are possible" : "a reasonably supportive placement for property"}.`;
    }
  } else {
    fourthFinding = `4th house lord analysis — ${fourthLord} governs your property house (${RASHIS[fourthHouseSign]}).`;
  }

  factors.push({
    factor: "4th House Lord (Property House)",
    finding: fourthFinding,
    severity: severityFromScore(fourthScore),
    score: fourthScore,
  });

  // 3. Mars (Bhoomi Karaka — significator of land/property)
  const mars = findPlanet(chart, "Mars");
  if (mars) {
    const marsSign = mars.signIndex;
    const marsHouse = ((marsSign - lagnaSign + 12) % 12) + 1;
    let marsScore = 6;
    let marsFinding = "";

    // Mars in 4th house is strong for property
    if (marsHouse === 4) {
      marsScore = 9;
      marsFinding = `Mars (Bhoomi Karaka) is in your 4th house — strong connection to land and property. You have a natural inclination toward property ownership.`;
    } else if ([1, 10, 11].includes(marsHouse)) {
      marsScore = 8;
      marsFinding = `Mars (Bhoomi Karaka) is in house ${marsHouse} — a supportive position for property matters and real estate dealings.`;
    } else if ([6, 8, 12].includes(marsHouse)) {
      marsScore = 4;
      marsFinding = `Mars (Bhoomi Karaka) is in house ${marsHouse} (a dusthana) — some obstacles in property matters may arise. Due diligence is especially important.`;
    } else {
      marsScore = mars.retrograde ? 5 : 7;
      marsFinding = `Mars (Bhoomi Karaka) is in house ${marsHouse} in ${RASHIS[marsSign]}${mars.retrograde ? " (retrograde — may indicate revisiting property decisions)" : ""} — a neutral to positive placement.`;
    }

    factors.push({
      factor: "Mars (Bhoomi Karaka — Land Significator)",
      finding: marsFinding,
      severity: severityFromScore(marsScore),
      score: marsScore,
    });
  }

  // 4. Venus (Sukha Karaka — significator of comforts / luxuries)
  const venus = findPlanet(chart, "Venus");
  if (venus) {
    const venusSign = venus.signIndex;
    const venusHouse = ((venusSign - lagnaSign + 12) % 12) + 1;
    let venusScore = 6;
    let venusFinding = "";

    if ([1, 4, 7, 10].includes(venusHouse)) {
      venusScore = 9;
      venusFinding = `Venus (Sukha Karaka) is in house ${venusHouse} (a kendra) — excellent for domestic comforts, beautiful home environment, and harmonious living.`;
    } else if ([6, 8, 12].includes(venusHouse)) {
      venusScore = 4;
      venusFinding = `Venus (Sukha Karaka) is in house ${venusHouse} — domestic comforts may require extra effort. Interior design and Vastu remedies can help.`;
    } else {
      venusScore = 7;
      venusFinding = `Venus (Sukha Karaka) is in house ${venusHouse} in ${RASHIS[venusSign]} — a reasonably comfortable placement for home life.`;
    }

    factors.push({
      factor: "Venus (Sukha Karaka — Comfort Significator)",
      finding: venusFinding,
      severity: severityFromScore(venusScore),
      score: venusScore,
    });
  }

  return factors;
}

// ── Main analysis ──────────────────────────────────────────────────────────

const ROOM_REMEDIES: Record<string, string> = {
  kitchen: "Place a red or orange lamp in the SE corner of the kitchen. A pyramid or crystal in the SE corner can also balance the fire element.",
  masterBedroom: "Use earthy tones (brown, beige) in the bedroom. Place heavy furniture in the SW corner. Avoid mirrors facing the bed.",
  bathroom: "Keep the bathroom door closed. Place a Vastu salt bowl inside. Ensure good ventilation.",
  waterSource: "If the water source cannot be moved, place a small fountain or water feature in the NE corner of the property.",
  staircase: "Paint the staircase area in light colours. Place a Vastu pyramid under the staircase. Avoid storing clutter beneath.",
  poojaRoom: "If the pooja room cannot be in NE, ensure it is not in the bedroom or bathroom. Face east while praying.",
  garden: "Plant tulsi (holy basil) in the NE or N. Avoid large trees in the NE as they block positive energy flow.",
  garage: "Ensure the garage does not share a wall with the pooja room or master bedroom. Keep it well-lit.",
};

export function analyseVastu(chart: Chart, q: VastuQuestionnaire): VastuResult {
  const roomFactors: VastuFactor[] = [];

  // Analyse each room placement
  roomFactors.push(analyseRoom("Kitchen", q.kitchenLocation, IDEAL_PLACEMENT.kitchen, ROOM_REMEDIES.kitchen));
  roomFactors.push(analyseRoom("Master Bedroom", q.masterBedroom, IDEAL_PLACEMENT.masterBedroom, ROOM_REMEDIES.masterBedroom));
  roomFactors.push(analyseRoom("Bathroom", q.bathroomLocation, IDEAL_PLACEMENT.bathroom, ROOM_REMEDIES.bathroom));
  roomFactors.push(analyseRoom("Water Source", q.waterSource, IDEAL_PLACEMENT.waterSource, ROOM_REMEDIES.waterSource));
  roomFactors.push(analyseRoom("Staircase", q.staircasePosition, IDEAL_PLACEMENT.staircase, ROOM_REMEDIES.staircase));
  roomFactors.push(analyseRoom("Pooja Room", q.poojaRoom, IDEAL_PLACEMENT.poojaRoom, ROOM_REMEDIES.poojaRoom));
  roomFactors.push(analyseRoom("Garden / Open Space", q.gardenOrOpenSpace, IDEAL_PLACEMENT.garden, ROOM_REMEDIES.garden));
  roomFactors.push(analyseRoom("Garage / Parking", q.garage, IDEAL_PLACEMENT.garage, ROOM_REMEDIES.garage));

  // Plot shape
  const shapeScore = SHAPE_SCORE[q.plotShape];
  roomFactors.push({
    area: "Plot Shape",
    finding: shapeScore >= 8
      ? `The ${q.plotShape} plot shape is considered auspicious in Vastu Shastra. Square and rectangular plots ensure balanced energy flow.`
      : `The ${q.plotShape} plot shape is not ideal. ${q.plotShape === "L-shaped" ? "L-shaped plots create missing corners which disrupt energy flow." : "Irregular shapes cause uneven distribution of cosmic energy."}`,
    severity: severityFromScore(shapeScore),
    score: shapeScore,
    ...(shapeScore < 8 ? { remedy: "If the plot is irregular, use boundary walls and landscaping to visually 'complete' the shape. Plant trees or place Vastu pyramids at missing corners." } : {}),
  });

  // Land slope
  const slopeScore = SLOPE_SCORE[q.landSlope];
  roomFactors.push({
    area: "Land Slope",
    finding: slopeScore >= 8
      ? `The land slopes toward the ${q.landSlope} — this is auspicious as it allows positive energy (prana) to flow naturally toward the Ishanya corner.`
      : slopeScore >= 5
        ? `The land is ${q.landSlope === "flat" ? "flat" : `sloping toward the ${q.landSlope}`}. ${q.landSlope === "flat" ? "Flat land is neutral in Vastu — NE slope would be ideal." : "This is acceptable but NE slope is preferred."}`
        : `The land slopes toward the ${q.landSlope} — this is inauspicious in Vastu. ${q.landSlope === "SW" ? "SW slope causes energy stagnation and potential health issues." : "This direction of slope can disrupt the natural flow of positive energy."}`,
    severity: severityFromScore(slopeScore),
    score: slopeScore,
    ...(slopeScore < 7 ? { remedy: "Raise the SW corner of the property by adding soil, a raised platform, or heavier landscaping. Create a gentle NE slope using terracing." } : {}),
  });

  // Entrance analysis
  const entranceIdeals: Direction[] = ["N", "NE", "E"]; // Generally auspicious entrances
  const entranceFactor = analyseRoom(
    "Main Entrance",
    q.entrancePosition,
    entranceIdeals,
    "Place a threshold (brass or wooden) at the entrance. Hang a toran (auspicious garland) above the door. Ensure the entrance is well-lit and clutter-free.",
  );
  roomFactors.unshift(entranceFactor); // Entrance is most important

  // Facing direction (overall)
  const lagnaAuspicious = LAGNA_AUSPICIOUS_DIRECTION[chart.ascendantSign] ?? ["E", "N"];
  const { score: facingScore } = directionMatch(q.facingDirection, lagnaAuspicious);
  roomFactors.unshift({
    area: "Property Facing",
    finding: facingScore >= 8
      ? `The ${q.facingDirection}-facing property aligns with your birth chart's auspicious directions. This is an excellent match.`
      : facingScore >= 5
        ? `The property faces ${q.facingDirection}. For your chart, ${lagnaAuspicious.join(" or ")} facing would be ideal. This is acceptable but not optimal.`
        : `The property faces ${q.facingDirection}, but your chart favours ${lagnaAuspicious.join(" or ")} facing. This is a significant mismatch.`,
    severity: severityFromScore(facingScore),
    score: facingScore,
    ...(facingScore < 7 ? { remedy: `If possible, use the ${lagnaAuspicious[0]} direction as your primary working entrance. Place a Vastu yantra near the main door facing your auspicious direction.` } : {}),
  });

  // Astrological factors
  const astroFactors = analyseAstroFactors(chart, q);

  // Calculate overall score
  const roomAvg = roomFactors.reduce((s, f) => s + f.score, 0) / roomFactors.length;
  const astroAvg = astroFactors.reduce((s, f) => s + f.score, 0) / (astroFactors.length || 1);
  // Weight: 60% room/property Vastu, 40% astrological alignment
  const overallScore = Math.round((roomAvg * 6 + astroAvg * 4) / 10 * 10);

  let overallVerdict: string;
  if (overallScore >= 80) {
    overallVerdict = "Excellent Vastu–Jyotish alignment. This property is highly suitable for you.";
  } else if (overallScore >= 65) {
    overallVerdict = "Good alignment with minor defects. A few Vastu remedies can optimize the energy.";
  } else if (overallScore >= 45) {
    overallVerdict = "Moderate suitability. Several Vastu issues need attention — remedies are important.";
  } else {
    overallVerdict = "Significant Vastu concerns. Careful evaluation and strong remedies are recommended before proceeding.";
  }

  // Top remedies (from worst-scoring areas)
  const topRemedies = roomFactors
    .filter((f) => f.remedy)
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map((f) => `**${f.area}**: ${f.remedy!}`);

  return {
    overallScore,
    overallVerdict,
    roomFactors,
    astroFactors,
    topRemedies,
  };
}
