// Current dasha period assessment for health & mental health.
// Analyses the Mahadasha and Antardasha lords' influence on wellness
// relative to the natal chart to produce "current period" quality indicators.

import { Chart, DashaPeriod } from "./types";
import { PlanetName, RASHIS, NAKSHATRAS } from "./constants";
import { computeVimshottari, activePeriod } from "./dasha";
import { birthDateUT } from "./engine";

export interface PeriodQuality {
  mahadashaLord: PlanetName;
  antardashaLord: PlanetName | null;
  periodLabel: string; // e.g. "Saturn Mahadasha · Mercury Antardasha"
  periodDates: string; // human-readable date range

  // Health
  healthScore: number; // 0-100
  healthVerdict: string;
  healthDetails: string[];
  healthRemedies: string[];

  // Mental health
  mentalScore: number; // 0-100
  mentalVerdict: string;
  mentalDetails: string[];
  mentalRemedies: string[];

  // Career
  careerScore: number; // 0-100
  careerVerdict: string;
  careerDetails: string[];
  careerRemedies: string[];
}

// Health impact of each planet as dasha lord
const PLANET_HEALTH_PERIOD: Record<string, {
  positive: string;
  negative: string;
  mentalPositive: string;
  mentalNegative: string;
  careerPositive: string;
  careerNegative: string;
  healthRemedies: string[];
  mentalRemedies: string[];
  careerRemedies: string[];
}> = {
  Sun: {
    positive: "Strong vitality, recognition from authorities, father's health improves.",
    negative: "Heart-related issues, bone/spine problems, eye strain, headaches from overwork.",
    mentalPositive: "Confidence, clarity of purpose, strong willpower.",
    mentalNegative: "Ego conflicts, anger, pride causing relationship stress.",
    careerPositive: "Government favour, leadership roles, promotions, authority positions.",
    careerNegative: "Power struggles, conflicts with superiors, excessive ambition.",
    healthRemedies: ["Surya Namaskar daily", "Offer water to Sun at sunrise", "Avoid excessive heat exposure"],
    mentalRemedies: ["Practice humility", "Channel leadership energy positively"],
    careerRemedies: ["Seek leadership roles", "Avoid ego clashes at work"],
  },
  Moon: {
    positive: "Emotional nourishment, good sleep, popularity, nurturing relationships.",
    negative: "Water-related issues, cold/flu, hormonal fluctuations, stomach issues.",
    mentalPositive: "Emotional sensitivity, intuition, creativity, good maternal connections.",
    mentalNegative: "Mood swings, anxiety, oversensitivity, sleep disturbances, homesickness.",
    careerPositive: "Public popularity, travel opportunities, hospitality/nurturing professions thrive.",
    careerNegative: "Career instability, frequent changes, emotional decisions at work.",
    healthRemedies: ["Drink water from silver vessel", "Avoid cold foods during Moon dasha"],
    mentalRemedies: ["Maintain sleep routine", "Practice moon-gazing meditation on Mondays", "Creative expression"],
    careerRemedies: ["Seek stable routines at work", "Roles in hospitality, healthcare, or public service"],
  },
  Mars: {
    positive: "Physical energy, courage, good for athletes and surgeons.",
    negative: "Injuries, accidents, blood pressure, inflammation, fevers, surgical events.",
    mentalPositive: "Determination, courage, decisiveness, competitive spirit.",
    mentalNegative: "Anger, impulsiveness, frustration, aggressive behaviour, road rage.",
    careerPositive: "Engineering, military, sports, surgery, real estate — action-oriented careers peak.",
    careerNegative: "Workplace conflicts, hasty decisions, over-aggression with colleagues.",
    healthRemedies: ["Channel energy through exercise", "Be cautious with sharp objects", "Anti-inflammatory diet"],
    mentalRemedies: ["Practice Sheetali pranayama (cooling breath)", "Avoid confrontation on Tuesdays"],
    careerRemedies: ["Direct energy into projects", "Avoid impulsive job changes"],
  },
  Mercury: {
    positive: "Intellectual peak, good communication, business opportunities, learning ability.",
    negative: "Nervous tension, skin issues, speech problems, intestinal disturbance.",
    mentalPositive: "Sharp intellect, wit, adaptability, networking success.",
    mentalNegative: "Overthinking, anxiety, information overload, nervous exhaustion, indecision.",
    careerPositive: "Business, communication, writing, IT, education, trade — intellectual careers flourish.",
    careerNegative: "Scattered focus, too many ventures at once, contractual disputes.",
    healthRemedies: ["Nadi Shodhana pranayama", "Limit screen time", "Green leafy vegetables"],
    mentalRemedies: ["Structured journaling", "Digital detox periods", "Limit multitasking"],
    careerRemedies: ["Focus on one venture at a time", "Leverage communication skills"],
  },
  Jupiter: {
    positive: "Overall protection, good health, spiritual growth, teacher's blessings.",
    negative: "Weight gain, liver issues, cholesterol, diabetes tendency, excess.",
    mentalPositive: "Optimism, wisdom, faith, generosity, philosophical outlook.",
    mentalNegative: "Over-confidence, preachiness, complacency, spiritual bypassing.",
    careerPositive: "Teaching, law, finance, advisory, spiritual/educational roles — expansion and promotions.",
    careerNegative: "Over-expansion, taking on too much, ignoring details.",
    healthRemedies: ["Moderate diet", "Avoid excess sweets and fats", "Yellow foods on Thursdays"],
    mentalRemedies: ["Study philosophy/scripture", "Seek mentorship", "Practice gratitude"],
    careerRemedies: ["Seek mentorship and teaching roles", "Avoid overcommitting"],
  },
  Venus: {
    positive: "Enjoyment, beauty, comfort, artistic expression, harmonious relationships.",
    negative: "Kidney/urinary issues, reproductive health, diabetes (sugar), throat infections.",
    mentalPositive: "Aesthetic appreciation, romantic fulfilment, creative inspiration.",
    mentalNegative: "Attachment, jealousy, overindulgence, vanity, relationship dependency.",
    careerPositive: "Arts, entertainment, luxury goods, fashion, hospitality — creative and beauty-related work thrives.",
    careerNegative: "Overspending, mixing pleasure with business, neglecting hard work.",
    healthRemedies: ["Kidney care", "Reduce sugar and processed foods", "Stay hydrated"],
    mentalRemedies: ["Cultivate self-love", "Artistic pursuits", "Maintain healthy boundaries"],
    careerRemedies: ["Leverage creativity", "Invest in aesthetic ventures"],
  },
  Saturn: {
    positive: "Discipline, endurance, karmic lessons learned, long-term gains.",
    negative: "Joint pain, chronic fatigue, dental issues, slow recovery, cold/dry conditions.",
    mentalPositive: "Discipline, patience, maturity, acceptance of responsibility.",
    mentalNegative: "Depression, loneliness, pessimism, fear, feeling burdened, delayed results.",
    careerPositive: "Slow but steady progress, management, mining, agriculture, public service — persistence rewarded.",
    careerNegative: "Delays, obstructions, demotion risk, hard work without recognition.",
    healthRemedies: ["Warm oil massage (Abhyanga)", "Joint exercises", "Serve the elderly on Saturdays"],
    mentalRemedies: ["Recite Shani mantra", "Volunteer work", "Accept what cannot be changed"],
    careerRemedies: ["Be patient with results", "Focus on long-term goals", "Avoid risky ventures"],
  },
  Rahu: {
    positive: "Innovation, foreign connections, unconventional healing, technology-aided health.",
    negative: "Mysterious ailments, allergies, poisoning, addictions, misdiagnosis.",
    mentalPositive: "Ambition, innovation, breaking through limitations.",
    mentalNegative: "Obsession, paranoia, phobias, addictive tendencies, delusion, restlessness.",
    careerPositive: "Foreign connections, technology, unconventional paths, sudden gains, research.",
    careerNegative: "Fraud risk, unstable partnerships, deception, over-ambition.",
    healthRemedies: ["Avoid intoxicants strictly", "Regular health check-ups", "Detox protocols"],
    mentalRemedies: ["Recite Durga Chalisa", "Grounding exercises", "Avoid conspiracy content"],
    careerRemedies: ["Verify partnerships carefully", "Embrace technology", "Avoid shortcuts"],
  },
  Ketu: {
    positive: "Spiritual insight, detachment from materialism, alternative healing receptivity.",
    negative: "Viral infections, mysterious pains, auto-immune flare-ups, diagnostic challenges.",
    mentalPositive: "Spiritual depth, intuition, liberation from attachments.",
    mentalNegative: "Confusion, disorientation, apathy, loss of purpose, feeling 'lost'.",
    careerPositive: "Spiritual/healing professions, research, niche expertise, letting go of unfulfilling work.",
    careerNegative: "Sudden career changes, loss of direction, dissatisfaction with material success.",
    healthRemedies: ["Meditation", "Alternative medicine (with professional guidance)", "Donate blankets"],
    mentalRemedies: ["Recite Ganesha mantra", "Ground through routine", "Find purpose through service"],
    careerRemedies: ["Explore spiritual or research careers", "Avoid clinging to unfulfilling roles"],
  },
};

