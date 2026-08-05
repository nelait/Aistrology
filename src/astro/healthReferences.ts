import { HealthResult, HealthFactor, HealthArea } from "./health";
import { Chart } from "./types";
import { RASHIS, NAKSHATRAS } from "./constants";

export interface Reference { source: string; text: string; }
export interface Grounding { facts: string[]; references: Reference[]; }

const BPHS = "Brihat Parashara Hora Shastra";
const PHALADEEPIKA = "Phaladeepika";
const SARAVALI = "Saravali";
const CHARAKA = "Charaka Samhita";
const JATAKA = "Jataka Parijata";

const HEALTH_REFS: Reference[] = [
  { source: BPHS, text: "The Lagna (ascendant) and its lord are the primary indicators of physical constitution and longevity. A strong Lagna lord in kendra or trikona gives robust health." },
  { source: PHALADEEPIKA, text: "The 6th house governs diseases. Its lord's placement indicates the nature and timing of health challenges. Planets in the 6th house shape the type of ailments one may encounter." },
  { source: CHARAKA, text: "Ayurveda classifies constitution into Vata (air), Pitta (fire) and Kapha (water/earth). The dominant element in the birth chart determines one's prakriti and predisposition to certain ailments." },
  { source: SARAVALI, text: "Each planet governs specific body parts and organs. When a planet is debilitated, combust, or placed in dusthana houses (6, 8, 12), the body parts it rules become vulnerable." },
  { source: JATAKA, text: "The 8th house determines longevity and chronic conditions. Its lord and occupants indicate the nature of serious or transformative health events in life." },
];

const FACTOR_REFS: Record<string, Reference[]> = {
  "Lagna (1st House) — Overall Vitality": [
    { source: BPHS, text: "A strong Lagna lord in own sign or exaltation ensures robust physical health and quick recovery from illness. When debilitated or in dusthana, the native's immunity and vitality are reduced." },
    { source: CHARAKA, text: "The Lagna sign's element determines the baseline Ayurvedic constitution. Fire signs give Pitta prakriti, Earth and Water give Kapha, Air gives Vata." },
  ],
  "Sun — Vitality & Heart": [
    { source: PHALADEEPIKA, text: "The Sun is Atmakaraka — the soul's significator. Its strength directly correlates with life force, immunity, and the health of the heart and cardiovascular system." },
    { source: SARAVALI, text: "Sun in the 6th brings victory over disease; in the 8th may cause chronic conditions related to heat, bones or heart." },
  ],
  "Moon — Mental Health & Emotions": [
    { source: BPHS, text: "The Moon governs Manas (mind). An afflicted Moon by malefics (Saturn, Rahu, Mars) causes mental health issues — anxiety, depression, phobias, and sleep disturbances." },
    { source: CHARAKA, text: "Mental health (Manas Prakriti) is assessed through the Moon's sign, nakshatra, and aspects. A strong Moon in benefic company promotes emotional resilience." },
  ],
  "6th House — Disease & Immunity": [
    { source: PHALADEEPIKA, text: "The 6th house and its lord indicate the nature, timing and severity of diseases. When the 6th lord is strong in its own sign, the native overcomes illness through personal strength." },
  ],
  "8th House — Chronic & Surgical": [
    { source: JATAKA, text: "Planets in the 8th house indicate chronic or sudden health events. Mars gives surgical conditions; Saturn gives prolonged suffering; Rahu gives mysterious ailments." },
  ],
  "12th House — Hospitalisation": [
    { source: BPHS, text: "The 12th house governs hospitalisation, confinement and health expenditure. Malefics here may increase time spent in treatment. Benefics can indicate healing in retreat or abroad." },
  ],
};

export function healthFactorGrounding(factor: HealthFactor): Grounding {
  return {
    facts: [factor.detail],
    references: FACTOR_REFS[factor.name] ?? HEALTH_REFS.slice(0, 2),
  };
}

export function healthAreaGrounding(area: HealthArea): Grounding {
  return {
    facts: [
      `${area.name}: ${area.severity} severity.`,
      area.indication,
      `Body parts affected: ${area.bodyParts.join(", ")}.`,
      `Suggested remedy: ${area.remedy}`,
    ],
    references: HEALTH_REFS.slice(0, 3),
  };
}

export function healthGrounding(result: HealthResult, chart: Chart): Grounding {
  const moon = chart.planets.find((p) => p.planet === "Moon")!;

  const facts: string[] = [
    `Constitution: ${result.constitution}. ${result.constitutionDescription}`,
    `Vitality score: ${result.vitalityScore}/100. ${result.vitalityVerdict}`,
    `Lagna: ${RASHIS[chart.ascendantSign].name}. Moon: ${RASHIS[moon.signIndex].name}, ${NAKSHATRAS[moon.nakshatraIndex].name}.`,
    `Health vulnerabilities identified: ${result.areas.length}.`,
    ...result.areas.map((a) => `${a.name} (${a.severity}): ${a.indication}`),
    ...result.factors.map((f) => `${f.name}: ${f.detail}`),
    `General remedies: ${result.generalRemedies.join(" ")}`,
  ];

  return { facts, references: HEALTH_REFS };
}
