// Mental health analysis engine for Vedic astrology.
// Focuses on Moon (Manas), Mercury (Buddhi), 4th house (inner peace), 5th
// house (intellect/creativity), and afflictions that classical texts associate
// with psychological vulnerability.
//
// DISCLAIMER: Educational/reflective only — not a substitute for professional
// mental health care.

import { Chart } from "./types";
import { PlanetName, RASHIS, NAKSHATRAS } from "./constants";
import { planetsAspectingHouse } from "./aspects";

// ---- Types ----------------------------------------------------------------

export interface MentalHealthDimension {
  name: string;
  icon: string;
  score: number; // 0-100 (higher = stronger/healthier)
  description: string;
  indication: string;
  remedy: string;
}

export interface MentalHealthFactor {
  name: string;
  description: string;
  detail: string;
}

export interface MentalHealthResult {
  overallScore: number; // 0-100
  overallVerdict: string;
  dimensions: MentalHealthDimension[];
  factors: MentalHealthFactor[];
  afflictions: string[]; // specific affliction patterns detected
  remedies: string[];
}

// ---- Moon affliction patterns -------------------------------------------

interface AfflictionPattern {
  name: string;
  test: (chart: Chart) => boolean;
  severity: number; // points to deduct
  description: string;
  remedy: string;
}

const AFFLICTION_PATTERNS: AfflictionPattern[] = [
  {
    name: "Debilitated Moon",
    test: (c) => {
      const moon = c.planets.find((p) => p.planet === "Moon")!;
      return moon.dignity === "Debilitated";
    },
    severity: 15,
    description: "Moon in Scorpio (debilitated) — emotions may feel intense, turbulent; mood swings and anxiety are common.",
    remedy: "Wear pearl or moonstone; recite Chandra mantra (Om Chandraya Namaha) on Mondays; drink water from silver vessel.",
  },
  {
    name: "Saturn aspecting Moon (Vish Yoga tendency)",
    test: (c) => {
      const moon = c.planets.find((p) => p.planet === "Moon")!;
      const saturn = c.planets.find((p) => p.planet === "Saturn")!;
      // Saturn aspects 3rd, 7th, 10th from itself
      const diff = ((moon.signIndex - saturn.signIndex) + 12) % 12;
      return diff === 2 || diff === 6 || diff === 9 || moon.signIndex === saturn.signIndex;
    },
    severity: 12,
    description: "Saturn's aspect on Moon — can cause melancholy, pessimism, emotional heaviness and delayed emotional fulfilment.",
    remedy: "Recite Shani mantra on Saturdays; donate black sesame and mustard oil; practice gratitude journaling.",
  },
  {
    name: "Rahu conjunct Moon (Grahan Yoga)",
    test: (c) => {
      const moon = c.planets.find((p) => p.planet === "Moon")!;
      const rahu = c.planets.find((p) => p.planet === "Rahu")!;
      return moon.signIndex === rahu.signIndex;
    },
    severity: 14,
    description: "Rahu with Moon (Grahan Yoga) — restless mind, obsessive thinking, anxiety, illusions and difficulty distinguishing reality from fear.",
    remedy: "Recite Durga Chalisa or Rahu mantra; wear Gomed (hessonite); donate to sanitation workers on Saturdays; avoid intoxicants.",
  },
  {
    name: "Ketu conjunct Moon",
    test: (c) => {
      const moon = c.planets.find((p) => p.planet === "Moon")!;
      const ketu = c.planets.find((p) => p.planet === "Ketu")!;
      return moon.signIndex === ketu.signIndex;
    },
    severity: 12,
    description: "Ketu with Moon — detachment, difficulty in emotional expression, spiritual restlessness, feeling disconnected from others.",
    remedy: "Recite Ganesha mantra; wear Cat's Eye (Lehsunia); practice grounding exercises and mindfulness meditation.",
  },
  {
    name: "Mars conjunct Moon (Chandra-Mangal Yoga)",
    test: (c) => {
      const moon = c.planets.find((p) => p.planet === "Moon")!;
      const mars = c.planets.find((p) => p.planet === "Mars")!;
      return moon.signIndex === mars.signIndex;
    },
    severity: 8,
    description: "Mars with Moon — emotional intensity, impulsiveness, anger issues; but also courage and determination when channelled well.",
    remedy: "Recite Hanuman Chalisa; channel anger through physical exercise and sports; practice cooling pranayama (Sheetali).",
  },
  {
    name: "Moon in 6th house",
    test: (c) => c.planets.find((p) => p.planet === "Moon")!.house === 6,
    severity: 8,
    description: "Moon in 6th house (Ripu Bhava) — mind occupied with worries, conflicts, health anxieties; service-oriented but mentally taxed.",
    remedy: "Practice seva (selfless service) to channel this energy positively; regular relaxation routines.",
  },
  {
    name: "Moon in 8th house",
    test: (c) => c.planets.find((p) => p.planet === "Moon")!.house === 8,
    severity: 10,
    description: "Moon in 8th house — deep emotional undercurrents, fear of loss, transformation through emotional crises; strong intuition but anxiety-prone.",
    remedy: "Practice meditation and self-reflection; wear pearl; recite Mahamrityunjaya mantra for inner security.",
  },
  {
    name: "Moon in 12th house",
    test: (c) => c.planets.find((p) => p.planet === "Moon")!.house === 12,
    severity: 7,
    description: "Moon in 12th house — rich inner world and vivid dreams, but may feel isolated, prone to escapism, sleep disturbances.",
    remedy: "Maintain a sleep hygiene routine; practice yoga nidra; creative visualisation before bed; avoid screen time before sleep.",
  },
  {
    name: "Mercury debilitated",
    test: (c) => c.planets.find((p) => p.planet === "Mercury")!.dignity === "Debilitated",
    severity: 10,
    description: "Debilitated Mercury — difficulty with logical thinking, communication blocks, nervous anxiety, overthinking without resolution.",
    remedy: "Wear emerald; recite Vishnu Sahasranama on Wednesdays; practice structured journaling; limit information overload.",
  },
  {
    name: "Mercury in 6th/8th/12th",
    test: (c) => {
      const merc = c.planets.find((p) => p.planet === "Mercury")!;
      return [6, 8, 12].includes(merc.house) && merc.dignity !== "Exalted" && merc.dignity !== "Own sign";
    },
    severity: 6,
    description: "Mercury in dusthana — intellect applied to solving problems/research, but stress from overanalysis and worry.",
    remedy: "Practice mindful communication; set boundaries with information consumption; green foods on Wednesdays.",
  },
];

