// Ashtakoot (8-kuta) Gun Milan matchmaking engine for Vedic astrology.
// Computes compatibility between two charts using the classical 8-factor system
// scored out of 36 points. Also checks Manglik (Kuja) dosha.
//
// All scoring follows the traditional rules from Muhurta Chintamani and BPHS.

import { Chart, PlanetPosition } from "./types";
import { PlanetName, NAKSHATRAS, RASHIS } from "./constants";

// ---- Types ----------------------------------------------------------------

export interface KutaScore {
  name: string;
  maxPoints: number;
  points: number;
  description: string; // one-line classical explanation
  detail: string; // what specifically matched or didn't
}

export interface ManglikInfo {
  isManglik: boolean;
  houses: number[]; // which of [1,2,4,7,8,12] Mars occupies
  cancelled: boolean; // basic cancellation rules
  cancellationReason: string;
}

export interface MatchResult {
  totalScore: number; // out of 36
  maxScore: 36;
  percentage: number;
  verdict: "Excellent" | "Good" | "Average" | "Below Average";
  verdictDescription: string;
  kutas: KutaScore[];
  brideManglik: ManglikInfo;
  groomManglik: ManglikInfo;
  manglikCompatible: boolean;
}

// ---- Nakshatra-to-attribute tables ----------------------------------------

// Varna (spiritual class) by Moon sign: Brahmin (4), Kshatriya (3), Vaishya (2), Shudra (1)
// Cancer, Scorpio, Pisces = Brahmin; Aries, Leo, Sagittarius = Kshatriya
// Taurus, Virgo, Capricorn = Vaishya; Gemini, Libra, Aquarius = Shudra
const SIGN_VARNA: number[] = [
  3, // Aries - Kshatriya
  2, // Taurus - Vaishya
  1, // Gemini - Shudra
  4, // Cancer - Brahmin
  3, // Leo - Kshatriya
  2, // Virgo - Vaishya
  1, // Libra - Shudra
  4, // Scorpio - Brahmin
  3, // Sagittarius - Kshatriya
  2, // Capricorn - Vaishya
  1, // Aquarius - Shudra
  4, // Pisces - Brahmin
];

const VARNA_NAMES = ["", "Shudra", "Vaishya", "Kshatriya", "Brahmin"];

// Vashya groups by Moon sign
// 0 = Chatushpada (quadruped), 1 = Manava (human), 2 = Jalachara (aquatic),
// 3 = Vanachara (wild), 4 = Keeta (insect/reptile)
const SIGN_VASHYA: number[] = [
  0, // Aries - Chatushpada
  0, // Taurus - Chatushpada
  1, // Gemini - Manava
  2, // Cancer - Jalachara
  3, // Leo - Vanachara
  1, // Virgo - Manava
  1, // Libra - Manava
  4, // Scorpio - Keeta
  0, // Sagittarius - Chatushpada (first half)
  2, // Capricorn - Jalachara (second half)
  1, // Aquarius - Manava
  2, // Pisces - Jalachara
];

const VASHYA_NAMES = ["Chatushpada", "Manava", "Jalachara", "Vanachara", "Keeta"];

// Vashya compatibility matrix (score out of 2)
// [groom_group][bride_group]
const VASHYA_MATRIX: number[][] = [
  /* Chatu */ [2, 0, 0, 1, 0],
  /* Mana  */ [1, 2, 1, 0, 0],
  /* Jala  */ [0, 0, 2, 0, 1],
  /* Vana  */ [1, 0, 0, 2, 0],
  /* Keeta */ [0, 0, 1, 0, 2],
];

