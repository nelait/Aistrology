// Career suggestions engine for Vedic astrology.
// Analyses a single chart to identify suitable career domains based on the 10th
// house (Karma Bhava), its lord, planets influencing career houses, the strongest
// graha, and element/sign qualities.
//
// Returns ranked career domains with strength scores and Vedic justifications.

import { Chart } from "./types";
import { PlanetName, RASHIS, NAKSHATRAS } from "./constants";
import { planetsAspectingHouse } from "./aspects";

// ---- Types ----------------------------------------------------------------

export interface CareerDomain {
  name: string;
  icon: string;
  score: number; // 0-100 strength indicator
  keywords: string[];
  reasoning: string; // why this domain is suggested
}

export interface CareerFactor {
  name: string;
  description: string;
  detail: string;
}

export interface CareerResult {
  topDomains: CareerDomain[]; // ranked by score, top 5
  allDomains: CareerDomain[]; // all scored domains
  factors: CareerFactor[]; // the astrological factors considered
  tenthHouseSummary: string;
  strongestPlanet: PlanetName;
  careerElement: string; // dominant element in career houses
}

// ---- Career domain mappings -----------------------------------------------

// What each planet signifies as a career indicator.
const PLANET_CAREERS: Record<string, { domains: string[]; keywords: string[] }> = {
  Sun: {
    domains: ["Government & Politics", "Administration", "Medicine", "Leadership"],
    keywords: ["authority", "leadership", "administration", "government", "politics", "medicine", "gold", "public service"],
  },
  Moon: {
    domains: ["Healthcare & Nursing", "Hospitality", "Public Relations", "Creative Arts"],
    keywords: ["nursing", "hospitality", "food", "travel", "public", "retail", "liquids", "dairy", "textiles", "caregiving"],
  },
  Mars: {
    domains: ["Engineering & Technology", "Military & Defence", "Sports & Fitness", "Real Estate"],
    keywords: ["engineering", "military", "police", "surgery", "sports", "real estate", "construction", "metals", "fire", "manufacturing"],
  },
  Mercury: {
    domains: ["IT & Software", "Finance & Accounting", "Writing & Media", "Commerce & Trade"],
    keywords: ["software", "IT", "writing", "journalism", "accounting", "trading", "communication", "teaching", "astrology", "mathematics", "languages"],
  },
  Jupiter: {
    domains: ["Education & Teaching", "Law & Justice", "Banking & Finance", "Spiritual & Advisory"],
    keywords: ["education", "teaching", "law", "judiciary", "banking", "finance", "consulting", "philosophy", "religious", "advisory", "counselling"],
  },
  Venus: {
    domains: ["Entertainment & Media", "Fashion & Design", "Luxury & Hospitality", "Arts & Music"],
    keywords: ["entertainment", "film", "music", "art", "fashion", "beauty", "luxury", "automobiles", "jewellery", "perfumery", "interior design", "photography"],
  },
  Saturn: {
    domains: ["Mining & Agriculture", "Manufacturing", "Social Work", "Research & Science"],
    keywords: ["mining", "oil", "agriculture", "labour", "social work", "research", "science", "archaeology", "waste management", "insurance", "iron", "steel"],
  },
  Rahu: {
    domains: ["Technology & Innovation", "Foreign Trade", "Aviation", "Unconventional Fields"],
    keywords: ["technology", "innovation", "foreign", "import-export", "aviation", "diplomacy", "research", "pharmaceuticals", "electronics", "occult"],
  },
  Ketu: {
    domains: ["Spiritual & Healing", "Research & Investigation", "Alternative Medicine", "Mathematics"],
    keywords: ["spiritual", "healing", "investigation", "detective", "alternative medicine", "programming", "mathematics", "microscopy", "linguistics"],
  },
};

// Sign-based career inclinations
const SIGN_CAREERS: string[][] = [
  /* Aries */      ["military", "sports", "surgery", "entrepreneurship", "adventure"],
  /* Taurus */     ["banking", "agriculture", "music", "luxury goods", "food industry"],
  /* Gemini */     ["journalism", "communication", "trading", "teaching", "IT"],
  /* Cancer */     ["hospitality", "nursing", "real estate", "food", "shipping"],
  /* Leo */        ["politics", "entertainment", "management", "gold", "government"],
  /* Virgo */      ["healthcare", "accounting", "analysis", "editing", "pharmaceuticals"],
  /* Libra */      ["law", "diplomacy", "fashion", "art", "partnerships"],
  /* Scorpio */    ["research", "surgery", "investigation", "insurance", "occult sciences"],
  /* Sagittarius */["education", "law", "philosophy", "travel", "publishing"],
  /* Capricorn */  ["administration", "mining", "construction", "management", "government"],
  /* Aquarius */   ["technology", "social work", "innovation", "networking", "astrology"],
  /* Pisces */     ["spirituality", "film", "photography", "healthcare", "charity"],
];