// ---- Dimensions ----------------------------------------------------------

function scoreMoon(chart: Chart): MentalHealthDimension {
  const moon = chart.planets.find((p) => p.planet === "Moon")!;
  let score = 60;

  if (moon.dignity === "Exalted") score += 20;
  else if (moon.dignity === "Own sign") score += 15;
  else if (moon.dignity === "Moolatrikona") score += 12;
  else if (moon.dignity === "Debilitated") score -= 15;

  if ([1, 4, 7, 10].includes(moon.house)) score += 8;
  if ([5, 9].includes(moon.house)) score += 5;
  if ([6, 8, 12].includes(moon.house)) score -= 8;

  // Waxing moon bonus
  const sun = chart.planets.find((p) => p.planet === "Sun")!;
  const moonSunDiff = ((moon.longitude - sun.longitude) + 360) % 360;
  if (moonSunDiff > 0 && moonSunDiff < 180) score += 5; // waxing = Shukla paksha

  score = Math.max(10, Math.min(100, score));

  return {
    name: "Emotional Well-being",
    icon: "🌙",
    score,
    description: "Governed by the Moon — emotional stability, nurturing capacity, and inner peace.",
    indication: `Moon in ${RASHIS[moon.signIndex].name} (${moon.dignity}), ${NAKSHATRAS[moon.nakshatraIndex].name}, ${ordinal(moon.house)} house. ${moonSunDiff > 0 && moonSunDiff < 180 ? "Waxing Moon (Shukla Paksha) — naturally positive emotional tone." : "Waning Moon (Krishna Paksha) — introspective, inward-focused emotional nature."}`,
    remedy: "Meditate on Monday evenings; wear pearl or moonstone; maintain regular sleep patterns; practice gratitude.",
  };
}