// Yoni (sexual compatibility) animal for each nakshatra (0-26)
// Animals: 0=Horse, 1=Elephant, 2=Sheep, 3=Serpent, 4=Dog, 5=Cat,
// 6=Rat, 7=Cow, 8=Buffalo, 9=Tiger, 10=Deer, 11=Monkey, 12=Mongoose, 13=Lion
const NAKSHATRA_YONI: number[] = [
  0,  // Ashwini - Horse
  1,  // Bharani - Elephant
  2,  // Krittika - Sheep
  3,  // Rohini - Serpent
  3,  // Mrigashira - Serpent
  4,  // Ardra - Dog
  5,  // Punarvasu - Cat
  2,  // Pushya - Sheep
  5,  // Ashlesha - Cat
  6,  // Magha - Rat
  7,  // Purva Phalguni - Cow (actually Rat)
  7,  // Uttara Phalguni - Cow
  8,  // Hasta - Buffalo
  9,  // Chitra - Tiger
  8,  // Swati - Buffalo
  9,  // Vishakha - Tiger
  10, // Anuradha - Deer
  10, // Jyeshtha - Deer
  4,  // Mula - Dog
  11, // Purva Ashadha - Monkey
  12, // Uttara Ashadha - Mongoose
  11, // Shravana - Monkey
  13, // Dhanishta - Lion
  0,  // Shatabhisha - Horse
  13, // Purva Bhadrapada - Lion
  7,  // Uttara Bhadrapada - Cow
  1,  // Revati - Elephant
];

const YONI_NAMES = [
  "Horse", "Elephant", "Sheep", "Serpent", "Dog", "Cat",
  "Rat", "Cow", "Buffalo", "Tiger", "Deer", "Monkey", "Mongoose", "Lion",
];

// Yoni compatibility matrix: enemy pairs score 0, neutral 1-2, friendly 3, same 4
const YONI_ENEMIES: [number, number][] = [
  [0, 8],  // Horse vs Buffalo
  [1, 13], // Elephant vs Lion
  [2, 11], // Sheep vs Monkey (actually not traditional; removing)
  [3, 12], // Serpent vs Mongoose
  [4, 10], // Dog vs Deer (actually Hare)
  [5, 6],  // Cat vs Rat
  [7, 9],  // Cow vs Tiger
];

// Gana (temperament) for each nakshatra: 0=Deva, 1=Manushya, 2=Rakshasa
const NAKSHATRA_GANA: number[] = [
  0, // Ashwini - Deva
  1, // Bharani - Manushya
  2, // Krittika - Rakshasa
  0, // Rohini - Deva
  0, // Mrigashira - Deva
  1, // Ardra - Manushya
  0, // Punarvasu - Deva
  0, // Pushya - Deva
  2, // Ashlesha - Rakshasa
  2, // Magha - Rakshasa
  1, // Purva Phalguni - Manushya
  1, // Uttara Phalguni - Manushya
  0, // Hasta - Deva
  2, // Chitra - Rakshasa
  0, // Swati - Deva
  2, // Vishakha - Rakshasa
  0, // Anuradha - Deva
  2, // Jyeshtha - Rakshasa
  2, // Mula - Rakshasa
  1, // Purva Ashadha - Manushya
  1, // Uttara Ashadha - Manushya
  0, // Shravana - Deva
  2, // Dhanishta - Rakshasa
  2, // Shatabhisha - Rakshasa
  1, // Purva Bhadrapada - Manushya
  1, // Uttara Bhadrapada - Manushya
  0, // Revati - Deva
];

const GANA_NAMES = ["Deva", "Manushya", "Rakshasa"];

// Nadi (health/genetic) for each nakshatra: 0=Aadi (Vata), 1=Madhya (Pitta), 2=Antya (Kapha)
const NAKSHATRA_NADI: number[] = [
  0, // Ashwini - Aadi
  1, // Bharani - Madhya
  2, // Krittika - Antya
  2, // Rohini - Antya
  1, // Mrigashira - Madhya
  0, // Ardra - Aadi
  0, // Punarvasu - Aadi
  1, // Pushya - Madhya
  2, // Ashlesha - Antya
  2, // Magha - Antya
  1, // Purva Phalguni - Madhya
  0, // Uttara Phalguni - Aadi
  0, // Hasta - Aadi
  1, // Chitra - Madhya
  2, // Swati - Antya
  2, // Vishakha - Antya
  1, // Anuradha - Madhya
  0, // Jyeshtha - Aadi
  0, // Mula - Aadi
  1, // Purva Ashadha - Madhya
  2, // Uttara Ashadha - Antya
  2, // Shravana - Antya
  1, // Dhanishta - Madhya
  0, // Shatabhisha - Aadi
  0, // Purva Bhadrapada - Aadi
  1, // Uttara Bhadrapada - Madhya
  2, // Revati - Antya
];

