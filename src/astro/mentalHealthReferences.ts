import { MentalHealthResult, MentalHealthFactor, MentalHealthDimension } from "./mentalHealth";
import { Chart } from "./types";
import { RASHIS, NAKSHATRAS } from "./constants";

export interface Reference { source: string; text: string; }
export interface Grounding { facts: string[]; references: Reference[]; }

const BPHS = "Brihat Parashara Hora Shastra";
const PHALADEEPIKA = "Phaladeepika";
const SARAVALI = "Saravali";
const CHARAKA = "Charaka Samhita";
const UTTARA = "Uttara Kalamrita";

const MH_REFS: Reference[] = [
  { source: BPHS, text: "The Moon is the karaka (significator) of the mind (Manas). Its strength, dignity and freedom from malefic aspects determine emotional stability and mental peace." },
  { source: PHALADEEPIKA, text: "When the Moon is afflicted by Saturn, Rahu or Mars without benefic aspects, the native suffers from mental disturbance, anxiety and melancholy. A strong Moon in kendra gives a stable, popular and contented mind." },
  { source: CHARAKA, text: "Manas Prakriti (mental constitution) is assessed through the Moon's qualities. Sattvic Moon nakshatras produce balanced minds; Rajasic ones produce restless, ambitious minds; Tamasic ones produce heavy, lethargic tendencies." },
  { source: SARAVALI, text: "Mercury governs Buddhi (intellect and discrimination). When Mercury is strong and unafflicted, the native possesses clear thinking, good communication and mental flexibility. Debilitated Mercury causes confusion and nervous disorders." },
  { source: UTTARA, text: "The 4th house is Sukha Bhava — the house of inner happiness. Benefics here (especially Jupiter or Venus) give deep contentment. Malefics cause mental unrest and domestic disturbance." },
];

const FACTOR_REFS: Record<string, Reference[]> = {
  "Moon (Manas — The Mind)": [
    { source: BPHS, text: "The Moon's nakshatra determines the Guna quality of the mind. Ashwini, Mrigashira, Pushya, Hasta, Swati, Anuradha, Shravana and Revati are Sattvic — promoting mental purity and balance." },
    { source: PHALADEEPIKA, text: "A waxing Moon (Shukla Paksha) gives a more positive emotional disposition than a waning Moon. The brightness of the Moon reflects the brightness of the mind." },
  ],
  "Mercury (Buddhi — The Intellect)": [
    { source: SARAVALI, text: "Mercury in conjunction with Jupiter produces Buddhaditya-like wisdom. Mercury with Rahu causes overthinking and nervous anxiety. Mercury with Venus gives artistic and creative intelligence." },
  ],
  "4th House (Sukha Bhava — Inner Peace)": [
    { source: UTTARA, text: "The 4th house lord's placement indicates the source of one's inner peace. In the 9th: peace through spirituality. In the 10th: peace through career fulfilment. In the 12th: peace through solitude and meditation." },
  ],
  "Affliction Patterns Detected": [
    { source: PHALADEEPIKA, text: "Grahan Yoga (Rahu/Ketu with Moon) causes Chandra Dosha — the native's mind is clouded by illusions, fears and obsessive patterns. Remedies include Durga worship and charity." },
    { source: BPHS, text: "When Saturn aspects the Moon (Vish Yoga tendency), the native experiences delayed emotional satisfaction, melancholy and a sense of heavy responsibility from an early age." },
  ],
};

export function mentalFactorGrounding(factor: MentalHealthFactor): Grounding {
  return {
    facts: [factor.detail],
    references: FACTOR_REFS[factor.name] ?? MH_REFS.slice(0, 2),
  };
}

export function mentalDimensionGrounding(dim: MentalHealthDimension): Grounding {
  return {
    facts: [
      `${dim.name}: ${dim.score}/100.`,
      dim.indication,
      `Remedy: ${dim.remedy}`,
    ],
    references: MH_REFS.slice(0, 3),
  };
}

export function mentalHealthGrounding(result: MentalHealthResult, chart: Chart): Grounding {
  const moon = chart.planets.find((p) => p.planet === "Moon")!;

  const facts: string[] = [
    `Overall mental well-being score: ${result.overallScore}/100. ${result.overallVerdict}`,
    `Lagna: ${RASHIS[chart.ascendantSign].name}. Moon: ${RASHIS[moon.signIndex].name}, ${NAKSHATRAS[moon.nakshatraIndex].name}.`,
    ...result.dimensions.map((d) => `${d.name} (${d.score}/100): ${d.indication}`),
    ...(result.afflictions.length > 0
      ? [`Affliction patterns: ${result.afflictions.join(" ")}`]
      : ["No major affliction patterns detected."]),
    ...result.factors.map((f) => `${f.name}: ${f.detail}`),
  ];

  return { facts, references: MH_REFS };
}
