// Health analysis engine for Vedic astrology.
// Examines the 1st (vitality), 6th (disease), 8th (chronic/surgery) and 12th
// (hospitalisation) houses plus planetary dignities to identify potential health
// vulnerabilities and suggest Vedic remedies.
//
// DISCLAIMER: This is for educational/reflective purposes only — not medical advice.

import { Chart } from "./types";
import { PlanetName, RASHIS, NAKSHATRAS } from "./constants";
import { planetsAspectingHouse } from "./aspects";

// ---- Types ----------------------------------------------------------------

export interface HealthArea {
  name: string;
  icon: string;
  severity: "high" | "moderate" | "low";
  bodyParts: string[];
  indication: string;
  remedy: string;
}

export interface HealthFactor {
  name: string;
  description: string;
  detail: string;
}

export interface HealthResult {
  constitution: string; // Vata/Pitta/Kapha
  constitutionDescription: string;
  vitalityScore: number; // 0-100
  vitalityVerdict: string;
  areas: HealthArea[]; // potential vulnerabilities, sorted by severity
  factors: HealthFactor[];
  generalRemedies: string[];
}

// ---- Planet-body mappings ------------------------------------------------

const PLANET_BODY: Record<string, { parts: string[]; diseases: string[]; remedy: string }> = {
  Sun: {
    parts: ["heart", "spine", "bones", "eyes (right)", "vitality"],
    diseases: ["heart conditions", "bone/spine issues", "eye problems", "low vitality", "headaches"],
    remedy: "Surya Namaskar at sunrise, offer water to the Sun, wear ruby or red garnet, recite Aditya Hridayam.",
  },
  Moon: {
    parts: ["mind", "chest", "stomach", "fluids", "lymphatic system"],
    diseases: ["anxiety", "depression", "digestive issues", "fluid retention", "sleep disorders", "hormonal imbalance"],
    remedy: "Wear pearl or moonstone, drink water from a silver vessel, recite Chandra mantra (Om Chandraya Namaha), practice moon gazing.",
  },
  Mars: {
    parts: ["blood", "muscles", "bone marrow", "reproductive organs", "forehead"],
    diseases: ["blood disorders", "injuries/accidents", "inflammation", "fevers", "surgical interventions", "skin rashes"],
    remedy: "Recite Hanuman Chalisa on Tuesdays, wear red coral, donate red lentils, practice physical exercise regularly.",
  },
  Mercury: {
    parts: ["nervous system", "skin", "speech", "lungs", "intestines"],
    diseases: ["nervous disorders", "speech issues", "skin conditions", "respiratory issues", "intestinal problems", "cognitive issues"],
    remedy: "Wear emerald, recite Vishnu Sahasranama, practice pranayama, donate green vegetables on Wednesdays.",
  },
  Jupiter: {
    parts: ["liver", "fat tissue", "pancreas", "ears", "thighs"],
    diseases: ["liver disorders", "diabetes", "obesity", "ear infections", "cholesterol issues"],
    remedy: "Wear yellow sapphire or citrine, recite Guru mantra on Thursdays, donate yellow foods, practice moderation in diet.",
  },
  Venus: {
    parts: ["kidneys", "reproductive system", "throat", "face", "ovaries/testes"],
    diseases: ["kidney disorders", "urinary issues", "throat infections", "reproductive issues", "diabetes (sugar)"],
    remedy: "Wear diamond or white sapphire, recite Lakshmi mantra on Fridays, donate white foods, maintain hygiene.",
  },
  Saturn: {
    parts: ["teeth", "bones", "joints", "knees", "chronic conditions"],
    diseases: ["arthritis", "joint pain", "dental issues", "chronic fatigue", "depression", "paralysis"],
    remedy: "Recite Shani mantra on Saturdays, wear blue sapphire (with caution), donate black sesame and mustard oil, serve the elderly.",
  },
  Rahu: {
    parts: ["nervous system (shadow)", "poisons", "allergies", "mysterious ailments"],
    diseases: ["mysterious illnesses", "phobias", "addictions", "allergies", "poisoning", "psychosomatic disorders"],
    remedy: "Recite Rahu mantra or Durga Chalisa, donate to sanitation workers on Saturdays, wear hessonite (gomed).",
  },
  Ketu: {
    parts: ["nervous system (spiritual)", "joints", "skin", "viruses"],
    diseases: ["viral infections", "skin diseases", "joint disorders", "spiritual/psychic disturbances", "auto-immune conditions"],
    remedy: "Recite Ganesha mantra, wear cat's eye (lehsunia), donate blankets, practice meditation and detachment.",
  },
};

