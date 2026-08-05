// Classical references for marriage match (Ashtakoot Gun Milan), following the
// existing references pattern in references.ts. Each kuta and the overall match
// are grounded in paraphrased classical sources so the LLM Justify cites real
// rules rather than inventing them.

import { MatchResult, KutaScore, ManglikInfo } from "./matchmaking";
import { Chart } from "./types";
import { RASHIS, NAKSHATRAS } from "./constants";
import { ordinal } from "./interpret";

export interface Reference {
  source: string;
  text: string;
}

export interface Grounding {
  facts: string[];
  references: Reference[];
}

const MUHURTA = "Muhurta Chintamani";
const BPHS = "Brihat Parashara Hora Shastra";
const PHALADEEPIKA = "Phaladeepika";
const JATAKA_PARIJATA = "Jataka Parijata";
const MANASGARI = "Manasagari";

const KUTA_REFS: Record<string, Reference[]> = {
  Varna: [
    { source: MUHURTA, text: "Varna Kuta assesses the spiritual and ego compatibility. The groom's varna should be equal to or higher than the bride's. Brahmin is the highest, followed by Kshatriya, Vaishya and Shudra." },
    { source: BPHS, text: "The varna of a sign is determined by the element and nature of its lord. Water signs are Brahmin (Sattvic), Fire signs Kshatriya (Rajasic), Earth signs Vaishya, and Air signs Shudra (Tamasic)." },
  ],
  Vashya: [
    { source: MUHURTA, text: "Vashya Kuta indicates mutual control and attraction. It classifies Moon signs into five groups: Chatushpada (quadruped), Manava (human), Jalachara (aquatic), Vanachara (wild) and Keeta (insect). Same group or compatible groups score highest." },
    { source: MANASGARI, text: "Where Vashya is compatible, there is natural magnetic attraction and willingness to adjust; without it, power struggles arise." },
  ],
  Tara: [
    { source: MUHURTA, text: "Tara Kuta (also called Dina Kuta) measures the auspiciousness of the nakshatra distance between the couple. Counting from one star to the other, the remainder when divided by 9 falls into groups: Janma (1), Sampat (2), Vipat (3), Kshema (4), Pratyari (5), Sadhaka (6), Vadha (7), Mitra (8), Ati-Mitra (9). Odd groups 1, 3, 5, 7 are inauspicious." },
    { source: JATAKA_PARIJATA, text: "When Tara is auspicious from both partners' nakshatras to the other, health and longevity of the union are supported." },
  ],
  Yoni: [
    { source: MUHURTA, text: "Yoni Kuta assesses sexual and physical compatibility by assigning each nakshatra an animal symbol. Same animals score 4, friendly animals 3, neutral 2, and enemy animals (e.g. Cat-Rat, Serpent-Mongoose, Cow-Tiger) score 0." },
    { source: BPHS, text: "Physical compatibility is essential for a harmonious married life. Enemy yoni creates friction in intimacy, while same yoni ensures natural physical rapport." },
  ],
  "Graha Maitri": [
    { source: MUHURTA, text: "Graha Maitri (also Rasyadhipati) assesses mental and intellectual compatibility by checking the natural friendship between the lords of the couple's Moon signs. Mutual friends score 5, one friend one neutral 4, both neutral 3, and enemies score low." },
    { source: PHALADEEPIKA, text: "When the lords of both Moon signs are mutually friendly, the couple shares similar thought processes, values and decision-making styles." },
  ],
  Gana: [
    { source: MUHURTA, text: "Gana Kuta classifies nakshatras into three temperaments: Deva (godly, refined), Manushya (human, practical) and Rakshasa (intense, assertive). Same gana is ideal (3 points). Deva-Manushya is acceptable (2). Deva-Rakshasa is the most challenging (0)." },
    { source: MANASGARI, text: "Gana indicates daily temperament. Two Rakshasa partners actually harmonise well since both are equally intense, whereas a Deva paired with Rakshasa finds the clash in lifestyle preferences difficult." },
  ],
  Bhakoot: [
    { source: MUHURTA, text: "Bhakoot Kuta carries the highest weight after Nadi (7 points). The sign distance between the couple's Moon signs is checked: 2-12, 5-9 and 6-8 pairs are dosha (0 points). Other distances score full 7." },
    { source: BPHS, text: "Bhakoot dosha affects health, children and financial prosperity of the couple. However, if the lords of both signs are mutual friends or the same, the dosha is cancelled." },
  ],
  Nadi: [
    { source: MUHURTA, text: "Nadi Kuta is the most important (8 points). Each nakshatra belongs to one of three nadis: Aadi (Vata), Madhya (Pitta) or Antya (Kapha). Same nadi is a dosha (0 points) as it indicates genetic and physiological incompatibility, potentially affecting progeny." },
    { source: JATAKA_PARIJATA, text: "Nadi dosha is the most feared in matchmaking. When both partners share the same nadi, classical texts warn of health issues for children and the couple. However, exceptions exist when other kutas are very strong." },
  ],
};

