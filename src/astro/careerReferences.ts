// Classical references for career analysis, grounding AI Justify with
// paraphrased classical sources.

import { CareerResult, CareerFactor, CareerDomain } from "./career";
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
const JATAKA_PARIJATA = "Jataka Parijata";
const ARTHASHASTRA = "Kautilya's Arthashastra";

const CAREER_REFS: Reference[] = [
  { source: BPHS, text: "The 10th house (Karma Bhava) is the primary indicator of profession, status and public deeds. Its lord, occupants and aspects determine the nature of one's livelihood." },
  { source: PHALADEEPIKA, text: "The strongest planet in the chart, especially if it aspects or occupies the 10th house, shapes the career path. The Sun gives government work; Moon gives public-facing roles; Mars gives engineering and military; Mercury gives trade and communication; Jupiter gives teaching and advisory; Venus gives arts and luxury; Saturn gives labour-intensive and service-oriented work." },
  { source: SARAVALI, text: "The Navamsa (D9) and Dasamsa (D10) divisional charts refine career predictions. The D10 specifically shows profession and is consulted for detailed vocational guidance." },
  { source: JATAKA_PARIJATA, text: "When multiple planets influence the 10th house, the person may have multiple career interests or change professions. The strongest influence ultimately prevails." },
  { source: ARTHASHASTRA, text: "The nature of one's vocation should align with one's innate constitution (svabhava). A person placed in a role that matches their planetary strengths thrives; one placed against them struggles." },
];

const FACTOR_REFS: Record<string, Reference[]> = {
  "10th House (Karma Bhava)": [
    { source: BPHS, text: "The sign on the 10th house cusp determines the nature and environment of career. Fire signs give dynamic, leadership roles. Earth signs give practical, financially oriented work. Air signs give intellectual and communicative roles. Water signs give healing, creative and nurturing professions." },
    { source: PHALADEEPIKA, text: "The quality of the 10th sign (cardinal, fixed, mutable) indicates whether the person initiates projects, sustains ongoing work, or adapts across multiple roles." },
  ],
  "10th Lord Placement": [
    { source: BPHS, text: "The house in which the 10th lord resides links career with that house's significations. In the 1st: self-made career. In the 7th: business partnerships. In the 9th: fortune through career. In the 12th: foreign lands or behind-the-scenes work." },
    { source: SARAVALI, text: "A strong 10th lord in a kendra (1, 4, 7, 10) or trikona (5, 9) ensures steady career growth. In dusthana (6, 8, 12), career involves service, research or overcoming obstacles." },
  ],
  "Planets in 10th House": [
    { source: PHALADEEPIKA, text: "A planet in the 10th house directly shapes professional identity. Sun in 10th gives government authority. Moon gives public popularity. Mars gives technical or military prowess. Mercury gives business acumen. Jupiter gives wisdom-based professions. Venus gives creative arts. Saturn gives disciplined service." },
  ],
  "Aspects on 10th House": [
    { source: BPHS, text: "Planets aspecting the 10th house add their significations to one's profession, even without occupying it. Jupiter's aspect brings ethical and advisory work. Saturn's aspect brings perseverance and structured roles." },
  ],
  "Strongest Graha": [
    { source: SARAVALI, text: "The strongest planet (by dignity, house position and aspects) colours all areas of life, including career. It represents the person's dominant talent and natural advantage." },
  ],
  "Lagna Lord": [
    { source: BPHS, text: "The Lagna lord shows one's personal approach to career — the brand and personality one brings to professional life. Its relationship with the 10th lord determines how smoothly personal identity and career align." },
  ],
};

/** Grounding for a single career factor. */
export function careerFactorGrounding(factor: CareerFactor): Grounding {
  return {
    facts: [factor.detail],
    references: FACTOR_REFS[factor.name] ?? CAREER_REFS.slice(0, 2),
  };
}

/** Grounding for a specific career domain suggestion. */
export function domainGrounding(domain: CareerDomain): Grounding {
  return {
    facts: [
      `${domain.name}: ${domain.score}% match.`,
      domain.reasoning,
      `Key areas: ${domain.keywords.join(", ")}.`,
    ],
    references: CAREER_REFS.slice(0, 3),
  };
}

/** Grounding for the overall career analysis. */
export function careerGrounding(result: CareerResult, chart: Chart): Grounding {
  const moon = chart.planets.find((p) => p.planet === "Moon")!;

  const facts: string[] = [
    result.tenthHouseSummary,
    `Strongest planet: ${result.strongestPlanet}. Dominant career element: ${result.careerElement}.`,
    `Lagna: ${RASHIS[chart.ascendantSign].name}. Moon: ${RASHIS[moon.signIndex].name}, ${NAKSHATRAS[moon.nakshatraIndex].name}.`,
    `Top career domains:`,
    ...result.topDomains.map((d, i) => `${i + 1}. ${d.name} (${d.score}%)`),
    ...result.factors.map((f) => `${f.name}: ${f.detail}`),
  ];

  return { facts, references: CAREER_REFS };
}