// Element to constitution mapping
const ELEMENT_CONSTITUTION: Record<string, string> = {
  Fire: "Pitta",
  Earth: "Kapha",
  Air: "Vata",
  Water: "Kapha",
};

const CONSTITUTION_DESC: Record<string, string> = {
  Pitta: "Pitta constitution (Fire dominant): Sharp intellect, strong digestion, warm body, prone to inflammation, acidity and heat-related conditions. Benefits from cooling foods, moderate exercise and stress management.",
  Kapha: "Kapha constitution (Earth/Water dominant): Strong build, good stamina, steady temperament, prone to congestion, weight gain, lethargy and mucous conditions. Benefits from active exercise, light diet and stimulating activities.",
  Vata: "Vata constitution (Air dominant): Light build, quick mind, variable energy, prone to nervous disorders, anxiety, dry skin, joint pain and irregular digestion. Benefits from warm foods, routine, oil massage and grounding practices.",
};

// ---- Analysis functions --------------------------------------------------

function getConstitution(chart: Chart): { type: string; desc: string } {
  const elements: Record<string, number> = { Fire: 0, Earth: 0, Air: 0, Water: 0 };

  // Lagna element (strongest weight)
  elements[RASHIS[chart.ascendantSign].element] += 4;

  // Moon sign element
  const moon = chart.planets.find((p) => p.planet === "Moon")!;
  elements[RASHIS[moon.signIndex].element] += 3;

  // Sun sign element
  const sun = chart.planets.find((p) => p.planet === "Sun")!;
  elements[RASHIS[sun.signIndex].element] += 2;

  // All planets contribute
  for (const p of chart.planets) {
    if (p.planet !== "Rahu" && p.planet !== "Ketu") {
      elements[RASHIS[p.signIndex].element] += 1;
    }
  }

  const dominant = Object.entries(elements).reduce((a, b) => a[1] >= b[1] ? a : b)[0];
  const type = ELEMENT_CONSTITUTION[dominant];
  return { type, desc: CONSTITUTION_DESC[type] };
}

function getVitalityScore(chart: Chart): { score: number; verdict: string } {
  let score = 60; // start at a base

  // Lagna lord strength
  const lagnaLord = RASHIS[chart.ascendantSign].lord as PlanetName;
  const lagnaLordPos = chart.planets.find((p) => p.planet === lagnaLord)!;
  if (lagnaLordPos.dignity === "Exalted" || lagnaLordPos.dignity === "Own sign") score += 10;
  else if (lagnaLordPos.dignity === "Moolatrikona") score += 8;
  else if (lagnaLordPos.dignity === "Debilitated") score -= 10;
  if ([1, 4, 7, 10].includes(lagnaLordPos.house)) score += 5;
  if ([6, 8, 12].includes(lagnaLordPos.house)) score -= 5;

  // Sun strength (vitality karaka)
  const sun = chart.planets.find((p) => p.planet === "Sun")!;
  if (sun.dignity === "Exalted" || sun.dignity === "Own sign") score += 8;
  else if (sun.dignity === "Debilitated") score -= 8;

  // Moon strength (mental health)
  const moon = chart.planets.find((p) => p.planet === "Moon")!;
  if (moon.dignity === "Exalted" || moon.dignity === "Own sign") score += 5;
  else if (moon.dignity === "Debilitated") score -= 8;

  // Benefics in kendra boost vitality
  const benefics = ["Jupiter", "Venus", "Mercury", "Moon"];
  for (const p of chart.planets) {
    if (benefics.includes(p.planet) && [1, 4, 7, 10].includes(p.house)) score += 3;
  }

  // Malefics in 6/8/12 without dignity reduce
  const malefics = ["Mars", "Saturn", "Rahu", "Ketu"];
  for (const p of chart.planets) {
    if (malefics.includes(p.planet) && [6, 8, 12].includes(p.house)) {
      score -= 3;
    }
  }

  score = Math.max(10, Math.min(100, score));

  let verdict: string;
  if (score >= 80) verdict = "Strong vitality — robust constitution with good natural resistance.";
  else if (score >= 60) verdict = "Moderate vitality — generally healthy with some areas needing attention.";
  else if (score >= 40) verdict = "Below average vitality — proactive health measures are recommended.";
  else verdict = "Vulnerable constitution — regular health check-ups and preventive care are important.";

  return { score, verdict };
}

