// Classical references for friendship compatibility, following the existing
// references pattern. Each factor and the overall result are grounded in
// paraphrased classical sources for the AI Justify flow.

import { FriendshipResult, FriendshipFactor } from "./friendship";
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
const MUHURTA = "Muhurta Chintamani";
const JATAKA_PARIJATA = "Jataka Parijata";

const FACTOR_REFS: Record<string, Reference[]> = {
  "Graha Maitri": [
    { source: BPHS, text: "The natural friendship between the lords of two Moon signs determines mental compatibility. Mutual friends share the same wavelength of thought and decision-making." },
    { source: PHALADEEPIKA, text: "When Moon sign lords are mutually friendly, understanding flows naturally. When they are enemies, each person's logic frustrates the other." },
  ],
  Gana: [
    { source: MUHURTA, text: "Gana classifies temperament: Deva (refined, idealistic), Manushya (practical, balanced), Rakshasa (intense, assertive). Same gana in friendship brings natural ease." },
    { source: SARAVALI, text: "Two Rakshasa-gana friends share intensity and loyalty. A Deva paired with Rakshasa finds their approaches to socialising and problem-solving very different." },
  ],
  Tara: [
    { source: MUHURTA, text: "Tara Kuta measures the nakshatra distance between two people. Auspicious tara groups (Sampat, Kshema, Sadhaka, Mitra, Ati-Mitra) support each other's growth and good fortune." },
    { source: JATAKA_PARIJATA, text: "When the tara is mutually auspicious, the bond supports both parties' wellbeing and life-path. Inauspicious tara creates friction in timing and goals." },
  ],
  "Element Harmony": [
    { source: BPHS, text: "The five elements (Pancha Bhuta) shape personality. Fire and Air feed each other's enthusiasm; Earth and Water nurture each other's stability. Same element brings comfort." },
    { source: SARAVALI, text: "Elemental compatibility between Moon signs determines how naturally two people energise or drain each other's emotional reserves." },
  ],
  Nadi: [
    { source: MUHURTA, text: "Nadi represents constitutional energy (Vata, Pitta, Kapha). In friendship, different nadis create a more dynamic exchange of ideas and energy, while same nadi brings comfortable familiarity." },
    { source: BPHS, text: "Unlike marriage where same nadi is a dosha, in friendship same nadi simply means similar rhythms and preferences — pleasant but less stimulating." },
  ],
  Communication: [
    { source: PHALADEEPIKA, text: "Mercury (Budha) governs communication, intellect and humour. When two people's Mercury placements are in harmonious signs (same element, trine or sextile), conversation flows effortlessly." },
    { source: SARAVALI, text: "A strong Mercury brings wit, analytical ability and expressive skill. Mercury in compatible signs between two charts indicates a meeting of minds — the hallmark of lasting friendship." },
  ],
};

/** Grounding for a single factor. */
export function factorGrounding(factor: FriendshipFactor): Grounding {
  return {
    facts: [
      `${factor.name}: ${factor.points}/${factor.maxPoints} points.`,
      factor.detail,
    ],
    references: FACTOR_REFS[factor.name] ?? [],
  };
}

/** Grounding for the overall friendship result. */
export function friendshipGrounding(
  result: FriendshipResult,
  chart1: Chart,
  chart2: Chart,
): Grounding {
  const moon1 = chart1.planets.find((p) => p.planet === "Moon")!;
  const moon2 = chart2.planets.find((p) => p.planet === "Moon")!;
  const merc1 = chart1.planets.find((p) => p.planet === "Mercury")!;
  const merc2 = chart2.planets.find((p) => p.planet === "Mercury")!;

  const facts: string[] = [
    `Overall friendship score: ${result.totalScore}/${result.maxScore} (${result.percentage}%) — ${result.verdict}.`,
    `Person 1 Moon: ${RASHIS[moon1.signIndex].name}, ${NAKSHATRAS[moon1.nakshatraIndex].name} (pada ${moon1.pada}).`,
    `Person 2 Moon: ${RASHIS[moon2.signIndex].name}, ${NAKSHATRAS[moon2.nakshatraIndex].name} (pada ${moon2.pada}).`,
    `Person 1 Mercury: ${RASHIS[merc1.signIndex].name}. Person 2 Mercury: ${RASHIS[merc2.signIndex].name}.`,
    ...result.factors.map((f) => `${f.name}: ${f.points}/${f.maxPoints}`),
  ];

  const weak = result.factors.filter((f) => f.points <= f.maxPoints * 0.25);
  if (weak.length > 0) {
    facts.push(`Areas needing effort: ${weak.map((f) => f.name).join(", ")}.`);
  }

  const strong = result.factors.filter((f) => f.points >= f.maxPoints * 0.8);
  if (strong.length > 0) {
    facts.push(`Strengths: ${strong.map((f) => f.name).join(", ")}.`);
  }

  const references: Reference[] = [
    { source: BPHS, text: "True friendship is seen through the harmony of Moon signs (emotional rapport), Mercury (intellectual exchange) and the 11th house (gains through association). A friend whose chart complements yours brings growth and joy." },
    { source: PHALADEEPIKA, text: "The strength of the 11th house and its lord in both charts, along with mutual aspects between benefics, determines the depth and longevity of friendship." },
    { source: SARAVALI, text: "Beyond chart matching, shared dasha periods that activate each person's 11th house (friends and gains) or 9th house (dharma and fortune) bring the friendship into its most productive phase." },
  ];

  return { facts, references };
}
