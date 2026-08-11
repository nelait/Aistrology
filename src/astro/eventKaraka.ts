// The karaka prior: which houses, grahas and vargas classical Jyotisha assigns
// to each kind of life event.
//
// This table is the single most important guard against the failure mode
// described in docs/rectification-and-event-analysis.md (Part 2). With nine
// dasha lords across three nested levels, twelve houses, aspects and transits,
// SOME combination can be narrated as an explanation for any date whatsoever.
// A scorer built by looking at real events and adding rules until they fit
// would reach perfect "accuracy" and mean nothing at all.
//
// So this file is a PRIOR, not a model. It is written from the classical
// significations before any user data is scored, every row carries its source,
// and it must never be tuned to make a particular chart or a particular user's
// events come out right. If a row is wrong, fix it against the text it cites —
// not against the outcome you wanted.

import { PlanetName } from "./constants";
import { Varga } from "./varga";

export type EventTypeId =
  | "marriage"
  | "childbirth"
  | "job_start"
  | "promotion"
  | "job_loss"
  | "business_start"
  | "education"
  | "relocation"
  | "foreign_travel"
  | "property"
  | "vehicle"
  | "illness"
  | "surgery"
  | "bereavement_father"
  | "bereavement_mother"
  | "accident"
  | "litigation"
  | "financial_gain"
  | "financial_loss"
  | "spiritual";

/**
 * How an event behaves in time.
 *  - `change`   happens at an instant, and classically clusters at dasha
 *               boundaries — so boundary proximity is evidence.
 *  - `onset`    begins at an instant but unfolds; boundary proximity is weak
 *               evidence.
 *  - `state`    a condition that was true over a period; boundaries say nothing.
 */
export type EventTiming = "change" | "onset" | "state";

/**
 * Whether the classical reading expects benefic or malefic agency. This decides
 * which grahas count as *supporting* evidence: Saturn over the 10th is evidence
 * for a job loss and evidence against a promotion, and a scorer that ignores
 * the direction would score both identically.
 */
export type EventPolarity = "benefic" | "malefic" | "neutral";

export interface EventKaraka {
  id: EventTypeId;
  label: string;
  /** Short prompt shown when the user picks this type. */
  hint: string;
  timing: EventTiming;
  polarity: EventPolarity;
  /** Houses the classical texts read first for this event. */
  primaryHouses: number[];
  /** Supporting houses — real but weaker evidence. */
  secondaryHouses: number[];
  /** Natural significators (naisargika karaka). */
  karakas: PlanetName[];
  /** The divisional chart the texts send you to. */
  varga: Varga;
  /** The varga classically wanted, when this engine does not compute it. */
  vargaWanted?: string;
  source: string;
  /** Paraphrased classical basis — never a verbatim translation. */
  basis: string;
}

const BPHS = "Brihat Parashara Hora Shastra";
const PHALADEEPIKA = "Phaladeepika";
const UTTARA = "Uttara Kalamrita";
const SARAVALI = "Saravali";
const JAIMINI = "Jaimini Sutras";