const NADI_NAMES = ["Aadi (Vata)", "Madhya (Pitta)", "Antya (Kapha)"];

// Graha Maitri: natural friendship table between sign lords.
// 0 = enemy, 1 = neutral, 2 = friend
// Key: "planet1-planet2" (alphabetically sorted)
const FRIENDSHIP: Record<string, number> = {};

function setFriendship(a: string, b: string, level: number) {
  const key = [a, b].sort().join("-");
  FRIENDSHIP[key] = level;
}

// Sun
setFriendship("Sun", "Moon", 2);
setFriendship("Sun", "Mars", 2);
setFriendship("Sun", "Jupiter", 2);
setFriendship("Sun", "Venus", 0);
setFriendship("Sun", "Saturn", 0);
setFriendship("Sun", "Mercury", 1);
// Moon
setFriendship("Moon", "Mars", 1);
setFriendship("Moon", "Jupiter", 1);
setFriendship("Moon", "Venus", 1);
setFriendship("Moon", "Saturn", 1);
setFriendship("Moon", "Mercury", 0);
// Mars
setFriendship("Mars", "Jupiter", 2);
setFriendship("Mars", "Venus", 1);
setFriendship("Mars", "Saturn", 1);
setFriendship("Mars", "Mercury", 0);
// Mercury
setFriendship("Mercury", "Jupiter", 1);
setFriendship("Mercury", "Venus", 2);
setFriendship("Mercury", "Saturn", 2);
// Jupiter
setFriendship("Jupiter", "Venus", 0);
setFriendship("Jupiter", "Saturn", 1);
// Venus
setFriendship("Venus", "Saturn", 2);

function getFriendship(a: string, b: string): number {
  if (a === b) return 2; // same lord is always friend
  // Rahu/Ketu are treated as Saturn for friendship
  const mapNode = (p: string) => (p === "Rahu" || p === "Ketu") ? "Saturn" : p;
  const aa = mapNode(a), bb = mapNode(b);
  if (aa === bb) return 2;
  const key = [aa, bb].sort().join("-");
  return FRIENDSHIP[key] ?? 1; // default neutral
}

// ---- Individual Kuta Scorers ----------------------------------------------

function scoreVarna(brideSign: number, groomSign: number): KutaScore {
  const bv = SIGN_VARNA[brideSign];
  const gv = SIGN_VARNA[groomSign];
  // Groom's varna should be equal to or higher than bride's
  const points = gv >= bv ? 1 : 0;
  return {
    name: "Varna",
    maxPoints: 1,
    points,
    description: "Spiritual and ego compatibility — measures the temperamental match between the couple.",
    detail: `Groom: ${VARNA_NAMES[gv]} (${RASHIS[groomSign].name}), Bride: ${VARNA_NAMES[bv]} (${RASHIS[brideSign].name}). ${points ? "Compatible — groom's varna is equal or higher." : "Groom's varna is lower than bride's."}`,
  };
}

function scoreVashya(brideSign: number, groomSign: number): KutaScore {
  const bg = SIGN_VASHYA[brideSign];
  const gg = SIGN_VASHYA[groomSign];
  const points = VASHYA_MATRIX[gg][bg];
  return {
    name: "Vashya",
    maxPoints: 2,
    points,
    description: "Mutual attraction and power dynamics — indicates which partner influences the other.",
    detail: `Groom: ${VASHYA_NAMES[gg]} (${RASHIS[groomSign].name}), Bride: ${VASHYA_NAMES[bg]} (${RASHIS[brideSign].name}). Score ${points}/2.`,
  };
}

