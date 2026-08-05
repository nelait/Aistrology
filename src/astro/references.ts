// A curated knowledge base of classical Jyotisha principles, PARAPHRASED (not
// verbatim translations) and attributed to their source work. These ground the
// LLM "justification" so it cites real classical rules instead of inventing
// them — and they are shown to the reader as the referenced texts.

import { Chart, PlanetPosition } from "./types";
import { PlanetName, RASHIS } from "./constants";
import { naturalRelation } from "./dignity";
import { PLANET_SIGNIFICATIONS, HOUSE_SIGNIFICATIONS } from "../data/significations";
import { ordinal, houseReading } from "./interpret";
import { Yoga } from "./yogas";
import { Dosha } from "./doshas";
import { MuhurtaDay } from "./muhurta";

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
const UTTARA = "Uttara Kalamrita";
const JATAKA_PARIJATA = "Jataka Parijata";
// Some doshas (Kaal Sarpa, Shrapit, Angarak, and Pitra as commonly applied) are
// later/regional practice rather than the classical texts — attributed honestly.
const TRADITION = "Traditional Jyotisha practice";

const DIGNITY_REF: Record<string, Reference> = {
  Exalted: { source: BPHS, text: "A graha in exaltation (uccha) yields the full, auspicious fruits of its significations at their best." },
  Debilitated: { source: BPHS, text: "A debilitated (neecha) graha gives its results slowly and through difficulty; a Neecha-Bhanga can cancel the weakness and even confer Raja Yoga." },
  "Own sign": { source: PHALADEEPIKA, text: "A graha in its own sign (swakshetra) is self-supported and comfortable, protecting the houses it owns and occupies." },
  Moolatrikona: { source: PHALADEEPIKA, text: "A graha in its moolatrikona is strong and stable, close to the power it holds in its own sign." },
  Neutral: { source: SARAVALI, text: "A graha in a neutral sign gives mixed results, coloured by its dispositor, the aspects on it and the running dasha." },
};

/** Grounding for a single planet placement. */
export function planetReferences(chart: Chart, pos: PlanetPosition): Grounding {
  const sig = PLANET_SIGNIFICATIONS[pos.planet];
  const houseInfo = HOUSE_SIGNIFICATIONS[pos.house - 1];
  const signName = RASHIS[pos.signIndex].name;
  const h = pos.house;

  const facts: string[] = [
    `${pos.planet} is the natural karaka (significator) of ${sig.karaka.toLowerCase()}.`,
    `It is placed in ${signName}, in the ${ordinal(h)} house (${houseInfo.name}: ${houseInfo.keywords.join(", ")}).`,
    `Its dignity here is "${pos.dignity}".`,
  ];
  if (pos.retrograde) facts.push(`${pos.planet} is retrograde (vakri).`);

  const references: Reference[] = [];
  references.push(DIGNITY_REF[pos.dignity] ?? DIGNITY_REF.Neutral);

  const kendra = [1, 4, 7, 10].includes(h);
  const trikona = [1, 5, 9].includes(h);
  const dusthana = [6, 8, 12].includes(h);
  const upachaya = [3, 6, 10, 11].includes(h);

  if (kendra)
    references.push({ source: BPHS, text: "The kendras (1, 4, 7, 10) are the pillars of the chart (Vishnu-sthanas); a graha here gains prominence and steers the life." });
  if (trikona)
    references.push({ source: BPHS, text: "The trikonas (1, 5, 9) are the houses of fortune and dharma (Lakshmi-sthanas); a graha here blesses luck, wisdom and merit." });
  if (dusthana)
    references.push({ source: SARAVALI, text: "The dusthanas (6, 8, 12) test a graha through obstacles, transformation and loss — yet malefics can do surprisingly well in the 6th." });
  if (upachaya && !kendra)
    references.push({ source: PHALADEEPIKA, text: "The upachaya houses (3, 6, 10, 11) grow stronger with time; malefics placed here improve their results through age and effort." });
  if (pos.retrograde)
    references.push({ source: UTTARA, text: "A retrograde (vakri) graha gains directional strength (cheshta bala) and turns its themes inward and karmic, often giving repeated or unexpected results." });

  return { facts, references };
}