// Element career orientations
const ELEMENT_CAREER: Record<number, { name: string; orientation: string }> = {
  0: { name: "Fire", orientation: "Leadership, entrepreneurship, action-oriented roles" },
  1: { name: "Earth", orientation: "Finance, manufacturing, practical/tangible fields" },
  2: { name: "Air", orientation: "Communication, technology, intellectual pursuits" },
  3: { name: "Water", orientation: "Healing, creative arts, nurturing professions" },
};

// ---- Analysis Functions ---------------------------------------------------

function findStrongestPlanet(chart: Chart): PlanetName {
  // Scoring: Exalted=5, Moolatrikona=4, Own=4, Neutral=2, Debilitated=1
  // Bonus for being in kendra (1,4,7,10) or trikona (1,5,9)
  const scores: Record<string, number> = {};
  for (const p of chart.planets) {
    let s = 2;
    if (p.dignity === "Exalted") s = 5;
    else if (p.dignity === "Moolatrikona") s = 4;
    else if (p.dignity === "Own sign") s = 4;
    else if (p.dignity === "Debilitated") s = 1;

    // Kendra bonus
    if ([1, 4, 7, 10].includes(p.house)) s += 2;
    // Trikona bonus
    if ([5, 9].includes(p.house)) s += 1.5;
    // 10th house bonus (career relevance)
    if (p.house === 10) s += 3;

    // Retrograde planets have intensified energy
    if (p.retrograde && p.planet !== "Rahu" && p.planet !== "Ketu") s += 0.5;

    scores[p.planet] = s;
  }

  // Exclude Rahu/Ketu from strongest planet consideration
  const candidates = chart.planets.filter((p) => p.planet !== "Rahu" && p.planet !== "Ketu");
  return candidates.reduce((best, p) =>
    (scores[p.planet] ?? 0) > (scores[best.planet] ?? 0) ? p : best,
  ).planet;
}

function getDominantElement(chart: Chart): number {
  // Weighted element count from 10th house sign, 10th lord sign, and planets in 10th
  const elements = [0, 0, 0, 0]; // fire, earth, air, water
  const signOf = (idx: number) => idx % 4; // fire=0,1,2,3 maps to element

  // 10th house sign element
  const tenthSign = chart.houseSigns[9];
  elements[tenthSign % 4] += 3;

  // 10th lord's sign element
  const tenthLord = RASHIS[tenthSign].lord as PlanetName;
  const lordPos = chart.planets.find((p) => p.planet === tenthLord)!;
  elements[lordPos.signIndex % 4] += 2;

  // Planets in 10th house
  const inTenth = chart.planets.filter((p) => p.house === 10);
  for (const p of inTenth) {
    elements[p.signIndex % 4] += 2;
  }

  // Ascendant element
  elements[chart.ascendantSign % 4] += 1;

  return elements.indexOf(Math.max(...elements));
}