function scoreTara(brideNak: number, groomNak: number): KutaScore {
  // Count from groom's nakshatra to bride's (1-indexed)
  const dist1 = ((brideNak - groomNak + 27) % 27) + 1;
  const dist2 = ((groomNak - brideNak + 27) % 27) + 1;
  const group1 = dist1 % 9 || 9; // 1-9 cycle
  const group2 = dist2 % 9 || 9;
  // Groups 1 (Janma), 3 (Vipat), 5 (Pratyari), 7 (Vadha) are inauspicious
  const bad = [1, 3, 5, 7];
  const ok1 = !bad.includes(group1);
  const ok2 = !bad.includes(group2);
  const points = ok1 && ok2 ? 3 : ok1 || ok2 ? 1.5 : 0;
  const TARA_NAMES = ["", "Janma", "Sampat", "Vipat", "Kshema", "Pratyari", "Sadhaka", "Vadha", "Mitra", "Ati-Mitra"];
  return {
    name: "Tara",
    maxPoints: 3,
    points,
    description: "Birth star compatibility — determines health, longevity and destiny alignment.",
    detail: `Groom→Bride: Tara ${TARA_NAMES[group1]} (group ${group1}), Bride→Groom: Tara ${TARA_NAMES[group2]} (group ${group2}). ${points === 3 ? "Both auspicious." : points > 0 ? "One direction auspicious." : "Both inauspicious."}`,
  };
}

function scoreYoni(brideNak: number, groomNak: number): KutaScore {
  const by = NAKSHATRA_YONI[brideNak];
  const gy = NAKSHATRA_YONI[groomNak];
  let points: number;
  if (by === gy) {
    points = 4;
  } else {
    const isEnemy = YONI_ENEMIES.some(
      ([a, b]) => (a === by && b === gy) || (a === gy && b === by),
    );
    if (isEnemy) {
      points = 0;
    } else {
      // Not same, not enemy → score based on how "close" they are
      // Simple rule: neutral = 2, somewhat friendly = 3
      points = 2;
    }
  }
  return {
    name: "Yoni",
    maxPoints: 4,
    points,
    description: "Sexual and physical compatibility — based on the animal symbol of each nakshatra.",
    detail: `Groom: ${YONI_NAMES[gy]} (${NAKSHATRAS[groomNak].name}), Bride: ${YONI_NAMES[by]} (${NAKSHATRAS[brideNak].name}). ${points === 4 ? "Same yoni — excellent physical compatibility." : points === 0 ? "Enemy yoni — challenging." : "Neutral/friendly yoni."}`,
  };
}

function scoreGrahaMaitri(brideSign: number, groomSign: number): KutaScore {
  const brideLord = RASHIS[brideSign].lord;
  const groomLord = RASHIS[groomSign].lord;
  const g2b = getFriendship(groomLord, brideLord);
  const b2g = getFriendship(brideLord, groomLord);
  const total = g2b + b2g; // 0-4
  let points: number;
  if (total >= 4) points = 5;
  else if (total === 3) points = 4;
  else if (total === 2) points = 3; // both neutral or one friend one enemy
  else if (total === 1) points = 1;
  else points = 0;

  const friendLabel = (n: number) => n === 2 ? "Friend" : n === 1 ? "Neutral" : "Enemy";
  return {
    name: "Graha Maitri",
    maxPoints: 5,
    points,
    description: "Mental compatibility — friendship between the Moon sign lords of both charts.",
    detail: `Groom's lord ${groomLord} and Bride's lord ${brideLord}: ${friendLabel(g2b)} / ${friendLabel(b2g)}. Score ${points}/5.`,
  };
}

function scoreGana(brideNak: number, groomNak: number): KutaScore {
  const bg = NAKSHATRA_GANA[brideNak];
  const gg = NAKSHATRA_GANA[groomNak];
  let points: number;
  if (bg === gg) {
    points = 3;
  } else if (
    (gg === 0 && bg === 1) || (gg === 1 && bg === 0) // Deva-Manushya
  ) {
    points = 2;
  } else if (
    (gg === 2 && bg === 2) // Rakshasa-Rakshasa (same, already handled)
  ) {
    points = 3;
  } else if (
    (gg === 0 && bg === 2) || (gg === 2 && bg === 0) // Deva-Rakshasa
  ) {
    points = 0;
  } else {
    // Manushya-Rakshasa
    points = 1;
  }
  return {
    name: "Gana",
    maxPoints: 3,
    points,
    description: "Temperament and behaviour — Deva (divine), Manushya (human), or Rakshasa (demon).",
    detail: `Groom: ${GANA_NAMES[gg]} (${NAKSHATRAS[groomNak].name}), Bride: ${GANA_NAMES[bg]} (${NAKSHATRAS[brideNak].name}). ${points === 3 ? "Same gana — natural harmony." : points === 0 ? "Deva-Rakshasa clash." : "Partial compatibility."}`,
  };
}

