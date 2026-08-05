// Classical references for business partnership compatibility.
// Each factor and the overall result are grounded in paraphrased
// classical sources for the AI Justify flow.

import { PartnershipResult, PartnershipFactor } from "./partnership";
import { Chart } from "./types";
import { RASHIS, NAKSHATRAS } from "./constants";

export interface Reference {
  source: string;
  text: string;
}

export interface Grounding {
  facts: string[];
  references: Reference[];
}

const BPHS = "Brihat Parashara Hora Shastra";
const PHALADEEPIKA = "Phaladeepika";
const SARAVALI = "Saravali";
const ARTHASHASTRA = "Kautilya's Arthashastra";
const JATAKA_PARIJATA = "Jataka Parijata";

const FACTOR_REFS: Record<string, Reference[]> = {
  "Mercury Synergy": [
    { source: BPHS, text: "Mercury (Budha) governs trade, contracts, intellect and communication. When two charts have harmonious Mercury placements, business discussions are productive and negotiations reach fair outcomes." },
    { source: ARTHASHASTRA, text: "A partnership thrives on clear communication and shared analytical frameworks. The alignment of Budha in both charts indicates the capacity for rational, profit-oriented decision-making." },
  ],
  "Jupiter Alignment": [
    { source: BPHS, text: "Jupiter (Guru) is the karaka for wealth, wisdom, dharma and expansion. When Jupiter is harmonious between two charts, both partners share similar ethics and growth ambitions." },
    { source: PHALADEEPIKA, text: "Jupiter's placement determines one's approach to risk, investment and moral boundaries. Partners with aligned Jupiters rarely have fundamental disagreements about business direction." },
  ],
  "Saturn Commitment": [
    { source: SARAVALI, text: "Saturn (Shani) governs perseverance, structure, long-term planning and the ability to endure adversity. Compatible Saturn placements indicate both partners can weather business downturns together." },
    { source: JATAKA_PARIJATA, text: "Where Saturn is harmonious, the work ethic and sense of duty are matched. Dissonant Saturns create friction over timelines, delegation and discipline." },
  ],
  "Leadership Dynamics": [
    { source: BPHS, text: "The Sun (Surya) represents authority, ego, leadership and the soul's purpose. In partnership, compatible Suns allow natural role-division; conflicting Suns create power struggles." },
    { source: ARTHASHASTRA, text: "A successful venture requires clarity in who leads which domain. The Sun's placement reveals each person's natural sphere of authority." },
  ],
  "Wealth Potential": [
    { source: BPHS, text: "The 2nd house governs accumulated wealth and capital, while the 11th house governs gains, income and fulfilment of desires. When these lords are friendly across two charts, financial synergy is indicated." },
    { source: PHALADEEPIKA, text: "Cross-compatibility between the 2nd lord of one chart and the 11th lord of the other indicates that one partner's capital naturally amplifies the other's earning potential." },
  ],
  "Graha Maitri": [
    { source: BPHS, text: "The natural friendship between Moon sign lords determines baseline emotional rapport. In business, this translates to trust, comfort in meetings and aligned intuitive responses to opportunities." },
    { source: SARAVALI, text: "When the Moon sign lords are friendly, partners feel a natural ease in each other's company — critical for sustaining long hours and high-pressure decisions." },
  ],
};

/** Grounding for a single factor. */
export function partnershipFactorGrounding(factor: PartnershipFactor): Grounding {
  return {
    facts: [
      `${factor.name}: ${factor.points}/${factor.maxPoints} points.`,
      factor.detail,
    ],
    references: FACTOR_REFS[factor.name] ?? [],
  };
}

/** Grounding for the overall partnership result. */
export function partnershipGrounding(
  result: PartnershipResult,
  chart1: Chart,
  chart2: Chart,
): Grounding {
  const moon1 = chart1.planets.find((p) => p.planet === "Moon")!;
  const moon2 = chart2.planets.find((p) => p.planet === "Moon")!;
  const merc1 = chart1.planets.find((p) => p.planet === "Mercury")!;
  const merc2 = chart2.planets.find((p) => p.planet === "Mercury")!;
  const jup1 = chart1.planets.find((p) => p.planet === "Jupiter")!;
  const jup2 = chart2.planets.find((p) => p.planet === "Jupiter")!;

  const facts: string[] = [
    `Overall partnership score: ${result.totalScore}/${result.maxScore} (${result.percentage}%) — ${result.verdict}.`,
    `Person 1 Moon: ${RASHIS[moon1.signIndex].name}, Mercury: ${RASHIS[merc1.signIndex].name}, Jupiter: ${RASHIS[jup1.signIndex].name}.`,
    `Person 2 Moon: ${RASHIS[moon2.signIndex].name}, Mercury: ${RASHIS[merc2.signIndex].name}, Jupiter: ${RASHIS[jup2.signIndex].name}.`,
    ...result.factors.map((f) => `${f.name}: ${f.points}/${f.maxPoints}`),
  ];

  const weak = result.factors.filter((f) => f.points <= f.maxPoints * 0.25);
  if (weak.length > 0) {
    facts.push(`Areas needing attention: ${weak.map((f) => f.name).join(", ")}.`);
  }

  const strong = result.factors.filter((f) => f.points >= f.maxPoints * 0.8);
  if (strong.length > 0) {
    facts.push(`Partnership strengths: ${strong.map((f) => f.name).join(", ")}.`);
  }

  const references: Reference[] = [
    { source: BPHS, text: "For business partnerships, examine the 7th house (partnerships/contracts), 10th house (career/status), 2nd house (capital) and 11th house (gains). The lords of these houses and their mutual relationships determine the venture's trajectory." },
    { source: ARTHASHASTRA, text: "A prosperous alliance requires complementary skills, shared ethics and clear contractual frameworks. The strength of Mercury ensures fair dealing; Jupiter provides growth; Saturn provides endurance." },
    { source: PHALADEEPIKA, text: "The running dasha periods of both partners should also be examined. A venture started when both partners run favourable dashas (lords in kendra or trikona) has the greatest chance of success." },
  ];

  return { facts, references };
}