function scorePlanetHealth(planet: PlanetName, chart: Chart): number {
  const pos = chart.planets.find((p) => p.planet === planet)!;
  let score = 55;

  if (pos.dignity === "Exalted") score += 20;
  else if (pos.dignity === "Own sign") score += 15;
  else if (pos.dignity === "Moolatrikona") score += 12;
  else if (pos.dignity === "Debilitated") score -= 15;

  if ([1, 4, 7, 10].includes(pos.house)) score += 8;
  if ([5, 9].includes(pos.house)) score += 5;
  if ([6, 8, 12].includes(pos.house)) score -= 8;

  return Math.max(10, Math.min(100, score));
}

function scorePlanetMental(planet: PlanetName, chart: Chart): number {
  const pos = chart.planets.find((p) => p.planet === planet)!;
  let score = 55;

  if (pos.dignity === "Exalted") score += 18;
  else if (pos.dignity === "Own sign") score += 14;
  else if (pos.dignity === "Moolatrikona") score += 10;
  else if (pos.dignity === "Debilitated") score -= 14;

  if ([1, 4, 5, 7, 9, 10].includes(pos.house)) score += 7;
  if ([6, 8, 12].includes(pos.house)) score -= 7;

  // Moon-related planets get mental bonus/penalty
  if (planet === "Moon" || planet === "Mercury") {
    const moon = chart.planets.find((p) => p.planet === "Moon")!;
    if (moon.dignity === "Exalted" || moon.dignity === "Own sign") score += 5;
    else if (moon.dignity === "Debilitated") score -= 5;
  }

  return Math.max(10, Math.min(100, score));
}