function buildDomainScores(chart: Chart): CareerDomain[] {
  const domainScores: Record<string, { score: number; reasons: string[]; keywords: Set<string>; icon: string }> = {};

  function addDomain(name: string, icon: string, score: number, reason: string, keywords: string[]) {
    if (!domainScores[name]) {
      domainScores[name] = { score: 0, reasons: [], keywords: new Set(), icon };
    }
    domainScores[name].score += score;
    domainScores[name].reasons.push(reason);
    for (const k of keywords) domainScores[name].keywords.add(k);
  }

  const tenthSign = chart.houseSigns[9];
  const tenthLord = RASHIS[tenthSign].lord as PlanetName;
  const tenthLordPos = chart.planets.find((p) => p.planet === tenthLord)!;

  // 1. 10th house sign career domains
  const signCareers = SIGN_CAREERS[tenthSign];
  const signName = RASHIS[tenthSign].name;
  for (const career of signCareers) {
    // Map career keywords to domain names
    for (const [planet, data] of Object.entries(PLANET_CAREERS)) {
      if (data.keywords.some((k) => career.toLowerCase().includes(k) || k.includes(career.toLowerCase()))) {
        for (const domain of data.domains) {
          addDomain(domain, getDomainIcon(domain), 15, `10th house in ${signName} indicates ${career}`, [career]);
        }
      }
    }
  }

  // 2. 10th lord's planet career domains
  const lordCareers = PLANET_CAREERS[tenthLord];
  if (lordCareers) {
    for (const domain of lordCareers.domains) {
      addDomain(domain, getDomainIcon(domain), 20,
        `10th lord ${tenthLord} naturally signifies this field`,
        lordCareers.keywords);
    }
  }

  // 3. 10th lord's house placement
  const lordHouseBoost = [1, 4, 7, 10].includes(tenthLordPos.house) ? 10
    : [5, 9].includes(tenthLordPos.house) ? 8
    : [6, 8, 12].includes(tenthLordPos.house) ? -5
    : 3;
  if (lordCareers) {
    for (const domain of lordCareers.domains) {
      addDomain(domain, getDomainIcon(domain), lordHouseBoost,
        `10th lord in ${ordinal(tenthLordPos.house)} house — ${lordHouseBoost > 0 ? "strengthens" : "challenges"} career flow`,
        []);
    }
  }

  // 4. Planets in 10th house
  const inTenth = chart.planets.filter((p) => p.house === 10);
  for (const p of inTenth) {
    const pc = PLANET_CAREERS[p.planet];
    if (pc) {
      for (const domain of pc.domains) {
        const dignityBonus = p.dignity === "Exalted" || p.dignity === "Own sign" ? 10 : p.dignity === "Debilitated" ? -5 : 0;
        addDomain(domain, getDomainIcon(domain), 25 + dignityBonus,
          `${p.planet} sits in the 10th house${p.dignity !== "Neutral" ? ` (${p.dignity})` : ""} — strong career indicator`,
          pc.keywords);
      }
    }
  }

  // 5. Planets aspecting 10th house
  const aspecting = planetsAspectingHouse(chart.planets, chart.houseSigns, 10);
  for (const planetName of aspecting) {
    if (inTenth.some((p) => p.planet === planetName)) continue; // already counted
    const pc = PLANET_CAREERS[planetName];
    if (pc) {
      for (const domain of pc.domains) {
        addDomain(domain, getDomainIcon(domain), 10,
          `${planetName} aspects the 10th house — influences career direction`,
          pc.keywords);
      }
    }
  }

  // 6. Strongest planet's domains
  const strongest = findStrongestPlanet(chart);
  const strongPC = PLANET_CAREERS[strongest];
  if (strongPC) {
    for (const domain of strongPC.domains) {
      addDomain(domain, getDomainIcon(domain), 12,
        `${strongest} is the strongest graha — its themes naturally dominate`,
        strongPC.keywords);
    }
  }

  // 7. Ascendant lord (1st house) — personal drive
  const ascLord = RASHIS[chart.ascendantSign].lord as PlanetName;
  const ascPC = PLANET_CAREERS[ascLord];
  if (ascPC) {
    for (const domain of ascPC.domains) {
      addDomain(domain, getDomainIcon(domain), 8,
        `Lagna lord ${ascLord} adds personal affinity towards this field`,
        ascPC.keywords);
    }
  }

  // Normalise scores to 0-100
  const allDomains = Object.entries(domainScores).map(([name, d]) => ({
    name,
    icon: d.icon,
    score: d.score,
    keywords: Array.from(d.keywords).slice(0, 6),
    reasoning: d.reasons.join(". ") + ".",
  }));

  const maxScore = Math.max(...allDomains.map((d) => d.score), 1);
  for (const d of allDomains) {
    d.score = Math.round((d.score / maxScore) * 100);
  }

  return allDomains.sort((a, b) => b.score - a.score);
}