// Yoga-specific classical references, keyed by the yoga name used in yogas.ts.
const YOGA_REFERENCES: Record<string, Reference[]> = {
  "Gaja Kesari Yoga": [
    { source: BPHS, text: "When Jupiter occupies a kendra from the Moon, Gaja Kesari Yoga forms, granting intelligence, virtue, lasting fame and respect." },
  ],
  "Budha-Aditya Yoga": [
    { source: PHALADEEPIKA, text: "The Sun joined with Mercury (Budha-Aditya) gives sharp intellect and skill in expression, provided Mercury is not deeply combust." },
  ],
  "Chandra-Mangala Yoga": [
    { source: SARAVALI, text: "The Moon conjoined with Mars is a wealth-yoga (Chandra-Mangala), giving enterprise and earning power, though emotional intensity too." },
  ],
  "Ruchaka Yoga": [
    { source: BPHS, text: "Mars in its own or exaltation sign in a kendra forms Ruchaka, one of the Pancha-Mahapurusha yogas — courage, leadership and a commanding presence." },
  ],
  "Bhadra Yoga": [
    { source: BPHS, text: "Mercury in its own or exaltation sign in a kendra forms Bhadra — eloquence, intelligence and business acumen." },
  ],
  "Hamsa Yoga": [
    { source: BPHS, text: "Jupiter in its own or exaltation sign in a kendra forms Hamsa — wisdom, righteousness and a respected, teacher-like nature." },
  ],
  "Malavya Yoga": [
    { source: BPHS, text: "Venus in its own or exaltation sign in a kendra forms Malavya — beauty, luxury, artistic talent and marital happiness." },
  ],
  "Sasa Yoga": [
    { source: BPHS, text: "Saturn in its own or exaltation sign in a kendra forms Sasa — authority, discipline and rise through sustained effort." },
  ],
  "Kemadruma Yoga": [
    { source: JATAKA_PARIJATA, text: "With no planet in the 2nd or 12th from the Moon and none with it, Kemadruma forms — an unsupported Moon, readily cancelled by benefic aspects or a strong Moon." },
  ],
  "Durudhara Yoga": [
    { source: SARAVALI, text: "Planets flanking the Moon on both sides (2nd and 12th) form Durudhara — comfort, generosity and a well-supported mind." },
  ],
  "Sunapha Yoga": [
    { source: SARAVALI, text: "A planet (other than the Sun) in the 2nd from the Moon forms Sunapha — self-earned wealth, intelligence and reputation." },
  ],
  "Anapha Yoga": [
    { source: SARAVALI, text: "A planet (other than the Sun) in the 12th from the Moon forms Anapha — health, character and a well-known, pleasant nature." },
  ],
};

const GENERIC_YOGA_REF: Reference = {
  source: BPHS,
  text: "A yoga is a specific planetary combination whose classical result is read alongside the strength of the planets involved and the running dasha.",
};

/** Grounding for a detected yoga. */
export function yogaReferences(yoga: Yoga): Grounding {
  return {
    facts: [`${yoga.name} is present: ${yoga.description}`],
    references: YOGA_REFERENCES[yoga.name] ?? [GENERIC_YOGA_REF],
  };
}

// --- Doshas ----------------------------------------------------------------