function findHealthAreas(chart: Chart): HealthArea[] {
  const areas: HealthArea[] = [];

  // 1. Check each planet's dignity for health vulnerabilities
  for (const p of chart.planets) {
    const pb = PLANET_BODY[p.planet];
    if (!pb) continue;

    let severity: HealthArea["severity"] | null = null;
    let indication = "";

    if (p.dignity === "Debilitated") {
      severity = "high";
      indication = `${p.planet} is debilitated in ${RASHIS[p.signIndex].name} — weakened significations.`;
    } else if ([6, 8, 12].includes(p.house)) {
      const houseName = p.house === 6 ? "6th (disease)" : p.house === 8 ? "8th (chronic)" : "12th (hospitalisation)";
      severity = p.dignity === "Exalted" || p.dignity === "Own sign" ? "low" : "moderate";
      indication = `${p.planet} placed in the ${houseName} house in ${RASHIS[p.signIndex].name}.`;
    }

    if (severity) {
      // Pick the most relevant diseases based on severity
      const diseaseCount = severity === "high" ? 3 : severity === "moderate" ? 2 : 1;
      areas.push({
        name: `${p.planet}-related health`,
        icon: getHealthIcon(p.planet),
        severity,
        bodyParts: pb.parts.slice(0, 3),
        indication,
        remedy: pb.remedy,
      });
    }
  }

  // 2. Check 6th house lord placement
  const sixthSign = chart.houseSigns[5];
  const sixthLord = RASHIS[sixthSign].lord as PlanetName;
  const sixthLordPos = chart.planets.find((p) => p.planet === sixthLord)!;
  if ([1, 4, 7, 10].includes(sixthLordPos.house)) {
    const pb = PLANET_BODY[sixthLord];
    areas.push({
      name: "6th lord in Kendra",
      icon: "⚠️",
      severity: "moderate",
      bodyParts: pb?.parts.slice(0, 2) ?? ["general health"],
      indication: `6th lord ${sixthLord} placed in the ${ordinal(sixthLordPos.house)} house (kendra) — disease themes may manifest visibly.`,
      remedy: `Strengthen the lagna lord. ${pb?.remedy ?? "Maintain a healthy lifestyle and regular check-ups."}`,
    });
  }

  // 3. Check 8th house lord for chronic conditions
  const eighthSign = chart.houseSigns[7];
  const eighthLord = RASHIS[eighthSign].lord as PlanetName;
  const eighthLordPos = chart.planets.find((p) => p.planet === eighthLord)!;
  if (eighthLordPos.house === 1) {
    const pb = PLANET_BODY[eighthLord];
    areas.push({
      name: "8th lord in Lagna",
      icon: "🔴",
      severity: "high",
      bodyParts: pb?.parts.slice(0, 2) ?? ["overall vitality"],
      indication: `8th lord ${eighthLord} placed in the 1st house — chronic health themes may affect overall constitution.`,
      remedy: `Strengthen the lagna and its lord. ${pb?.remedy ?? "Regular health monitoring is advised."}`,
    });
  }

  // Sort by severity: high first
  const severityOrder = { high: 0, moderate: 1, low: 2 };
  areas.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return areas;
}