function getDomainIcon(domain: string): string {
  const icons: Record<string, string> = {
    "Government & Politics": "🏛️",
    "Administration": "📋",
    "Medicine": "🏥",
    "Leadership": "👑",
    "Healthcare & Nursing": "💊",
    "Hospitality": "🏨",
    "Public Relations": "📢",
    "Creative Arts": "🎨",
    "Engineering & Technology": "⚙️",
    "Military & Defence": "🎖️",
    "Sports & Fitness": "🏅",
    "Real Estate": "🏗️",
    "IT & Software": "💻",
    "Finance & Accounting": "📊",
    "Writing & Media": "✍️",
    "Commerce & Trade": "🛒",
    "Education & Teaching": "📚",
    "Law & Justice": "⚖️",
    "Banking & Finance": "🏦",
    "Spiritual & Advisory": "🕉️",
    "Entertainment & Media": "🎬",
    "Fashion & Design": "👗",
    "Luxury & Hospitality": "💎",
    "Arts & Music": "🎵",
    "Mining & Agriculture": "⛏️",
    "Manufacturing": "🏭",
    "Social Work": "🤲",
    "Research & Science": "🔬",
    "Technology & Innovation": "🚀",
    "Foreign Trade": "🌍",
    "Aviation": "✈️",
    "Unconventional Fields": "🔮",
    "Spiritual & Healing": "🧘",
    "Research & Investigation": "🔍",
    "Alternative Medicine": "🌿",
    "Mathematics": "🧮",
  };
  return icons[domain] ?? "💼";
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---- Career Factors (what we analysed) ------------------------------------

function buildFactors(chart: Chart): CareerFactor[] {
  const tenthSign = chart.houseSigns[9];
  const tenthLord = RASHIS[tenthSign].lord as PlanetName;
  const tenthLordPos = chart.planets.find((p) => p.planet === tenthLord)!;
  const inTenth = chart.planets.filter((p) => p.house === 10);
  const aspecting = planetsAspectingHouse(chart.planets, chart.houseSigns, 10);
  const strongest = findStrongestPlanet(chart);
  const ascLord = RASHIS[chart.ascendantSign].lord as PlanetName;

  const factors: CareerFactor[] = [
    {
      name: "10th House (Karma Bhava)",
      description: "The primary house of career, profession and public status.",
      detail: `Your 10th house is in ${RASHIS[tenthSign].name}, ruled by ${tenthLord}. ${RASHIS[tenthSign].name} is a ${RASHIS[tenthSign].quality} ${RASHIS[tenthSign].element} sign, inclining towards ${SIGN_CAREERS[tenthSign].join(", ")}.`,
    },
    {
      name: "10th Lord Placement",
      description: "Where the career lord sits determines how career unfolds.",
      detail: `${tenthLord} (10th lord) sits in the ${ordinal(tenthLordPos.house)} house in ${RASHIS[tenthLordPos.signIndex].name} (${tenthLordPos.dignity}). ${[1, 4, 7, 10].includes(tenthLordPos.house) ? "Kendra placement — strong career drive." : [5, 9].includes(tenthLordPos.house) ? "Trikona placement — career supported by fortune/creativity." : [6, 8, 12].includes(tenthLordPos.house) ? "Dusthana placement — career may involve service, research or foreign lands." : "Neutral placement."}`,
    },
  ];

  if (inTenth.length > 0) {
    factors.push({
      name: "Planets in 10th House",
      description: "Planets occupying the career house directly shape professional life.",
      detail: `${inTenth.map((p) => `${p.planet} (${p.dignity})`).join(", ")} ${inTenth.length === 1 ? "sits" : "sit"} in your 10th house, directly influencing your career with ${inTenth.length === 1 ? "its" : "their"} significations.`,
    });
  }

  if (aspecting.length > 0) {
    factors.push({
      name: "Aspects on 10th House",
      description: "Planets aspecting the 10th house add their influence to career.",
      detail: `${aspecting.join(", ")} aspect${aspecting.length === 1 ? "s" : ""} your 10th house, adding ${aspecting.length === 1 ? "its" : "their"} themes to your professional life.`,
    });
  }

  factors.push({
    name: "Strongest Graha",
    description: "The most powerful planet in your chart colours all life areas, especially career.",
    detail: `${strongest} is the strongest planet in your chart. Its themes — ${PLANET_CAREERS[strongest]?.keywords.slice(0, 5).join(", ") ?? "general significations"} — naturally dominate your professional inclinations.`,
  });

  factors.push({
    name: "Lagna Lord",
    description: "The ascendant lord shows your natural approach and personal brand.",
    detail: `Your Lagna lord is ${ascLord} (${RASHIS[chart.ascendantSign].name} ascendant). ${ascLord}'s qualities shape how you present yourself professionally and what roles feel natural.`,
  });

  return factors;
}

// ---- Main Analysis --------------------------------------------------------

export function analyseCareer(chart: Chart): CareerResult {
  const allDomains = buildDomainScores(chart);
  const topDomains = allDomains.slice(0, 5);
  const factors = buildFactors(chart);
  const strongest = findStrongestPlanet(chart);
  const domElement = getDominantElement(chart);

  const tenthSign = chart.houseSigns[9];
  const tenthLord = RASHIS[tenthSign].lord as PlanetName;
  const tenthLordPos = chart.planets.find((p) => p.planet === tenthLord)!;
  const inTenth = chart.planets.filter((p) => p.house === 10);

  const tenthHouseSummary =
    `Your 10th house is ${RASHIS[tenthSign].name}, ruled by ${tenthLord} placed in the ${ordinal(tenthLordPos.house)} house. ` +
    (inTenth.length > 0
      ? `${inTenth.map((p) => p.planet).join(" and ")} ${inTenth.length === 1 ? "occupies" : "occupy"} the 10th house. `
      : "No planets directly occupy the 10th house. ") +
    `The dominant career element is ${ELEMENT_CAREER[domElement].name} — ${ELEMENT_CAREER[domElement].orientation}.`;

  return {
    topDomains,
    allDomains,
    factors,
    tenthHouseSummary,
    strongestPlanet: strongest,
    careerElement: ELEMENT_CAREER[domElement].name,
  };
}