/** Dasha boundaries are instants in UT — read them in UT, or the same period
 *  prints a day earlier for readers west of Greenwich. */
function formatDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

function verdict(score: number, domain: string): string {
  if (score >= 75) return `Favourable period for ${domain} — the dasha lord supports well-being.`;
  if (score >= 55) return `Moderate period for ${domain} — maintain regular practices and awareness.`;
  if (score >= 35) return `Challenging period for ${domain} — proactive measures and remedies recommended.`;
  return `Difficult period for ${domain} — heightened attention, remedies and professional support advised.`;
}

export function assessCurrentPeriod(chart: Chart): PeriodQuality | null {
  const moon = chart.planets.find((p) => p.planet === "Moon")!;
  // The dasha timeline has to be anchored to the birth instant in UT. Building
  // a Date from the local components instead anchored it to the *viewer's*
  // timezone: a Hyderabad birth read from Los Angeles came out 12.5 hours off,
  // and the size of the error changed with whoever was looking. Immaterial for
  // a nineteen-year Mahadasha, not immaterial for the pratyantardashas the
  // event-analysis and rectification work depends on.
  const birthDate = birthDateUT(chart.birth);

  const dashas = computeVimshottari(moon.longitude, birthDate, 120, 2);
  const now = new Date();

  const maha = activePeriod(dashas, now);
  if (!maha) return null;

  const antar = maha.children ? activePeriod(maha.children, now) : undefined;

  const mahaLord = maha.lord;
  const antarLord = antar?.lord ?? null;
  const mahaData = PLANET_HEALTH_PERIOD[mahaLord];

  // Health scoring: blend maha (70%) and antar (30%)
  const mahaHealthScore = scorePlanetHealth(mahaLord, chart);
  const antarHealthScore = antarLord ? scorePlanetHealth(antarLord, chart) : mahaHealthScore;
  const healthScore = Math.round(mahaHealthScore * 0.7 + antarHealthScore * 0.3);

  // Mental scoring
  const mahaMentalScore = scorePlanetMental(mahaLord, chart);
  const antarMentalScore = antarLord ? scorePlanetMental(antarLord, chart) : mahaMentalScore;
  const mentalScore = Math.round(mahaMentalScore * 0.7 + antarMentalScore * 0.3);

  // Career scoring (same planet scoring as health)
  const mahaCareerScore = scorePlanetHealth(mahaLord, chart);
  const antarCareerScore = antarLord ? scorePlanetHealth(antarLord, chart) : mahaCareerScore;
  const careerScore = Math.round(mahaCareerScore * 0.7 + antarCareerScore * 0.3);

  // Build details
  const healthDetails: string[] = [];
  const mentalDetails: string[] = [];
  const careerDetails: string[] = [];
  const healthRemedies: string[] = [];
  const mentalRemedies: string[] = [];
  const careerRemedies: string[] = [];

  // Mahadasha
  const mahaPos = chart.planets.find((p) => p.planet === mahaLord)!;
  healthDetails.push(
    `Mahadasha lord ${mahaLord} (${mahaPos.dignity} in ${ordinal(mahaPos.house)} house):`,
    `  Positive: ${mahaData.positive}`,
    `  Watch for: ${mahaData.negative}`,
  );
  mentalDetails.push(
    `Mahadasha lord ${mahaLord} (${mahaPos.dignity} in ${ordinal(mahaPos.house)} house):`,
    `  Positive: ${mahaData.mentalPositive}`,
    `  Watch for: ${mahaData.mentalNegative}`,
  );
  careerDetails.push(
    `Mahadasha lord ${mahaLord} (${mahaPos.dignity} in ${ordinal(mahaPos.house)} house):`,
    `  Positive: ${mahaData.careerPositive}`,
    `  Watch for: ${mahaData.careerNegative}`,
  );
  healthRemedies.push(...mahaData.healthRemedies);
  mentalRemedies.push(...mahaData.mentalRemedies);
  careerRemedies.push(...mahaData.careerRemedies);

  // Antardasha
  if (antarLord) {
    const antarData = PLANET_HEALTH_PERIOD[antarLord];
    const antarPos = chart.planets.find((p) => p.planet === antarLord)!;
    healthDetails.push(
      `Antardasha lord ${antarLord} (${antarPos.dignity} in ${ordinal(antarPos.house)} house):`,
      `  Positive: ${antarData.positive}`,
      `  Watch for: ${antarData.negative}`,
    );
    mentalDetails.push(
      `Antardasha lord ${antarLord} (${antarPos.dignity} in ${ordinal(antarPos.house)} house):`,
      `  Positive: ${antarData.mentalPositive}`,
      `  Watch for: ${antarData.mentalNegative}`,
    );
    careerDetails.push(
      `Antardasha lord ${antarLord} (${antarPos.dignity} in ${ordinal(antarPos.house)} house):`,
      `  Positive: ${antarData.careerPositive}`,
      `  Watch for: ${antarData.careerNegative}`,
    );
    healthRemedies.push(...antarData.healthRemedies);
    mentalRemedies.push(...antarData.mentalRemedies);
    careerRemedies.push(...antarData.careerRemedies);
  }

  const periodLabel = antarLord
    ? `${mahaLord} Mahadasha · ${antarLord} Antardasha`
    : `${mahaLord} Mahadasha`;

  const periodDates = antarLord && antar
    ? `${formatDate(maha.start)} – ${formatDate(maha.end)} (Antar: ${formatDate(antar.start)} – ${formatDate(antar.end)})`
    : `${formatDate(maha.start)} – ${formatDate(maha.end)}`;

  return {
    mahadashaLord: mahaLord,
    antardashaLord: antarLord,
    periodLabel,
    periodDates,
    healthScore,
    healthVerdict: verdict(healthScore, "physical health"),
    healthDetails,
    healthRemedies: [...new Set(healthRemedies)],
    mentalScore,
    mentalVerdict: verdict(mentalScore, "mental well-being"),
    mentalDetails,
    mentalRemedies: [...new Set(mentalRemedies)],
    careerScore,
    careerVerdict: verdict(careerScore, "career"),
    careerDetails,
    careerRemedies: [...new Set(careerRemedies)],
  };
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