function scoreMercury(chart: Chart): MentalHealthDimension {
  const merc = chart.planets.find((p) => p.planet === "Mercury")!;
  let score = 60;

  if (merc.dignity === "Exalted") score += 20;
  else if (merc.dignity === "Own sign") score += 15;
  else if (merc.dignity === "Moolatrikona") score += 12;
  else if (merc.dignity === "Debilitated") score -= 12;

  if ([1, 4, 7, 10].includes(merc.house)) score += 8;
  if ([5, 9].includes(merc.house)) score += 6;
  if ([6, 8, 12].includes(merc.house)) score -= 6;

  if (merc.retrograde) score -= 3; // retrograde Mercury = inner reflection

  score = Math.max(10, Math.min(100, score));

  return {
    name: "Cognitive Clarity",
    icon: "🧠",
    score,
    description: "Governed by Mercury — rational thinking, communication, learning ability, and nervous system health.",
    indication: `Mercury in ${RASHIS[merc.signIndex].name} (${merc.dignity}), ${ordinal(merc.house)} house${merc.retrograde ? " (retrograde — internalised thinking style)" : ""}. ${merc.dignity === "Exalted" || merc.dignity === "Own sign" ? "Sharp intellect and clear communication." : merc.dignity === "Debilitated" ? "May struggle with clarity; overthinking is common." : "Adequate cognitive functioning."}`,
    remedy: "Recite Vishnu Sahasranama; wear emerald; practice pranayama (Nadi Shodhana); structured journaling.",
  };
}

function scoreFourthHouse(chart: Chart): MentalHealthDimension {
  const fourthSign = chart.houseSigns[3];
  const fourthLord = RASHIS[fourthSign].lord as PlanetName;
  const fourthLordPos = chart.planets.find((p) => p.planet === fourthLord)!;
  const inFourth = chart.planets.filter((p) => p.house === 4);

  let score = 60;

  if (fourthLordPos.dignity === "Exalted" || fourthLordPos.dignity === "Own sign") score += 12;
  else if (fourthLordPos.dignity === "Debilitated") score -= 10;

  if ([1, 4, 7, 10].includes(fourthLordPos.house)) score += 5;
  if ([6, 8, 12].includes(fourthLordPos.house)) score -= 5;

  // Benefics in 4th add peace
  for (const p of inFourth) {
    if (["Jupiter", "Venus", "Mercury", "Moon"].includes(p.planet)) score += 6;
    if (["Mars", "Saturn", "Rahu", "Ketu"].includes(p.planet)) score -= 5;
  }

  score = Math.max(10, Math.min(100, score));

  const maleficsIn4 = inFourth.filter((p) => ["Mars", "Saturn", "Rahu", "Ketu"].includes(p.planet));
  const beneficsIn4 = inFourth.filter((p) => ["Jupiter", "Venus", "Mercury", "Moon"].includes(p.planet));

  return {
    name: "Inner Peace & Security",
    icon: "🏠",
    score,
    description: "Governed by the 4th house (Sukha Bhava) — domestic happiness, emotional security, and peace of mind.",
    indication: `4th house in ${RASHIS[fourthSign].name}, lord ${fourthLord} in ${ordinal(fourthLordPos.house)} house (${fourthLordPos.dignity}). ${beneficsIn4.length > 0 ? `Benefic${beneficsIn4.length > 1 ? "s" : ""} ${beneficsIn4.map((p) => p.planet).join(", ")} in 4th — promotes inner peace. ` : ""}${maleficsIn4.length > 0 ? `Malefic${maleficsIn4.length > 1 ? "s" : ""} ${maleficsIn4.map((p) => p.planet).join(", ")} in 4th — inner restlessness. ` : ""}${inFourth.length === 0 ? "No planets in 4th — peace depends largely on 4th lord's condition." : ""}`,
    remedy: "Create a peaceful home environment; practice loving-kindness meditation; strengthen the 4th lord through its gemstone.",
  };
}