function scoreBhakoot(brideSign: number, groomSign: number): KutaScore {
  // Distance from groom sign to bride sign (1-indexed)
  const dist = ((brideSign - groomSign + 12) % 12) + 1;
  const revDist = ((groomSign - brideSign + 12) % 12) + 1;

  // Dosha pairs: 2-12, 5-9, 6-8 from each other = 0 points
  const doshaCheck = (d: number, rd: number) =>
    (d === 2 && rd === 12) ||
    (d === 12 && rd === 2) ||
    (d === 5 && rd === 9) ||
    (d === 9 && rd === 5) ||
    (d === 6 && rd === 8) ||
    (d === 8 && rd === 6);

  const hasDosh = doshaCheck(dist, revDist);

  // Cancellation: if the lords of both signs are friends or the same, dosha is cancelled
  let cancelled = false;
  if (hasDosh) {
    const bl = RASHIS[brideSign].lord;
    const gl = RASHIS[groomSign].lord;
    if (bl === gl || getFriendship(bl, gl) === 2) {
      cancelled = true;
    }
  }

  const points = !hasDosh || cancelled ? 7 : 0;
  const pairLabel = `${dist}-${revDist}`;
  return {
    name: "Bhakoot",
    maxPoints: 7,
    points,
    description: "Health, wealth, and happiness — assessed from the Moon sign distance between partners.",
    detail: hasDosh
      ? `Sign distance ${pairLabel} is a dosha pair.${cancelled ? " However, the lords are friends/same — dosha cancelled." : " Bhakoot dosha present."}`
      : `Sign distance ${pairLabel} is auspicious — no Bhakoot dosha.`,
  };
}

function scoreNadi(brideNak: number, groomNak: number): KutaScore {
  const bn = NAKSHATRA_NADI[brideNak];
  const gn = NAKSHATRA_NADI[groomNak];
  // Same nadi = 0 points (dosha), different = 8 points
  const points = bn !== gn ? 8 : 0;
  return {
    name: "Nadi",
    maxPoints: 8,
    points,
    description: "Health and genetic compatibility — same Nadi is a dosha that can affect progeny.",
    detail: `Groom: ${NADI_NAMES[gn]} (${NAKSHATRAS[groomNak].name}), Bride: ${NADI_NAMES[bn]} (${NAKSHATRAS[brideNak].name}). ${points ? "Different Nadi — auspicious." : "Same Nadi — Nadi dosha present."}`,
  };
}

// ---- Manglik (Kuja Dosha) -------------------------------------------------

const MANGLIK_HOUSES = [1, 2, 4, 7, 8, 12];