const DOSHA_REFERENCES: Record<string, Reference[]> = {
  mangal: [
    { source: PHALADEEPIKA, text: "Mars in the 1st, 2nd, 4th, 7th, 8th or 12th (Kuja/Mangal dosha) stresses marriage and partnership with friction or delay, and is felt most for the 7th and 8th houses." },
    { source: TRADITION, text: "The dosha is reduced when Mars occupies its own or exaltation sign, and is classically neutralised by matching two Manglik charts." },
  ],
  kaalsarpa: [
    { source: TRADITION, text: "When all seven grahas are hemmed between Rahu and Ketu, Kaal Sarpa forms — a later, widely-followed tradition indicating effort met by obstacles before delayed success; a strong Jupiter greatly softens it." },
  ],
  "surya-grahan": [
    { source: SARAVALI, text: "The Sun conjoined with a node (Rahu/Ketu) is an eclipse-like affliction that clouds vitality, confidence and the father-significations of the Sun." },
  ],
  "chandra-grahan": [
    { source: SARAVALI, text: "The Moon conjoined with a node (Rahu/Ketu) eclipses the mind, giving emotional restlessness; a strong, well-placed Moon eases it." },
  ],
  "guru-chandal": [
    { source: SARAVALI, text: "Jupiter joined with Rahu forms Guru-Chandal — original, expansive thinking that can sit uneasily with orthodoxy, faith and teachers." },
  ],
  angarak: [
    { source: TRADITION, text: "Mars with Rahu (Angarak) is a fiery, explosive pairing — anger and impulsiveness if unchecked, fearless drive if disciplined." },
  ],
  shrapit: [
    { source: TRADITION, text: "Saturn with Rahu (Shrapit) indicates heavy, slow-yielding karma and persistent delay — but great endurance and hard-won mastery." },
  ],
  pitra: [
    { source: BPHS, text: "The 9th house and the Sun signify the father and ancestors (pitris); their affliction by the nodes or Saturn is read as Pitra dosha — unresolved ancestral karma, remedied by shraddha and tarpan." },
  ],
  kemadruma: [
    { source: JATAKA_PARIJATA, text: "With no planet in the 2nd or 12th from the Moon and none with it, Kemadruma forms — an unsupported Moon, readily cancelled by benefic aspects or a strong Moon." },
  ],
  shakata: [
    { source: PHALADEEPIKA, text: "The Moon in the 6th, 8th or 12th from Jupiter forms Shakata — fortune that rises and falls in cycles; cancelled when the Moon is in a kendra from the Lagna." },
  ],
};

const GENERIC_DOSHA_REF: Reference = {
  source: TRADITION,
  text: "A dosha is an afflicting combination whose result is weighed against the strength of the planets involved, its cancellations, and the running dasha.",
};

function doshaKey(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("mangal")) return "mangal";
  if (n.includes("kaal sarpa")) return "kaalsarpa";
  if (n.includes("surya grahan")) return "surya-grahan";
  if (n.includes("chandra grahan")) return "chandra-grahan";
  if (n.includes("guru chandal")) return "guru-chandal";
  if (n.includes("angarak")) return "angarak";
  if (n.includes("shrapit")) return "shrapit";
  if (n.includes("pitra")) return "pitra";
  if (n.includes("kemadruma")) return "kemadruma";
  if (n.includes("shakata")) return "shakata";
  return "";
}

/** Grounding for a detected dosha. */
export function doshaReferences(dosha: Dosha): Grounding {
  const facts: string[] = [`${dosha.name} is present: ${dosha.description}`, dosha.effect];
  if (dosha.cancellation) facts.push(`Mitigating factor: ${dosha.cancellation}`);
  return {
    facts,
    references: DOSHA_REFERENCES[doshaKey(dosha.name)] ?? [GENERIC_DOSHA_REF],
  };
}

// --- Muhurta ---------------------------------------------------------------

const MUHURTA_CHINTAMANI = "Muhurta Chintamani";

/** Grounding for a muhurta day rating. */
export function muhurtaReferences(day: MuhurtaDay): Grounding {
  const p = day.panchanga;
  const facts: string[] = [
    `${day.date} (${day.weekday}); sunrise ${day.sunrise ?? "n/a"}, sunset ${day.sunset ?? "n/a"}.`,
    `Panchanga: Tithi ${p.tithiName}, Nakshatra ${p.nakshatra}, Yoga ${p.yoga}.`,
    `Overall muhurta rating: ${day.rating}.`,
    ...day.reasons,
  ];
  if (day.inauspicious.length) {
    facts.push("Avoid: " + day.inauspicious.map((w) => `${w.name} ${w.from}–${w.to}`).join(", ") + ".");
  }
  if (day.auspicious.length) {
    facts.push("Auspicious windows: " + day.auspicious.map((w) => `${w.name} ${w.from}–${w.to}`).join(", ") + ".");
  }
  return {
    facts,
    references: [
      { source: MUHURTA_CHINTAMANI, text: "A muhurta's strength is judged from the five limbs of the Panchanga together — Vara (weekday), Tithi, Nakshatra, Yoga and Karana — with the Nakshatra and Tithi carrying the greatest weight." },
      { source: MUHURTA_CHINTAMANI, text: "Rikta tithis (the 4th, 9th and 14th) and Amavasya are avoided for beginning auspicious work; benefic nakshatras and a strong Moon are preferred." },
      { source: TRADITION, text: "Rahu Kaal, Yamaganda and Gulika Kaal — fixed portions of the day by weekday — are shunned for new undertakings, while Abhijit Muhurta (midday) and Brahma Muhurta (pre-dawn) are broadly auspicious." },
    ],
  };
}