function scoreFifthHouse(chart: Chart): MentalHealthDimension {
  const fifthSign = chart.houseSigns[4];
  const fifthLord = RASHIS[fifthSign].lord as PlanetName;
  const fifthLordPos = chart.planets.find((p) => p.planet === fifthLord)!;
  const inFifth = chart.planets.filter((p) => p.house === 5);

  let score = 60;

  if (fifthLordPos.dignity === "Exalted" || fifthLordPos.dignity === "Own sign") score += 10;
  else if (fifthLordPos.dignity === "Debilitated") score -= 8;

  if ([1, 4, 5, 7, 10].includes(fifthLordPos.house)) score += 5;

  for (const p of inFifth) {
    if (["Jupiter", "Mercury"].includes(p.planet)) score += 7;
    if (["Rahu", "Ketu"].includes(p.planet)) score -= 4;
  }

  score = Math.max(10, Math.min(100, score));

  return {
    name: "Creativity & Joy",
    icon: "✨",
    score,
    description: "Governed by the 5th house (Putra Bhava) — intellect, creativity, joy, romance, and purva-punya (past-life merit).",
    indication: `5th house in ${RASHIS[fifthSign].name}, lord ${fifthLord} in ${ordinal(fifthLordPos.house)} house (${fifthLordPos.dignity}). ${inFifth.length > 0 ? `Planets in 5th: ${inFifth.map((p) => p.planet).join(", ")}.` : "No planets in 5th — creative expression depends on 5th lord."}`,
    remedy: "Engage in creative hobbies (art, music, writing); recite Saraswati mantra; spend joyful time with children or in nature.",
  };
}

function scoreJupiter(chart: Chart): MentalHealthDimension {
  const jup = chart.planets.find((p) => p.planet === "Jupiter")!;
  let score = 60;

  if (jup.dignity === "Exalted") score += 18;
  else if (jup.dignity === "Own sign") score += 14;
  else if (jup.dignity === "Moolatrikona") score += 12;
  else if (jup.dignity === "Debilitated") score -= 10;

  if ([1, 4, 5, 7, 9, 10].includes(jup.house)) score += 8;
  if ([6, 8, 12].includes(jup.house)) score -= 4;

  score = Math.max(10, Math.min(100, score));

  return {
    name: "Wisdom & Optimism",
    icon: "🔆",
    score,
    description: "Governed by Jupiter — faith, optimism, higher wisdom, meaning-making, and protection from despair.",
    indication: `Jupiter in ${RASHIS[jup.signIndex].name} (${jup.dignity}), ${ordinal(jup.house)} house. ${jup.dignity === "Exalted" || jup.dignity === "Own sign" ? "Strong Jupiter — natural optimism, wisdom and faith sustain mental resilience." : jup.dignity === "Debilitated" ? "Weakened Jupiter — may struggle with finding meaning and purpose." : "Jupiter provides reasonable support for faith and optimism."}`,
    remedy: "Recite Guru mantra on Thursdays; wear yellow sapphire or citrine; seek guidance from mentors/teachers; study philosophy.",
  };
}