const MANGLIK_REFS: Reference[] = [
  { source: BPHS, text: "When Mars occupies the 1st, 2nd, 4th, 7th, 8th or 12th house from the Lagna, Moon or Venus, Manglik dosha (Kuja dosha) is said to arise. It is believed to cause friction, separation or harm to the spouse." },
  { source: PHALADEEPIKA, text: "Manglik dosha is most potent when Mars is in the 7th or 8th house. It is cancelled when Mars is in its own sign (Aries/Scorpio) or exalted (Capricorn), or when Jupiter aspects Mars, or when both partners are Manglik." },
];

/** Grounding for a single kuta. */
export function kutaGrounding(kuta: KutaScore): Grounding {
  return {
    facts: [
      `${kuta.name}: ${kuta.points}/${kuta.maxPoints} points.`,
      kuta.detail,
    ],
    references: KUTA_REFS[kuta.name] ?? [],
  };
}

/** Grounding for the overall match result, used with the Justify button. */
export function matchGrounding(
  result: MatchResult,
  brideChart: Chart,
  groomChart: Chart,
): Grounding {
  const brideMoon = brideChart.planets.find((p) => p.planet === "Moon")!;
  const groomMoon = groomChart.planets.find((p) => p.planet === "Moon")!;

  const facts: string[] = [
    `Overall compatibility score: ${result.totalScore}/${result.maxScore} (${result.percentage}%) — ${result.verdict}.`,
    `Groom's Moon: ${RASHIS[groomMoon.signIndex].name}, Nakshatra ${NAKSHATRAS[groomMoon.nakshatraIndex].name} (pada ${groomMoon.pada}).`,
    `Bride's Moon: ${RASHIS[brideMoon.signIndex].name}, Nakshatra ${NAKSHATRAS[brideMoon.nakshatraIndex].name} (pada ${brideMoon.pada}).`,
    ...result.kutas.map((k) => `${k.name}: ${k.points}/${k.maxPoints}`),
  ];

  // Highlight problem areas
  const weak = result.kutas.filter((k) => k.points === 0);
  if (weak.length > 0) {
    facts.push(`Kutas scoring zero: ${weak.map((k) => k.name).join(", ")} — these areas need attention.`);
  }

  // Manglik
  if (result.brideManglik.isManglik || result.groomManglik.isManglik) {
    const bm = result.brideManglik;
    const gm = result.groomManglik;
    facts.push(
      `Manglik status — Bride: ${bm.isManglik ? (bm.cancelled ? "Manglik (cancelled)" : "Manglik") : "Non-Manglik"}, ` +
      `Groom: ${gm.isManglik ? (gm.cancelled ? "Manglik (cancelled)" : "Manglik") : "Non-Manglik"}.`,
    );
  }

  const references: Reference[] = [
    { source: MUHURTA, text: "A total Ashtakoot score of 18 or above (half of 36) is traditionally considered the minimum for marriage. Scores above 25 are good, and above 30 are excellent." },
    { source: BPHS, text: "Gun Milan is an essential first step in matchmaking, but the full horoscopes of both partners (the strength of the 7th house, Venus, Jupiter, and the running dasha) must also be examined." },
    ...MANGLIK_REFS,
  ];

  return { facts, references };
}

/** Grounding for Manglik dosha specifically. */
export function manglikGrounding(
  manglik: ManglikInfo,
  chart: Chart,
  label: string, // "Bride" or "Groom"
): Grounding {
  const mars = chart.planets.find((p) => p.planet === "Mars")!;
  const facts: string[] = [];

  if (manglik.isManglik) {
    facts.push(
      `${label} is Manglik — Mars is in the ${ordinal(mars.house)} house from the Lagna.`,
    );
    if (manglik.cancelled) {
      facts.push(`However, the dosha is cancelled: ${manglik.cancellationReason}`);
    }
  } else {
    facts.push(`${label} is not Manglik — Mars is in the ${ordinal(mars.house)} house, which is not one of 1, 2, 4, 7, 8 or 12.`);
  }

  return { facts, references: MANGLIK_REFS };
}