/** House-nature references (kendra / trikona / dusthana / upachaya) for house h. */
function houseNatureRefs(h: number): Reference[] {
  const refs: Reference[] = [];
  if ([1, 4, 7, 10].includes(h))
    refs.push({ source: BPHS, text: "The kendras (1, 4, 7, 10) are the pillars of the chart (Vishnu-sthanas); their affairs are prominent and active." });
  if ([1, 5, 9].includes(h))
    refs.push({ source: BPHS, text: "The trikonas (1, 5, 9) are the houses of fortune and dharma (Lakshmi-sthanas), blessing luck and merit." });
  if ([6, 8, 12].includes(h))
    refs.push({ source: SARAVALI, text: "The dusthanas (6, 8, 12) work through struggle, transformation and loss — yet the 6th also gives victory over enemies and disease." });
  if ([3, 6, 10, 11].includes(h) && ![1, 4, 7, 10].includes(h))
    refs.push({ source: PHALADEEPIKA, text: "The upachaya houses (3, 6, 10, 11) improve with time and effort; the 11th especially governs gains and fulfilment of desires." });
  return refs;
}

/** Grounding for a bhava (house) reading. */
export function houseReferences(chart: Chart, house: number): Grounding {
  const r = houseReading(chart, house);
  const info = HOUSE_SIGNIFICATIONS[house - 1];

  const facts: string[] = [
    `The ${ordinal(house)} house (${info.name}) governs ${info.meaning}`,
    `Its sign is ${RASHIS[chart.houseSigns[house - 1]].name}, lord ${r.lord}. ${r.lordPlacement}`,
  ];
  if (r.occupants.length) facts.push(`Occupied by ${r.occupants.join(", ")}.`);
  if (r.aspectedBy.length) facts.push(`Aspected by ${r.aspectedBy.join(", ")}.`);
  facts.push(r.verdict);

  const references: Reference[] = [
    { source: PHALADEEPIKA, text: "A bhava's results follow the strength, dignity and placement of its lord, together with the planets that occupy or aspect it." },
    { source: BPHS, text: "Benefic occupation or aspect protects and elevates a bhava; malefic influence tests it, often strengthening it over time." },
    ...houseNatureRefs(house),
  ];

  return { facts, references };
}

/** Grounding for a Vimshottari dasha lord's outlook. */
export function dashaReferences(chart: Chart, lord: PlanetName): Grounding {
  const pos = chart.planets.find((p) => p.planet === lord)!;
  const sig = PLANET_SIGNIFICATIONS[lord];
  const houseInfo = HOUSE_SIGNIFICATIONS[pos.house - 1];
  const lagnaLord = RASHIS[chart.ascendantSign].lord as PlanetName;
  const relation =
    lord === lagnaLord ? "is itself the Lagna lord" : `is a ${naturalRelation(lagnaLord, lord).toLowerCase()} of the Lagna lord ${lagnaLord}`;

  const facts: string[] = [
    `${lord} is the natural karaka of ${sig.karaka.toLowerCase()}.`,
    `In this chart ${lord} sits in the ${ordinal(pos.house)} house (${houseInfo.name}) in ${RASHIS[pos.signIndex].name}, with dignity "${pos.dignity}".`,
    `${lord} ${relation}.`,
  ];
  if (pos.retrograde) facts.push(`${lord} is retrograde (vakri).`);

  const references: Reference[] = [
    { source: BPHS, text: "A dasha yields results according to the strength, ownership, placement and aspects of its lord; a strong, well-placed lord gives its promises fully." },
    DIGNITY_REF[pos.dignity] ?? DIGNITY_REF.Neutral,
    ...houseNatureRefs(pos.house),
  ];

  return { facts, references };
}