// ---- Main analysis -------------------------------------------------------

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function analyseMentalHealth(chart: Chart): MentalHealthResult {
  const dimensions = [
    scoreMoon(chart),
    scoreMercury(chart),
    scoreFourthHouse(chart),
    scoreFifthHouse(chart),
    scoreJupiter(chart),
  ];

  // Detect afflictions
  const afflictions: string[] = [];
  let afflictionDeduction = 0;
  for (const pattern of AFFLICTION_PATTERNS) {
    if (pattern.test(chart)) {
      afflictions.push(pattern.description);
      afflictionDeduction += pattern.severity;
    }
  }

  // Overall score: weighted average of dimensions minus affliction deductions
  const weights = [0.30, 0.20, 0.20, 0.15, 0.15]; // Moon heaviest
  const rawScore = dimensions.reduce((sum, d, i) => sum + d.score * weights[i], 0);
  const overallScore = Math.max(10, Math.min(100, Math.round(rawScore - afflictionDeduction * 0.5)));

  let overallVerdict: string;
  if (overallScore >= 80) overallVerdict = "Strong mental constitution — natural emotional resilience, clarity of thought, and capacity for inner peace.";
  else if (overallScore >= 60) overallVerdict = "Moderate mental well-being — generally stable with some areas that benefit from conscious attention and practice.";
  else if (overallScore >= 40) overallVerdict = "Below average — specific vulnerabilities exist that can be strengthened through targeted remedies and professional support.";
  else overallVerdict = "Sensitive constitution — the chart indicates notable mental health sensitivities. Regular self-care, remedies, and professional support are strongly recommended.";

  // Build factors
  const moon = chart.planets.find((p) => p.planet === "Moon")!;
  const merc = chart.planets.find((p) => p.planet === "Mercury")!;
  const fourthSign = chart.houseSigns[3];
  const fourthLord = RASHIS[fourthSign].lord as PlanetName;
  const fourthLordPos = chart.planets.find((p) => p.planet === fourthLord)!;

  const factors: MentalHealthFactor[] = [
    {
      name: "Moon (Manas — The Mind)",
      description: "The Moon is the primary karaka of the mind in Vedic astrology. Its sign, nakshatra, house, and aspects determine emotional temperament.",
      detail: `Moon in ${RASHIS[moon.signIndex].name} (${moon.dignity}), ${NAKSHATRAS[moon.nakshatraIndex].name} (pada ${moon.pada}), ${ordinal(moon.house)} house. ${NAKSHATRAS[moon.nakshatraIndex].lord === "Moon" ? "Moon in its own nakshatra — emotionally self-referencing. " : `Nakshatra lord: ${NAKSHATRAS[moon.nakshatraIndex].lord}. `}The Moon's condition directly shapes emotional responses, sleep quality, memory, and social comfort.`,
    },
    {
      name: "Mercury (Buddhi — The Intellect)",
      description: "Mercury governs rational thought, communication, and the nervous system. Its condition affects analytical ability and mental agility.",
      detail: `Mercury in ${RASHIS[merc.signIndex].name} (${merc.dignity}), ${ordinal(merc.house)} house${merc.retrograde ? " — retrograde: internalised thinking, revisiting ideas" : ""}. Mercury's strength determines how clearly one processes information and communicates feelings.`,
    },
    {
      name: "4th House (Sukha Bhava — Inner Peace)",
      description: "The 4th house represents emotional foundation, domestic happiness, mother, and the capacity for contentment.",
      detail: `4th house in ${RASHIS[fourthSign].name}, lord ${fourthLord} in the ${ordinal(fourthLordPos.house)} house (${fourthLordPos.dignity}). A strong 4th house gives deep-rooted emotional security; when afflicted, inner restlessness and domestic unease arise.`,
    },
  ];

  if (afflictions.length > 0) {
    factors.push({
      name: "Affliction Patterns Detected",
      description: "Specific planetary combinations that classical texts associate with mental/emotional challenges.",
      detail: afflictions.join(" "),
    });
  }

  // Build remedies
  const remedies: string[] = [];

  // Always recommend Moon strengthening
  remedies.push("🌙 Strengthen the Moon: meditate on Monday evenings, wear pearl/moonstone, maintain regular sleep patterns.");

  // Add affliction-specific remedies
  for (const pattern of AFFLICTION_PATTERNS) {
    if (pattern.test(chart)) {
      remedies.push(pattern.remedy);
    }
  }

  // General mental health remedies
  remedies.push(
    "🧘 Practice daily meditation — even 10 minutes of mindful breathing significantly calms Vata and Moon-related anxiety.",
    "📿 Recite Mahamrityunjaya Mantra for overall protection and mental strength.",
    "🌿 Ayurvedic herbs: Brahmi (for Moon), Ashwagandha (for stress), Jatamansi (for sleep) — consult an Ayurvedic practitioner.",
    "💬 Professional support: This analysis highlights astrological tendencies. For persistent mental health concerns, always consult a qualified mental health professional.",
  );

  return {
    overallScore,
    overallVerdict,
    dimensions,
    factors,
    afflictions,
    remedies,
  };
}