export const EVENT_KARAKAS: EventKaraka[] = [
  {
    id: "marriage",
    label: "Marriage",
    hint: "The wedding date, or the start of a long partnership.",
    timing: "change",
    polarity: "benefic",
    primaryHouses: [7],
    secondaryHouses: [2, 11],
    // Venus is the karaka of marriage for everyone; the texts add Jupiter as
    // the husband-karaka in a woman's chart. Gender is not collected, so both
    // are carried and the distinction is left to the reading.
    karakas: ["Venus", "Jupiter"],
    varga: "D9",
    source: BPHS,
    basis:
      "The 7th bhava rules the spouse and marriage; Venus is its natural significator. " +
      "The Navamsa (D9) is examined for the marriage and the partner, and the dasha of " +
      "the 7th lord or of a graha placed in or aspecting the 7th brings the event.",
  },
  {
    id: "childbirth",
    label: "Birth of a child",
    hint: "The date a child was born.",
    timing: "change",
    polarity: "benefic",
    primaryHouses: [5],
    secondaryHouses: [2, 9, 11],
    karakas: ["Jupiter"],
    varga: "D7",
    source: BPHS,
    basis:
      "The 5th bhava rules progeny and Jupiter is the karaka of children. The Saptamsa (D7) " +
      "is the divisional chart of offspring; the dasha of the 5th lord or of Jupiter, with " +
      "Jupiter's transit supporting the 5th, is read for childbirth.",
  },
  {
    id: "job_start",
    label: "New job",
    hint: "Starting a job or a new role with an employer.",
    timing: "change",
    polarity: "benefic",
    primaryHouses: [10, 6],
    secondaryHouses: [2, 11],
    karakas: ["Saturn", "Sun", "Mercury"],
    varga: "D10",
    source: PHALADEEPIKA,
    basis:
      "The 10th bhava rules profession and status; the 6th rules service and employment. " +
      "The Dasamsa (D10) is read for career. Saturn signifies service and labour, the Sun " +
      "authority and position.",
  },
  {
    id: "promotion",
    label: "Promotion or recognition",
    hint: "A rise in position, title, award or public standing.",
    timing: "change",
    polarity: "benefic",
    primaryHouses: [10],
    secondaryHouses: [11, 1, 9],
    karakas: ["Sun", "Jupiter"],
    varga: "D10",
    source: PHALADEEPIKA,
    basis:
      "Advancement in the 10th bhava comes in the dasha of its lord or of a graha that " +
      "strengthens it; the 11th gives gains and the 9th fortune. The Sun is the karaka of " +
      "authority and honour.",
  },
  {
    id: "job_loss",
    label: "Job loss or setback",
    hint: "Redundancy, dismissal, a business failing, a career reversal.",
    timing: "change",
    polarity: "malefic",
    primaryHouses: [10, 8],
    secondaryHouses: [12, 6],
    karakas: ["Saturn", "Rahu"],
    varga: "D10",
    source: BPHS,
    basis:
      "Affliction to the 10th bhava or its lord, and the dashas of the 8th and 12th lords, " +
      "break the continuity of profession. Saturn brings delay and loss of position when it " +
      "afflicts rather than supports the 10th.",
  },
  {
    id: "business_start",
    label: "Started a business",
    hint: "Founding a company, going independent, a new venture.",
    timing: "change",
    polarity: "benefic",
    primaryHouses: [7, 10],
    secondaryHouses: [11, 3],
    karakas: ["Mercury", "Mars"],
    varga: "D10",
    source: UTTARA,
    basis:
      "The 7th bhava rules trade and partnership, the 10th one's own action in the world, " +
      "and the 3rd initiative and enterprise. Mercury is the karaka of commerce.",
  },
  {
    id: "education",
    label: "Education milestone",
    hint: "A degree, a major exam, admission to an institution.",
    timing: "change",
    polarity: "benefic",
    primaryHouses: [4, 5],
    secondaryHouses: [9, 2],
    karakas: ["Mercury", "Jupiter"],
    varga: "D24",
    source: BPHS,
    basis:
      "The 4th bhava rules formal schooling, the 5th intelligence and the fruit of study, " +
      "and the 9th higher learning. Mercury signifies the intellect and Jupiter wisdom and " +
      "the teacher. The Siddhamsa (D24) is the classical chart of learning.",
  },
  {
    id: "relocation",
    label: "Moved home or city",
    hint: "A change of residence within your own country.",
    timing: "change",
    polarity: "neutral",
    primaryHouses: [4, 3],
    secondaryHouses: [12, 9],
    karakas: ["Moon", "Mars"],
    varga: "D4",
    source: PHALADEEPIKA,
    basis:
      "The 4th bhava rules home and fixed property, the 3rd short journeys and movement. " +
      "Affliction or activation of the 4th by dasha or transit uproots the residence.",
  },
  {
    id: "foreign_travel",
    label: "Went abroad",
    hint: "Emigration, or a long stay in another country.",
    timing: "change",
    polarity: "neutral",
    primaryHouses: [12, 9],
    secondaryHouses: [3, 7],
    karakas: ["Rahu", "Moon"],
    varga: "D1",
    source: UTTARA,
    basis:
      "The 12th bhava rules distant lands and residence away from one's birthplace, the 9th " +
      "long journeys. Rahu signifies the foreign and the unfamiliar.",
  },
  {
    id: "property",
    label: "Bought property",
    hint: "A house, land or a flat.",
    timing: "change",
    polarity: "benefic",
    primaryHouses: [4],
    secondaryHouses: [2, 11, 12],
    karakas: ["Mars", "Venus"],
    varga: "D4",
    source: BPHS,
    basis:
      "The 4th bhava rules immovable property and Mars is the karaka of land. Acquisition " +
      "comes in the dasha of the 4th lord supported by the 2nd and 11th for the means.",
  },
  {
    id: "vehicle",
    label: "Bought a vehicle",
    hint: "A car, a motorcycle, a boat.",
    timing: "change",
    polarity: "benefic",
    primaryHouses: [4],
    secondaryHouses: [2, 11],
    karakas: ["Venus"],
    varga: "D16",
    source: PHALADEEPIKA,
    basis:
      "Conveyances are read from the 4th bhava with Venus as karaka; the Shodashamsa (D16) " +
      "is the divisional chart of vehicles and comforts.",
  },
  {
    id: "illness",
    label: "Serious illness",
    hint: "A significant diagnosis or a long illness.",
    timing: "onset",
    polarity: "malefic",
    primaryHouses: [6, 8],
    secondaryHouses: [12, 1],
    karakas: ["Saturn", "Mars"],
    varga: "D30",
    source: BPHS,
    basis:
      "The 6th bhava rules disease and the 8th chronic and grave conditions; the 1st is the " +
      "body itself. The Trimsamsa (D30) is read for misfortune and illness. Dashas of the " +
      "6th and 8th lords, and Saturn's affliction of the lagna, mark such periods.",
  },
  {
    id: "surgery",
    label: "Surgery or hospitalisation",
    hint: "An operation or a hospital admission.",
    timing: "change",
    polarity: "malefic",
    primaryHouses: [6, 8],
    secondaryHouses: [12, 1],
    karakas: ["Mars", "Saturn"],
    varga: "D30",
    source: SARAVALI,
    basis:
      "Mars, karaka of cutting instruments and of surgery, acting on the 6th or 8th bhava " +
      "or on the lagna, with the 12th indicating confinement and hospital.",
  },
  {
    id: "bereavement_father",
    label: "Loss of father",
    hint: "The date your father died.",
    timing: "change",
    polarity: "malefic",
    primaryHouses: [9, 4],
    secondaryHouses: [8, 12],
    karakas: ["Sun", "Saturn"],
    varga: "D1",
    source: BPHS,
    basis:
      "The 9th bhava is the father and the Sun his karaka; the 4th is the 8th from the 9th, " +
      "the house of the father's end. Saturn is the karaka of mortality.",
  },
  {
    id: "bereavement_mother",
    label: "Loss of mother",
    hint: "The date your mother died.",
    timing: "change",
    polarity: "malefic",
    primaryHouses: [4, 11],
    secondaryHouses: [8, 12],
    karakas: ["Moon", "Saturn"],
    varga: "D1",
    source: BPHS,
    basis:
      "The 4th bhava is the mother and the Moon her karaka; the 11th is the 8th from the " +
      "4th, the house of the mother's end.",
  },
  {
    id: "accident",
    label: "Accident or injury",
    hint: "A road accident, a fall, a serious injury.",
    timing: "change",
    polarity: "malefic",
    primaryHouses: [8, 6],
    secondaryHouses: [1, 4],
    karakas: ["Mars", "Rahu", "Saturn"],
    varga: "D1",
    source: PHALADEEPIKA,
    basis:
      "The 8th bhava rules sudden and violent events; Mars signifies wounds, fire and " +
      "weapons and Rahu the abrupt and unforeseen. The 4th is read for vehicular mishap.",
  },
  {
    id: "litigation",
    label: "Legal dispute",
    hint: "A court case, a formal dispute, a legal proceeding.",
    timing: "onset",
    polarity: "malefic",
    primaryHouses: [6],
    secondaryHouses: [8, 12, 7],
    karakas: ["Mars", "Saturn"],
    varga: "D1",
    source: UTTARA,
    basis:
      "The 6th bhava rules enemies, debt and litigation, the 7th the opposing party. " +
      "Malefic dashas connected with the 6th bring disputes to a head.",
  },
  {
    id: "financial_gain",
    label: "Major financial gain",
    hint: "An inheritance, a windfall, a large sale.",
    timing: "change",
    polarity: "benefic",
    primaryHouses: [11, 2],
    secondaryHouses: [5, 9],
    karakas: ["Jupiter", "Venus"],
    varga: "D2",
    source: BPHS,
    basis:
      "The 2nd bhava rules accumulated wealth and the 11th gains and income; the Hora (D2) " +
      "is read for prosperity. Jupiter is the karaka of wealth and the 8th can give " +
      "inheritance.",
  },
  {
    id: "financial_loss",
    label: "Major financial loss",
    hint: "A large loss, a debt, a failed investment.",
    timing: "change",
    polarity: "malefic",
    primaryHouses: [12, 8],
    secondaryHouses: [6, 2],
    karakas: ["Saturn", "Rahu", "Ketu"],
    varga: "D2",
    source: BPHS,
    basis:
      "The 12th bhava rules expenditure and loss and the 8th sudden reversals; affliction " +
      "of the 2nd lord withdraws accumulated wealth.",
  },
  {
    id: "spiritual",
    label: "Spiritual turning point",
    hint: "Initiation, a pilgrimage, a decisive change of belief or practice.",
    timing: "change",
    polarity: "neutral",
    primaryHouses: [9, 12],
    secondaryHouses: [5, 8],
    karakas: ["Jupiter", "Ketu"],
    varga: "D1",
    source: JAIMINI,
    basis:
      "The 9th bhava rules dharma and the guru, the 12th renunciation and moksha, and the " +
      "8th the occult. Ketu is the karaka of detachment and liberation.",
  },
];

export const EVENT_KARAKA_BY_ID: Record<EventTypeId, EventKaraka> =
  Object.fromEntries(EVENT_KARAKAS.map((e) => [e.id, e])) as Record<EventTypeId, EventKaraka>;

/** How precisely the user remembers the date. Widens the scoring window. */
export type DatePrecision = "exact" | "month" | "year" | "approx";

/** Half-width of the window, in days, implied by each precision. */
export const PRECISION_WINDOW_DAYS: Record<DatePrecision, number> = {
  exact: 15,
  month: 30,
  year: 183,
  approx: 365,
};

export const PRECISION_LABEL: Record<DatePrecision, string> = {
  exact: "I know the date",
  month: "I know the month",
  year: "I know the year",
  approx: "Roughly / around an age",
};

/** The user's own certainty, which weights the event in the aggregate. */
export type EventConfidence = "sure" | "fairly" | "vague";

export const CONFIDENCE_WEIGHT: Record<EventConfidence, number> = {
  sure: 1,
  fairly: 0.7,
  vague: 0.4,
};
