// Documented life events for a handful of the sample charts, so the event
// analysis and birth-time search can be tried on real historical facts rather
// than on something invented.
//
// WHAT THIS IS FOR, and what it is NOT for.
//
// Every celebrity in celebrities.ts carries `timeKnown: false` and a 12:00
// placeholder — the birth times are not known. Reading these events against
// that chart therefore proves nothing: measured on one entry, moving the
// placeholder across the day gives four different Lagnas, a first Mahadasha
// ending anywhere between 1952 and 1960, and either Jupiter or Saturn running
// in 2000. So these events are a demonstration of BIRTH-TIME RECTIFICATION,
// which takes events and produces a time, and not a verification of the event
// readings, which would need a time nobody has.
//
// SOURCING. Every date below was read from the cited Wikipedia article rather
// than recalled, and each row records the precision the article actually gave.
// Dates are facts and not copyrightable; Wikipedia text is CC BY-SA and none is
// reproduced here. Where an article gave only a year or a month, the row says
// so and the date is placed mid-period, which is the choice that minimises the
// worst-case error:
//
//   precision "year"  -> 1 July of that year   (max error ~6 months)
//   precision "month" -> the 15th              (max error ~15 days)
//
// That matters: measured, birth-time error runs at roughly a third of the date
// error, so a subject whose events are mostly year-precision cannot be resolved
// better than about an hour. The search says as much when it runs.

import { EventTypeId, DatePrecision } from "../astro/eventKaraka";

export interface CelebrityEvent {
  type: EventTypeId;
  /** ISO yyyy-mm-dd. Mid-period when the source gave only a year or month. */
  date: string;
  precision: DatePrecision;
  /** What actually happened, for the reader — never used in scoring. */
  what: string;
}

export interface CelebrityEventSet {
  /** Matches Celebrity.name in celebrities.ts. */
  name: string;
  /** Guards against a user's own profile coincidentally sharing a name. */
  year: number;
  month: number;
  day: number;
  source: string;
  events: CelebrityEvent[];
}

const wiki = (slug: string) => `https://en.wikipedia.org/wiki/${slug}`;