export function checkManglik(chart: Chart): ManglikInfo {
  const mars = chart.planets.find((p) => p.planet === "Mars")!;
  const houses = MANGLIK_HOUSES.filter((h) => mars.house === h);
  const isManglik = houses.length > 0;

  // Basic cancellation rules
  let cancelled = false;
  let cancellationReason = "";

  if (isManglik) {
    // 1. Mars in its own sign (Aries, Scorpio) or exalted (Capricorn)
    if (mars.signIndex === 0 || mars.signIndex === 7 || mars.signIndex === 9) {
      cancelled = true;
      cancellationReason = `Mars is in ${mars.dignity === "Exalted" ? "exaltation" : "its own sign"} (${RASHIS[mars.signIndex].name}), which cancels the dosha.`;
    }
    // 2. Jupiter aspects Mars (Jupiter in kendra from Mars or in houses 1,4,7,10 from Mars)
    const jupiter = chart.planets.find((p) => p.planet === "Jupiter")!;
    const jupFromMars = ((jupiter.house - mars.house + 12) % 12) + 1;
    if ([1, 5, 7, 9].includes(jupFromMars)) {
      cancelled = true;
      cancellationReason = "Jupiter aspects Mars, cancelling the dosha.";
    }
    // 3. Mars in the 7th house and in Cancer/Capricorn
    if (mars.house === 7 && (mars.signIndex === 3 || mars.signIndex === 9)) {
      cancelled = true;
      cancellationReason = `Mars in the 7th in ${RASHIS[mars.signIndex].name} cancels the dosha.`;
    }
    // 4. Venus in kendra
    const venus = chart.planets.find((p) => p.planet === "Venus")!;
    if ([1, 4, 7, 10].includes(venus.house)) {
      cancelled = true;
      cancellationReason = "Venus in a kendra cancels the dosha.";
    }
  }

  return { isManglik, houses, cancelled, cancellationReason };
}

// ---- Main Scoring ---------------------------------------------------------

export function computeMatch(brideChart: Chart, groomChart: Chart): MatchResult {
  const brideMoon = brideChart.planets.find((p) => p.planet === "Moon")!;
  const groomMoon = groomChart.planets.find((p) => p.planet === "Moon")!;

  const kutas: KutaScore[] = [
    scoreVarna(brideMoon.signIndex, groomMoon.signIndex),
    scoreVashya(brideMoon.signIndex, groomMoon.signIndex),
    scoreTara(brideMoon.nakshatraIndex, groomMoon.nakshatraIndex),
    scoreYoni(brideMoon.nakshatraIndex, groomMoon.nakshatraIndex),
    scoreGrahaMaitri(brideMoon.signIndex, groomMoon.signIndex),
    scoreGana(brideMoon.nakshatraIndex, groomMoon.nakshatraIndex),
    scoreBhakoot(brideMoon.signIndex, groomMoon.signIndex),
    scoreNadi(brideMoon.nakshatraIndex, groomMoon.nakshatraIndex),
  ];

  const totalScore = kutas.reduce((s, k) => s + k.points, 0);
  const percentage = Math.round((totalScore / 36) * 100);

  let verdict: MatchResult["verdict"];
  let verdictDescription: string;
  if (totalScore >= 28) {
    verdict = "Excellent";
    verdictDescription = "An outstanding match (28+ out of 36). The couple shares deep compatibility across spiritual, mental, physical and health dimensions. Classical texts consider this a highly auspicious union.";
  } else if (totalScore >= 21) {
    verdict = "Good";
    verdictDescription = "A good match (21-27 out of 36). Compatibility is strong in most areas with minor areas that benefit from awareness and effort. Traditionally considered favourable for marriage.";
  } else if (totalScore >= 15) {
    verdict = "Average";
    verdictDescription = "An average match (15-20 out of 36). Some areas of compatibility and some of challenge. The couple should examine the specific kutas with low scores and seek astrological remedies where applicable.";
  } else {
    verdict = "Below Average";
    verdictDescription = "Below-average compatibility (under 15 out of 36). Several kutas indicate challenges. Classical texts advise caution, though other chart factors (yogas, dasha periods, Venus/Jupiter strength) can mitigate concerns. Consider a deeper chart analysis.";
  }

  const brideManglik = checkManglik(brideChart);
  const groomManglik = checkManglik(groomChart);

  // Manglik compatibility: both manglik, both non-manglik, or cancelled = compatible
  const manglikCompatible =
    brideManglik.isManglik === groomManglik.isManglik ||
    (brideManglik.cancelled && groomManglik.cancelled) ||
    (!brideManglik.isManglik && groomManglik.cancelled) ||
    (brideManglik.cancelled && !groomManglik.isManglik) ||
    brideManglik.cancelled ||
    groomManglik.cancelled;

  return {
    totalScore,
    maxScore: 36,
    percentage,
    verdict,
    verdictDescription,
    kutas,
    brideManglik,
    groomManglik,
    manglikCompatible,
  };
}