function buildHealthFactors(chart: Chart): HealthFactor[] {
  const lagnaLord = RASHIS[chart.ascendantSign].lord as PlanetName;
  const lagnaLordPos = chart.planets.find((p) => p.planet === lagnaLord)!;
  const sun = chart.planets.find((p) => p.planet === "Sun")!;
  const moon = chart.planets.find((p) => p.planet === "Moon")!;
  const sixthSign = chart.houseSigns[5];
  const sixthLord = RASHIS[sixthSign].lord as PlanetName;
  const sixthLordPos = chart.planets.find((p) => p.planet === sixthLord)!;

  const inSixth = chart.planets.filter((p) => p.house === 6);
  const inEighth = chart.planets.filter((p) => p.house === 8);
  const inTwelfth = chart.planets.filter((p) => p.house === 12);

  const factors: HealthFactor[] = [
    {
      name: "Lagna (1st House) — Overall Vitality",
      description: "The ascendant and its lord determine your natural constitution and physical resilience.",
      detail: `Lagna in ${RASHIS[chart.ascendantSign].name} (${RASHIS[chart.ascendantSign].element} sign). Lagna lord ${lagnaLord} is in the ${ordinal(lagnaLordPos.house)} house in ${RASHIS[lagnaLordPos.signIndex].name} (${lagnaLordPos.dignity}). ${lagnaLordPos.dignity === "Exalted" || lagnaLordPos.dignity === "Own sign" ? "Strong lagna lord — good natural resilience." : lagnaLordPos.dignity === "Debilitated" ? "Weakened lagna lord — constitution may need support." : "Neutral lagna lord dignity."}`,
    },
    {
      name: "Sun — Vitality & Heart",
      description: "The Sun is the karaka (significator) of vitality, heart, bones and general health.",
      detail: `Sun in ${RASHIS[sun.signIndex].name} (${sun.dignity}) in the ${ordinal(sun.house)} house. ${sun.dignity === "Exalted" ? "Exalted Sun — excellent vitality and strong constitution." : sun.dignity === "Debilitated" ? "Debilitated Sun — vitality may be low; heart and bone health need attention." : "Sun's condition supports moderate vitality."}`,
    },
    {
      name: "Moon — Mental Health & Emotions",
      description: "The Moon governs the mind, emotions, sleep and bodily fluids.",
      detail: `Moon in ${RASHIS[moon.signIndex].name} (${moon.dignity}), ${NAKSHATRAS[moon.nakshatraIndex].name}. ${moon.dignity === "Exalted" ? "Exalted Moon — stable mind and good emotional health." : moon.dignity === "Debilitated" ? "Debilitated Moon — anxiety, mood swings or sleep issues may arise." : "Moon's condition supports reasonable mental equilibrium."}`,
    },
    {
      name: "6th House — Disease & Immunity",
      description: "The 6th house indicates disease patterns, immunity and the body's ability to fight illness.",
      detail: `6th house in ${RASHIS[sixthSign].name}, ruled by ${sixthLord} in the ${ordinal(sixthLordPos.house)} house. ${inSixth.length > 0 ? `Planets in 6th: ${inSixth.map((p) => p.planet).join(", ")} — their significations colour health challenges.` : "No planets in the 6th house — fewer direct disease indicators."} ${[1, 4, 7, 10].includes(sixthLordPos.house) ? "6th lord in kendra — disease themes may be prominent." : [5, 9].includes(sixthLordPos.house) ? "6th lord in trikona — health challenges met with fortune." : ""}`,
    },
  ];

  if (inEighth.length > 0) {
    factors.push({
      name: "8th House — Chronic & Surgical",
      description: "The 8th house governs chronic conditions, surgery, longevity and transformative health events.",
      detail: `Planets in 8th house: ${inEighth.map((p) => `${p.planet} (${p.dignity})`).join(", ")}. These planets' significations may indicate areas prone to chronic conditions or surgical interventions.`,
    });
  }

  if (inTwelfth.length > 0) {
    factors.push({
      name: "12th House — Hospitalisation",
      description: "The 12th house indicates hospitalisation, confinement and health expenses.",
      detail: `Planets in 12th house: ${inTwelfth.map((p) => `${p.planet} (${p.dignity})`).join(", ")}. These placements may indicate periods requiring hospitalisation or health-related expenses.`,
    });
  }

  return factors;
}

function getGeneralRemedies(chart: Chart): string[] {
  const remedies: string[] = [
    "Strengthen the Lagna lord through its gemstone, mantra, or charity on its ruling day.",
  ];

  const moon = chart.planets.find((p) => p.planet === "Moon")!;
  if (moon.dignity === "Debilitated" || [6, 8, 12].includes(moon.house)) {
    remedies.push("For mental health: practice meditation, wear pearl/moonstone, drink water from silver vessel.");
  }

  const sun = chart.planets.find((p) => p.planet === "Sun")!;
  if (sun.dignity === "Debilitated" || [6, 8, 12].includes(sun.house)) {
    remedies.push("For vitality: practice Surya Namaskar at sunrise, offer water to the Sun, wear ruby.");
  }

  remedies.push(
    "Practice yoga and pranayama suited to your constitution.",
    "Follow a diet aligned with your Ayurvedic constitution (Vata/Pitta/Kapha).",
    "Regular health check-ups and preventive care are always advisable regardless of chart indications.",
  );

  return remedies;
}

function getHealthIcon(planet: string): string {
  const icons: Record<string, string> = {
    Sun: "☀️", Moon: "🌙", Mars: "🔴", Mercury: "💚",
    Jupiter: "🟡", Venus: "💎", Saturn: "🪨", Rahu: "🌑", Ketu: "🔥",
  };
  return icons[planet] ?? "🏥";
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---- Main Analysis --------------------------------------------------------

export function analyseHealth(chart: Chart): HealthResult {
  const constitution = getConstitution(chart);
  const vitality = getVitalityScore(chart);
  const areas = findHealthAreas(chart);
  const factors = buildHealthFactors(chart);
  const generalRemedies = getGeneralRemedies(chart);

  return {
    constitution: constitution.type,
    constitutionDescription: constitution.desc,
    vitalityScore: vitality.score,
    vitalityVerdict: vitality.verdict,
    areas,
    factors,
    generalRemedies,
  };
}