export const CELEBRITY_EVENTS: CelebrityEventSet[] = [
  {
    name: "Rajinikanth",
    year: 1950, month: 12, day: 12,
    source: wiki("Rajinikanth"),
    events: [
      { type: "job_start", date: "1975-07-01", precision: "year", what: "Film debut in Apoorva Raagangal" },
      { type: "marriage", date: "1981-02-26", precision: "exact", what: "Married Latha Rangachari" },
      { type: "promotion", date: "2000-07-01", precision: "year", what: "Awarded the Padma Bhushan" },
      { type: "illness", date: "2011-04-29", precision: "exact", what: "Onset of the illness that led to a long hospitalisation" },
      { type: "surgery", date: "2011-05-05", precision: "exact", what: "Admitted to hospital with bronchitis" },
      { type: "promotion", date: "2016-07-01", precision: "year", what: "Awarded the Padma Vibhushan" },
      { type: "business_start", date: "2017-12-31", precision: "exact", what: "Announced his entry into politics" },
    ],
  },
  {
    name: "Kamal Haasan",
    year: 1954, month: 11, day: 7,
    source: wiki("Kamal_Haasan"),
    events: [
      { type: "promotion", date: "1960-07-01", precision: "year", what: "Rashtrapati Award as a child actor for Kalathur Kannamma" },
      { type: "marriage", date: "1978-07-01", precision: "year", what: "Married Vani Ganapathy" },
      { type: "childbirth", date: "1986-07-01", precision: "year", what: "Birth of daughter Shruti" },
      { type: "marriage", date: "1988-07-01", precision: "year", what: "Married Sarika" },
      { type: "promotion", date: "1990-07-01", precision: "year", what: "Conferred the Padma Shri" },
      { type: "childbirth", date: "1991-07-01", precision: "year", what: "Birth of daughter Akshara" },
      { type: "business_start", date: "2018-02-21", precision: "exact", what: "Formally launched his political party" },
    ],
  },
  {
    name: "Amitabh Bachchan",
    year: 1942, month: 10, day: 11,
    source: wiki("Amitabh_Bachchan"),
    events: [
      { type: "job_start", date: "1969-07-01", precision: "year", what: "Film debut, as a voice narrator in Bhuvan Shome" },
      { type: "marriage", date: "1973-07-01", precision: "year", what: "Married Jaya Bhaduri" },
      { type: "accident", date: "1982-07-26", precision: "exact", what: "Near-fatal injury while filming Coolie" },
      { type: "illness", date: "1984-07-01", precision: "year", what: "Diagnosed with myasthenia gravis" },
      { type: "promotion", date: "1984-12-31", precision: "exact", what: "Took his seat in the Lok Sabha" },
      { type: "financial_loss", date: "1997-07-01", precision: "year", what: "Collapse of his company ABCL" },
      { type: "bereavement_father", date: "2003-07-01", precision: "year", what: "Death of his father, Harivansh Rai Bachchan" },
      { type: "bereavement_mother", date: "2007-07-01", precision: "year", what: "Death of his mother, Teji Bachchan" },
    ],
  },
  {
    name: "Jawaharlal Nehru",
    year: 1889, month: 11, day: 14,
    source: wiki("Jawaharlal_Nehru"),
    events: [
      { type: "education", date: "1912-07-01", precision: "year", what: "Called to the bar" },
      { type: "marriage", date: "1916-07-01", precision: "year", what: "Married Kamala Kaul" },
      { type: "childbirth", date: "1917-07-01", precision: "year", what: "Birth of his daughter Indira" },
      { type: "litigation", date: "1921-12-06", precision: "exact", what: "First arrest and imprisonment" },
      { type: "bereavement_father", date: "1931-02-06", precision: "exact", what: "Death of his father, Motilal Nehru" },
      { type: "bereavement_mother", date: "1938-01-15", precision: "month", what: "Death of his mother, Swarup Rani" },
      { type: "promotion", date: "1947-08-15", precision: "exact", what: "Became Prime Minister of India" },
    ],
  },
  {
    name: "Indira Gandhi",
    year: 1917, month: 11, day: 19,
    source: wiki("Indira_Gandhi"),
    events: [
      { type: "marriage", date: "1942-03-15", precision: "month", what: "Married Feroze Gandhi at Allahabad" },
      { type: "litigation", date: "1942-09-15", precision: "month", what: "Arrested during the Quit India movement" },
      { type: "childbirth", date: "1944-07-01", precision: "year", what: "Birth of her son Rajiv" },
      { type: "childbirth", date: "1946-07-01", precision: "year", what: "Birth of her son Sanjay" },
      { type: "bereavement_father", date: "1964-07-01", precision: "year", what: "Death of her father, Jawaharlal Nehru" },
      { type: "promotion", date: "1966-01-24", precision: "exact", what: "Became Prime Minister of India" },
      { type: "litigation", date: "1978-07-01", precision: "year", what: "Arrested and expelled from Parliament" },
    ],
  },
  {
    name: "Barack Obama",
    year: 1961, month: 8, day: 4,
    source: wiki("Barack_Obama"),
    events: [
      { type: "bereavement_father", date: "1982-07-01", precision: "year", what: "Death of his father in a road accident" },
      { type: "education", date: "1991-07-01", precision: "year", what: "Graduated from Harvard Law School" },
      { type: "marriage", date: "1992-10-03", precision: "exact", what: "Married Michelle Robinson" },
      { type: "bereavement_mother", date: "1995-07-01", precision: "year", what: "Death of his mother, Ann Dunham" },
      { type: "promotion", date: "1996-07-01", precision: "year", what: "Elected to the Illinois Senate" },
      { type: "childbirth", date: "1998-07-01", precision: "year", what: "Birth of his daughter Malia" },
      { type: "childbirth", date: "2001-07-01", precision: "year", what: "Birth of his daughter Sasha" },
      { type: "promotion", date: "2009-01-20", precision: "exact", what: "Inaugurated as President of the United States" },
    ],
  },
  {
    name: "Abraham Lincoln",
    year: 1809, month: 2, day: 12,
    source: wiki("Abraham_Lincoln"),
    events: [
      { type: "bereavement_mother", date: "1818-10-05", precision: "exact", what: "Death of his mother, Nancy Hanks Lincoln" },
      { type: "marriage", date: "1842-11-04", precision: "exact", what: "Married Mary Todd" },
      { type: "childbirth", date: "1843-07-01", precision: "year", what: "Birth of his son Robert" },
      { type: "childbirth", date: "1846-07-01", precision: "year", what: "Birth of his son Edward" },
      { type: "promotion", date: "1846-07-01", precision: "year", what: "Elected to the US House of Representatives" },
      { type: "childbirth", date: "1850-12-21", precision: "exact", what: "Birth of his son William" },
      { type: "promotion", date: "1861-03-04", precision: "exact", what: "Inaugurated as President of the United States" },
    ],
  },
  {
    name: "John F. Kennedy",
    year: 1917, month: 5, day: 29,
    source: wiki("John_F._Kennedy"),
    events: [
      { type: "surgery", date: "1931-04-15", precision: "month", what: "Appendectomy, after which he left Canterbury School" },
      { type: "illness", date: "1944-05-15", precision: "month", what: "Admitted for treatment of his back injury" },
      { type: "promotion", date: "1947-01-03", precision: "exact", what: "Took his seat in the US House of Representatives" },
      { type: "marriage", date: "1953-09-12", precision: "exact", what: "Married Jacqueline Bouvier" },
      { type: "surgery", date: "1954-07-01", precision: "year", what: "First of several spinal operations" },
      { type: "promotion", date: "1961-01-20", precision: "exact", what: "Inaugurated as President of the United States" },
    ],
  },
];

export const CELEBRITY_EVENTS_BY_NAME: Record<string, CelebrityEventSet> =
  Object.fromEntries(CELEBRITY_EVENTS.map((s) => [s.name, s]));

/**
 * The documented events for a loaded chart, if it is one of the sample charts.
 *
 * Matched on name AND birth date, so a user who happens to name their own
 * profile "Indira Gandhi" does not silently inherit someone else's life.
 */
export function celebrityEventsFor(birth: {
  name: string; year: number; month: number; day: number;
}): CelebrityEventSet | null {
  const set = CELEBRITY_EVENTS_BY_NAME[birth.name?.trim()];
  if (!set) return null;
  const matches = set.year === birth.year && set.month === birth.month && set.day === birth.day;
  return matches ? set : null;
}
