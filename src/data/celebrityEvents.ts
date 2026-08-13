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
//
// COVERAGE is uneven, and deliberately so. Politicians and historical figures
// have densely dated public lives; modern film actors often do not, and their
// articles frequently omit marriage dates and children's birthdays entirely.
// Where an article gave little, the set is small — Vishal Bhardwaj has four
// events and Vijay five. Padding those out would have meant inventing dates,
// which is the one thing this file exists to avoid.

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
  {
    name: "M. G. Ramachandran",
    year: 1917, month: 1, day: 17,
    source: wiki("M._G._Ramachandran"),
    events: [
      { type: "job_start", date: "1936-07-01", precision: "year", what: "Film debut" },
      { type: "marriage", date: "1939-07-01", precision: "year", what: "First marriage" },
      { type: "business_start", date: "1953-07-01", precision: "year", what: "Joined the DMK" },
      { type: "marriage", date: "1963-07-01", precision: "year", what: "Married Janaki" },
      { type: "accident", date: "1967-01-12", precision: "exact", what: "Shot and wounded by a fellow actor" },
      { type: "business_start", date: "1972-10-17", precision: "exact", what: "Founded the AIADMK" },
      { type: "promotion", date: "1977-06-30", precision: "exact", what: "Became Chief Minister of Tamil Nadu" },
      { type: "illness", date: "1984-10-15", precision: "month", what: "Diagnosed with renal failure" },
      { type: "surgery", date: "1984-12-19", precision: "exact", what: "Kidney transplant" },
    ],
  },
  {
    name: "N. T. Rama Rao",
    year: 1923, month: 5, day: 28,
    source: wiki("N._T._Rama_Rao"),
    events: [
      { type: "marriage", date: "1942-05-15", precision: "month", what: "Married Basava Rama Tarakam" },
      { type: "job_start", date: "1949-07-01", precision: "year", what: "Film debut in Mana Desam" },
      { type: "business_start", date: "1982-03-29", precision: "exact", what: "Founded the Telugu Desam Party" },
      { type: "promotion", date: "1983-01-09", precision: "exact", what: "Sworn in as Chief Minister" },
      { type: "job_loss", date: "1984-08-15", precision: "month", what: "Dismissed from office" },
      { type: "promotion", date: "1984-09-16", precision: "exact", what: "Returned as Chief Minister" },
      { type: "bereavement_mother", date: "1985-07-01", precision: "year", what: "Death of his wife Basava Rama Tarakam" },
      { type: "job_loss", date: "1989-12-15", precision: "month", what: "Voted out of power" },
      { type: "promotion", date: "1994-12-12", precision: "exact", what: "Sworn in for a fourth term" },
      { type: "job_loss", date: "1995-09-01", precision: "exact", what: "Resigned as Chief Minister" },
    ],
  },
  {
    name: "J. Jayalalithaa",
    year: 1948, month: 2, day: 24,
    source: wiki("J._Jayalalithaa"),
    events: [
      { type: "job_start", date: "1964-07-01", precision: "year", what: "Film debut in Kannada" },
      { type: "bereavement_mother", date: "1971-11-15", precision: "month", what: "Death of her mother, Sandhya" },
      { type: "business_start", date: "1982-06-04", precision: "exact", what: "Joined the AIADMK" },
      { type: "promotion", date: "1991-06-24", precision: "exact", what: "Became Chief Minister of Tamil Nadu" },
      { type: "litigation", date: "2014-07-01", precision: "year", what: "Convicted in the disproportionate assets case" },
      { type: "illness", date: "2016-09-15", precision: "month", what: "Hospitalised with the illness that proved fatal" },
    ],
  },
  {
    name: "M. Karunanidhi",
    year: 1924, month: 6, day: 3,
    source: wiki("M._Karunanidhi"),
    events: [
      { type: "marriage", date: "1944-07-01", precision: "year", what: "Married Padmavathi Ammal" },
      { type: "marriage", date: "1948-07-01", precision: "year", what: "Married Dayalu Ammal" },
      { type: "promotion", date: "1957-04-01", precision: "exact", what: "Entered the Madras state legislature" },
      { type: "litigation", date: "1965-02-16", precision: "exact", what: "Arrested during the anti-Hindi agitations" },
      { type: "promotion", date: "1969-02-10", precision: "exact", what: "Appointed Chief Minister" },
      { type: "promotion", date: "1969-07-27", precision: "exact", what: "Chosen as leader of the DMK" },
      { type: "litigation", date: "2001-06-30", precision: "exact", what: "Arrested over the flyover case" },
    ],
  },
  {
    name: "C. N. Annadurai",
    year: 1909, month: 9, day: 15,
    source: wiki("C._N._Annadurai"),
    events: [
      { type: "marriage", date: "1930-07-01", precision: "year", what: "Married Rani" },
      { type: "business_start", date: "1949-09-17", precision: "exact", what: "Launched the DMK" },
      { type: "promotion", date: "1957-04-01", precision: "exact", what: "Elected to the Madras Legislative Assembly" },
      { type: "litigation", date: "1965-07-01", precision: "year", what: "Arrested during the anti-Hindi agitations" },
      { type: "promotion", date: "1967-03-06", precision: "exact", what: "Became Chief Minister of Madras State" },
      { type: "surgery", date: "1968-09-10", precision: "exact", what: "Travelled to New York for cancer surgery" },
    ],
  },
  {
    name: "Chiranjeevi",
    year: 1955, month: 8, day: 22,
    source: wiki("Chiranjeevi"),
    events: [
      { type: "job_start", date: "1978-07-01", precision: "year", what: "First released film, Pranam Khareedu" },
      { type: "marriage", date: "1980-02-20", precision: "exact", what: "Married Surekha" },
      { type: "promotion", date: "2006-03-29", precision: "exact", what: "Received the Padma Bhushan" },
      { type: "business_start", date: "2008-08-15", precision: "month", what: "Launched the Praja Rajyam Party" },
      { type: "promotion", date: "2012-10-28", precision: "exact", what: "Sworn in as a Union Minister of State" },
      { type: "promotion", date: "2024-05-09", precision: "exact", what: "Received the Padma Vibhushan" },
    ],
  },
  {
    name: "Mohanlal",
    year: 1960, month: 5, day: 21,
    source: wiki("Mohanlal"),
    events: [
      { type: "job_start", date: "1980-07-01", precision: "year", what: "Screen debut in Manjil Virinja Pookkal" },
      { type: "marriage", date: "1988-07-01", precision: "year", what: "Married Suchitra" },
      { type: "promotion", date: "1989-07-01", precision: "year", what: "First National Film Award recognition" },
      { type: "promotion", date: "2001-07-01", precision: "year", what: "Awarded the Padma Shri" },
      { type: "promotion", date: "2009-07-01", precision: "year", what: "Given the honorary rank of Lieutenant Colonel" },
      { type: "promotion", date: "2019-07-01", precision: "year", what: "Awarded the Padma Bhushan" },
    ],
  },
  {
    name: "Mammootty",
    year: 1951, month: 9, day: 7,
    source: wiki("Mammootty"),
    events: [
      { type: "job_start", date: "1971-07-01", precision: "year", what: "First film appearance, as an extra" },
      { type: "marriage", date: "1979-07-01", precision: "year", what: "Married Sulfath" },
      { type: "job_start", date: "1981-07-01", precision: "year", what: "First leading role, in Thrishna" },
      { type: "childbirth", date: "1982-07-01", precision: "year", what: "Birth of his daughter Surumi" },
      { type: "childbirth", date: "1983-07-01", precision: "year", what: "Birth of his son Dulquer" },
      { type: "promotion", date: "1990-07-01", precision: "year", what: "First National Film Award for Best Actor" },
      { type: "promotion", date: "1998-07-01", precision: "year", what: "Awarded the Padma Shri" },
    ],
  },
  {
    name: "N. Chandrababu Naidu",
    year: 1950, month: 4, day: 20,
    source: wiki("N._Chandrababu_Naidu"),
    events: [
      { type: "promotion", date: "1978-07-01", precision: "year", what: "First elected as an MLA" },
      { type: "marriage", date: "1981-09-15", precision: "month", what: "Married Bhuvaneswari" },
      { type: "promotion", date: "1995-09-01", precision: "exact", what: "Sworn in as Chief Minister" },
      { type: "accident", date: "2003-10-01", precision: "exact", what: "Survived a landmine blast at Alipiri" },
      { type: "promotion", date: "2014-06-08", precision: "exact", what: "Chief Minister of the bifurcated Andhra Pradesh" },
      { type: "litigation", date: "2023-09-09", precision: "exact", what: "Arrested by the state Crime Investigation Department" },
      { type: "promotion", date: "2024-06-12", precision: "exact", what: "Sworn in as Chief Minister for a fourth term" },
    ],
  },
  {
    name: "K. Chandrashekar Rao",
    year: 1954, month: 2, day: 17,
    source: wiki("K._Chandrashekar_Rao"),
    events: [
      { type: "marriage", date: "1969-07-01", precision: "year", what: "Married Shobha" },
      { type: "promotion", date: "1985-03-10", precision: "exact", what: "First elected to the Andhra Pradesh assembly" },
      { type: "business_start", date: "2001-04-27", precision: "exact", what: "Founded the Telangana Rashtra Samithi" },
      { type: "illness", date: "2009-11-15", precision: "month", what: "Eleven-day hunger strike for Telangana" },
      { type: "promotion", date: "2014-06-02", precision: "exact", what: "Became the first Chief Minister of Telangana" },
      { type: "job_loss", date: "2023-12-07", precision: "exact", what: "Lost office as Chief Minister" },
      { type: "accident", date: "2023-12-15", precision: "month", what: "Fractured his hip" },
    ],
  },
  {
    name: "Y. S. Rajasekhara Reddy",
    year: 1949, month: 7, day: 8,
    source: wiki("Y._S._Rajasekhara_Reddy"),
    events: [
      { type: "marriage", date: "1971-07-01", precision: "year", what: "Married Y. S. Vijayamma" },
      { type: "promotion", date: "1978-03-05", precision: "exact", what: "First elected to the Andhra Pradesh assembly" },
      { type: "foreign_travel", date: "2003-07-01", precision: "year", what: "Padayatra of 1,500 km across eleven districts" },
      { type: "promotion", date: "2004-05-14", precision: "exact", what: "Became Chief Minister of Andhra Pradesh" },
      { type: "promotion", date: "2009-05-20", precision: "exact", what: "Sworn in for a second term" },
    ],
  },
  {
    name: "H. D. Deve Gowda",
    year: 1933, month: 5, day: 18,
    source: wiki("H._D._Deve_Gowda"),
    events: [
      { type: "marriage", date: "1954-07-01", precision: "year", what: "Married Chennamma" },
      { type: "promotion", date: "1962-07-01", precision: "year", what: "First elected to the Karnataka assembly" },
      { type: "litigation", date: "1976-07-01", precision: "year", what: "Imprisoned during the Emergency" },
      { type: "promotion", date: "1994-12-11", precision: "exact", what: "Became Chief Minister of Karnataka" },
      { type: "promotion", date: "1996-06-01", precision: "exact", what: "Became Prime Minister of India" },
      { type: "job_loss", date: "1997-04-21", precision: "exact", what: "Left the office of Prime Minister" },
    ],
  },
  {
    name: "Pinarayi Vijayan",
    year: 1945, month: 5, day: 24,
    source: wiki("Pinarayi_Vijayan"),
    events: [
      { type: "promotion", date: "1970-07-01", precision: "year", what: "Elected to the Kerala assembly at 25" },
      { type: "litigation", date: "1975-07-01", precision: "year", what: "Imprisoned during the Emergency" },
      { type: "marriage", date: "1979-07-01", precision: "year", what: "Married T. Kamala" },
      { type: "promotion", date: "1998-09-25", precision: "exact", what: "Became CPI(M) state secretary" },
      { type: "promotion", date: "2016-05-25", precision: "exact", what: "Sworn in as Chief Minister of Kerala" },
      { type: "promotion", date: "2021-05-20", precision: "exact", what: "Sworn in for a second term" },
    ],
  },
  {
    name: "Shah Rukh Khan",
    year: 1965, month: 11, day: 2,
    source: wiki("Shah_Rukh_Khan"),
    events: [
      { type: "bereavement_father", date: "1981-07-01", precision: "year", what: "Death of his father" },
      { type: "job_start", date: "1989-07-01", precision: "year", what: "Television debut in Fauji" },
      { type: "marriage", date: "1991-07-01", precision: "year", what: "Married Gauri Chhibber" },
      { type: "bereavement_mother", date: "1991-07-01", precision: "year", what: "Death of his mother" },
      { type: "job_start", date: "1992-06-15", precision: "month", what: "Film debut in Deewana" },
      { type: "promotion", date: "1993-07-01", precision: "year", what: "First Filmfare Best Actor award, for Baazigar" },
      { type: "accident", date: "2001-12-15", precision: "month", what: "Spinal injury during filming" },
      { type: "surgery", date: "2003-02-15", precision: "month", what: "Cervical surgery in London" },
      { type: "promotion", date: "2005-07-01", precision: "year", what: "Awarded the Padma Shri" },
    ],
  },
  {
    name: "Atal Bihari Vajpayee",
    year: 1924, month: 12, day: 25,
    source: wiki("Atal_Bihari_Vajpayee"),
    events: [
      { type: "promotion", date: "1957-07-01", precision: "year", what: "First elected to the Lok Sabha, from Balrampur" },
      { type: "litigation", date: "1975-07-01", precision: "year", what: "Arrested during the Emergency" },
      { type: "promotion", date: "1977-03-26", precision: "exact", what: "Became Minister of External Affairs" },
      { type: "business_start", date: "1980-07-01", precision: "year", what: "Became the first president of the BJP" },
      { type: "promotion", date: "1996-05-16", precision: "exact", what: "Became Prime Minister of India" },
      { type: "job_loss", date: "1996-06-01", precision: "exact", what: "Resigned after sixteen days" },
      { type: "promotion", date: "1999-10-13", precision: "exact", what: "Began a full term as Prime Minister" },
    ],
  },
  {
    name: "Ronald Reagan",
    year: 1911, month: 2, day: 6,
    source: wiki("Ronald_Reagan"),
    events: [
      { type: "marriage", date: "1940-01-15", precision: "month", what: "Married Jane Wyman" },
      { type: "childbirth", date: "1941-07-01", precision: "year", what: "Birth of his daughter Maureen" },
      { type: "marriage", date: "1952-03-15", precision: "month", what: "Married Nancy Davis" },
      { type: "childbirth", date: "1952-10-15", precision: "month", what: "Birth of his daughter Patti" },
      { type: "childbirth", date: "1958-05-15", precision: "month", what: "Birth of his son Ron" },
      { type: "promotion", date: "1967-01-02", precision: "exact", what: "Inaugurated as Governor of California" },
      { type: "promotion", date: "1981-01-20", precision: "exact", what: "Inaugurated as President of the United States" },
      { type: "accident", date: "1981-03-30", precision: "exact", what: "Wounded in an assassination attempt" },
      { type: "illness", date: "1994-07-01", precision: "year", what: "Diagnosed with Alzheimer's disease" },
    ],
  },
  {
    name: "Franklin D. Roosevelt",
    year: 1882, month: 1, day: 30,
    source: wiki("Franklin_D._Roosevelt"),
    events: [
      { type: "bereavement_father", date: "1900-07-01", precision: "year", what: "Death of his father" },
      { type: "marriage", date: "1905-03-17", precision: "exact", what: "Married Eleanor Roosevelt" },
      { type: "childbirth", date: "1906-07-01", precision: "year", what: "Birth of his daughter Anna" },
      { type: "childbirth", date: "1910-07-01", precision: "year", what: "Birth of his son Elliott" },
      { type: "childbirth", date: "1916-07-01", precision: "year", what: "Birth of his son John" },
      { type: "illness", date: "1921-08-15", precision: "month", what: "Fell ill and was diagnosed with polio" },
      { type: "promotion", date: "1928-07-01", precision: "year", what: "Elected Governor of New York" },
      { type: "promotion", date: "1933-03-04", precision: "exact", what: "First inauguration as President" },
    ],
  },
  {
    name: "Steven Spielberg",
    year: 1946, month: 12, day: 18,
    source: wiki("Steven_Spielberg"),
    events: [
      { type: "relocation", date: "1957-07-01", precision: "year", what: "Family moved to Phoenix, Arizona" },
      { type: "job_start", date: "1968-07-01", precision: "year", what: "Signed a seven-year contract with Universal" },
      { type: "promotion", date: "1975-07-01", precision: "year", what: "Jaws released, making his name" },
      { type: "promotion", date: "1982-07-01", precision: "year", what: "E.T. released" },
      { type: "childbirth", date: "1993-07-01", precision: "year", what: "Birth of his son Max" },
      { type: "promotion", date: "1993-07-01", precision: "year", what: "First Academy Award for Best Director" },
    ],
  },
  {
    name: "Clint Eastwood",
    year: 1930, month: 5, day: 31,
    source: wiki("Clint_Eastwood"),
    events: [
      { type: "marriage", date: "1953-07-01", precision: "year", what: "Married Maggie Johnson" },
      { type: "job_start", date: "1954-04-15", precision: "month", what: "Signed his first studio contract" },
      { type: "promotion", date: "1964-07-01", precision: "year", what: "A Fistful of Dollars" },
      { type: "bereavement_father", date: "1970-07-01", precision: "year", what: "Death of his father" },
      { type: "job_start", date: "1971-07-01", precision: "year", what: "Directorial debut, Play Misty for Me" },
      { type: "promotion", date: "1986-04-08", precision: "exact", what: "Became Mayor of Carmel-by-the-Sea" },
      { type: "promotion", date: "1992-07-01", precision: "year", what: "Academy Awards for Unforgiven" },
      { type: "bereavement_mother", date: "2006-07-01", precision: "year", what: "Death of his mother" },
    ],
  },
  {
    name: "Meryl Streep",
    year: 1949, month: 6, day: 22,
    source: wiki("Meryl_Streep"),
    events: [
      { type: "education", date: "1971-07-01", precision: "year", what: "Graduated from Vassar College" },
      { type: "education", date: "1975-07-01", precision: "year", what: "MFA from the Yale School of Drama" },
      { type: "marriage", date: "1978-07-01", precision: "year", what: "Married Don Gummer" },
      { type: "promotion", date: "1979-07-01", precision: "year", what: "First Academy Award, for Kramer vs. Kramer" },
      { type: "promotion", date: "1982-07-01", precision: "year", what: "Academy Award for Sophie's Choice" },
      { type: "promotion", date: "2011-07-01", precision: "year", what: "Academy Award for The Iron Lady" },
    ],
  },
  {
    name: "Martin Scorsese",
    year: 1942, month: 11, day: 17,
    source: wiki("Martin_Scorsese"),
    events: [
      { type: "education", date: "1964-07-01", precision: "year", what: "BA from New York University" },
      { type: "marriage", date: "1965-07-01", precision: "year", what: "Married Laraine Brennan" },
      { type: "job_start", date: "1967-07-01", precision: "year", what: "Directorial debut" },
      { type: "promotion", date: "1973-07-01", precision: "year", what: "Mean Streets, his breakthrough" },
      { type: "marriage", date: "1979-07-01", precision: "year", what: "Married Isabella Rossellini" },
      { type: "marriage", date: "1999-07-01", precision: "year", what: "Married Helen Morris" },
      { type: "promotion", date: "2006-07-01", precision: "year", what: "Academy Award for Best Director, The Departed" },
    ],
  },
  {
    name: "Tom Hanks",
    year: 1956, month: 7, day: 9,
    source: wiki("Tom_Hanks"),
    events: [
      { type: "marriage", date: "1978-07-01", precision: "year", what: "Married Samantha Lewes" },
      { type: "promotion", date: "1984-07-01", precision: "year", what: "Splash, his breakthrough film" },
      { type: "marriage", date: "1988-07-01", precision: "year", what: "Married Rita Wilson" },
      { type: "promotion", date: "1994-07-01", precision: "year", what: "Academy Award for Best Actor, Philadelphia" },
      { type: "promotion", date: "1995-07-01", precision: "year", what: "Academy Award for Best Actor, Forrest Gump" },
      { type: "illness", date: "2020-04-11", precision: "exact", what: "First appearance after his COVID-19 diagnosis" },
    ],
  },
  {
    name: "Pawan Kalyan",
    year: 1971, month: 9, day: 2,
    source: wiki("Pawan_Kalyan"),
    events: [
      { type: "job_start", date: "1996-10-15", precision: "month", what: "Acting debut" },
      { type: "marriage", date: "1997-05-15", precision: "month", what: "Married Nandini" },
      { type: "marriage", date: "2009-01-15", precision: "month", what: "Married Renu Desai" },
      { type: "marriage", date: "2013-09-15", precision: "month", what: "Married Anna Lezhneva" },
      { type: "business_start", date: "2014-03-14", precision: "exact", what: "Founded the Jana Sena Party" },
      { type: "promotion", date: "2024-06-04", precision: "exact", what: "Elected to the Andhra Pradesh assembly" },
      { type: "promotion", date: "2024-06-14", precision: "exact", what: "Announced as Deputy Chief Minister" },
    ],
  },
  {
    name: "Vijay",
    year: 1974, month: 6, day: 22,
    source: wiki("C._Joseph_Vijay"),
    events: [
      { type: "job_start", date: "1984-07-01", precision: "year", what: "Debut as a child actor in Vetri" },
      { type: "job_start", date: "1992-07-01", precision: "year", what: "First leading role, in Naalaiya Theerpu" },
      { type: "marriage", date: "1999-08-25", precision: "exact", what: "Married Sangeetha Sornalingam" },
      { type: "business_start", date: "2024-02-02", precision: "exact", what: "Launched his political party" },
      { type: "promotion", date: "2026-05-10", precision: "exact", what: "Sworn in as Chief Minister of Tamil Nadu" },
    ],
  },
  {
    name: "Dr. Rajkumar",
    year: 1929, month: 4, day: 24,
    source: wiki("Dr._Rajkumar"),
    events: [
      { type: "marriage", date: "1953-06-25", precision: "exact", what: "Married Parvathamma at Nanjangud" },
      { type: "job_start", date: "1954-07-01", precision: "year", what: "First leading role, in Bedara Kannappa" },
      { type: "promotion", date: "1983-07-01", precision: "year", what: "Conferred the Padma Bhushan" },
      { type: "promotion", date: "1992-07-01", precision: "year", what: "National Film Award for playback singing" },
      { type: "promotion", date: "1995-07-01", precision: "year", what: "Dadasaheb Phalke Award" },
      { type: "accident", date: "2000-07-30", precision: "exact", what: "Abducted by Veerappan from his farmhouse" },
      { type: "foreign_travel", date: "2000-11-15", precision: "exact", what: "Released after 108 days in captivity" },
    ],
  },
  {
    name: "B. S. Yediyurappa",
    year: 1943, month: 2, day: 27,
    source: wiki("B._S._Yediyurappa"),
    events: [
      { type: "marriage", date: "1967-07-01", precision: "year", what: "Married Mythradevi" },
      { type: "promotion", date: "1972-07-01", precision: "year", what: "Elected to Shikaripura town municipality" },
      { type: "promotion", date: "1983-07-01", precision: "year", what: "First elected to the Karnataka assembly" },
      { type: "bereavement_mother", date: "2004-07-01", precision: "year", what: "Death of his wife Mythradevi" },
      { type: "promotion", date: "2006-02-03", precision: "exact", what: "Sworn in as Deputy Chief Minister" },
      { type: "promotion", date: "2008-05-30", precision: "exact", what: "Became Chief Minister of Karnataka" },
      { type: "job_loss", date: "2011-07-31", precision: "exact", what: "Resigned after a corruption indictment" },
      { type: "litigation", date: "2011-10-15", precision: "exact", what: "Arrested and held for 23 days" },
      { type: "promotion", date: "2019-07-26", precision: "exact", what: "Chief Minister for a fourth term" },
    ],
  },
  {
    name: "E. M. S. Namboodiripad",
    year: 1909, month: 6, day: 13,
    source: wiki("E._M._S._Namboodiripad"),
    events: [
      { type: "marriage", date: "1937-07-01", precision: "year", what: "Married Arya Antharjanam" },
      { type: "promotion", date: "1957-04-05", precision: "exact", what: "Became the first Chief Minister of Kerala" },
      { type: "job_loss", date: "1959-07-31", precision: "exact", what: "His government dismissed under Article 356" },
      { type: "promotion", date: "1967-03-06", precision: "exact", what: "Chief Minister of Kerala for a second term" },
      { type: "job_loss", date: "1969-11-01", precision: "exact", what: "Left office as Chief Minister" },
      { type: "promotion", date: "1978-04-08", precision: "exact", what: "Became CPI(M) general secretary" },
    ],
  },
  {
    name: "Rahul Gandhi",
    year: 1970, month: 6, day: 19,
    source: wiki("Rahul_Gandhi"),
    events: [
      { type: "bereavement_mother", date: "1984-10-31", precision: "exact", what: "Assassination of his grandmother, Indira Gandhi" },
      { type: "bereavement_father", date: "1991-05-21", precision: "exact", what: "Assassination of his father, Rajiv Gandhi" },
      { type: "education", date: "1994-07-01", precision: "year", what: "Graduated from Rollins College" },
      { type: "education", date: "1995-07-01", precision: "year", what: "MPhil from Trinity College, Cambridge" },
      { type: "promotion", date: "2004-05-17", precision: "exact", what: "First elected to the Lok Sabha, from Amethi" },
      { type: "promotion", date: "2013-01-19", precision: "exact", what: "Became Congress vice-president" },
      { type: "promotion", date: "2017-12-16", precision: "exact", what: "Became Congress president" },
      { type: "job_loss", date: "2019-08-10", precision: "exact", what: "Resigned as Congress president" },
      { type: "foreign_travel", date: "2022-09-07", precision: "exact", what: "Launched the Bharat Jodo Yatra" },
      { type: "litigation", date: "2023-03-23", precision: "exact", what: "Convicted and disqualified from Parliament" },
    ],
  },
  {
    name: "Arvind Kejriwal",
    year: 1968, month: 8, day: 16,
    source: wiki("Arvind_Kejriwal"),
    events: [
      { type: "job_start", date: "1989-07-01", precision: "year", what: "Joined Tata Steel" },
      { type: "marriage", date: "1995-07-01", precision: "year", what: "Married Sunita" },
      { type: "job_start", date: "1995-07-01", precision: "year", what: "Joined the Indian Revenue Service" },
      { type: "promotion", date: "2006-07-01", precision: "year", what: "Awarded the Ramon Magsaysay Award" },
      { type: "business_start", date: "2012-11-15", precision: "month", what: "Launched the Aam Aadmi Party" },
      { type: "promotion", date: "2013-12-28", precision: "exact", what: "Became Chief Minister of Delhi" },
      { type: "job_loss", date: "2014-02-14", precision: "exact", what: "Resigned after 49 days" },
      { type: "promotion", date: "2015-02-14", precision: "exact", what: "Returned as Chief Minister" },
      { type: "litigation", date: "2024-03-21", precision: "exact", what: "Arrested by the Enforcement Directorate" },
      { type: "job_loss", date: "2024-09-17", precision: "exact", what: "Resigned as Chief Minister" },
    ],
  },
  {
    name: "Yogi Adityanath",
    year: 1972, month: 6, day: 5,
    source: wiki("Yogi_Adityanath"),
    events: [
      { type: "promotion", date: "1998-07-01", precision: "year", what: "First elected to the Lok Sabha, from Gorakhpur" },
      { type: "litigation", date: "2007-01-29", precision: "exact", what: "Arrested and held in Gorakhpur jail" },
      { type: "promotion", date: "2014-09-12", precision: "exact", what: "Became Mahant of the Gorakhnath Math" },
      { type: "promotion", date: "2017-03-19", precision: "exact", what: "Became Chief Minister of Uttar Pradesh" },
      { type: "promotion", date: "2022-03-25", precision: "exact", what: "Sworn in for a second term" },
    ],
  },
  {
    name: "Rajnath Singh",
    year: 1951, month: 7, day: 10,
    source: wiki("Rajnath_Singh"),
    events: [
      { type: "marriage", date: "1971-06-05", precision: "exact", what: "Married Savitri Singh" },
      { type: "litigation", date: "1975-07-01", precision: "year", what: "Arrested during the Emergency" },
      { type: "promotion", date: "1977-07-01", precision: "year", what: "Elected to the Uttar Pradesh assembly" },
      { type: "promotion", date: "2000-10-28", precision: "exact", what: "Became Chief Minister of Uttar Pradesh" },
      { type: "promotion", date: "2005-12-31", precision: "exact", what: "Became BJP national president" },
      { type: "promotion", date: "2014-05-26", precision: "exact", what: "Sworn in as Union Home Minister" },
      { type: "promotion", date: "2019-05-31", precision: "exact", what: "Appointed Defence Minister" },
    ],
  },
  {
    name: "Mayawati",
    year: 1956, month: 1, day: 15,
    source: wiki("Mayawati"),
    events: [
      { type: "business_start", date: "1984-07-01", precision: "year", what: "Joined the BSP at its founding" },
      { type: "promotion", date: "1989-07-01", precision: "year", what: "Elected to the Lok Sabha from Bijnor" },
      { type: "promotion", date: "1994-07-01", precision: "year", what: "First elected to the Rajya Sabha" },
      { type: "promotion", date: "1995-06-03", precision: "exact", what: "Became Chief Minister of Uttar Pradesh" },
      { type: "promotion", date: "1997-03-21", precision: "exact", what: "Chief Minister for a second term" },
      { type: "promotion", date: "2001-12-15", precision: "exact", what: "Named as Kanshi Ram's successor" },
      { type: "promotion", date: "2003-09-18", precision: "exact", what: "Elected national president of the BSP" },
      { type: "promotion", date: "2007-05-13", precision: "exact", what: "Chief Minister for a fourth term" },
    ],
  },
  {
    name: "Akhilesh Yadav",
    year: 1973, month: 7, day: 1,
    source: wiki("Akhilesh_Yadav"),
    events: [
      { type: "marriage", date: "1999-07-01", precision: "year", what: "Married Dimple Rawat" },
      { type: "promotion", date: "2000-07-01", precision: "year", what: "Elected to the Lok Sabha from Kannauj" },
      { type: "promotion", date: "2012-03-10", precision: "exact", what: "Became Samajwadi Party leader in Uttar Pradesh" },
      { type: "promotion", date: "2012-03-15", precision: "exact", what: "Became Chief Minister of Uttar Pradesh at 38" },
      { type: "promotion", date: "2017-01-01", precision: "exact", what: "Assumed the presidency of the Samajwadi Party" },
      { type: "promotion", date: "2024-06-04", precision: "exact", what: "Elected to the 18th Lok Sabha from Kannauj" },
    ],
  },
  {
    name: "Bhagwant Mann",
    year: 1973, month: 10, day: 17,
    source: wiki("Bhagwant_Mann"),
    events: [
      { type: "business_start", date: "2014-03-15", precision: "month", what: "Joined the Aam Aadmi Party" },
      { type: "promotion", date: "2014-05-15", precision: "month", what: "First elected to the Lok Sabha" },
      { type: "promotion", date: "2017-07-01", precision: "year", what: "Appointed AAP Punjab convener" },
      { type: "promotion", date: "2022-03-10", precision: "exact", what: "Won the Dhuri assembly seat" },
      { type: "promotion", date: "2022-03-16", precision: "exact", what: "Took oath as Chief Minister of Punjab" },
      { type: "marriage", date: "2022-07-01", precision: "year", what: "Married Gurpreet Kaur" },
      { type: "childbirth", date: "2024-03-15", precision: "month", what: "Birth of his daughter" },
    ],
  },
  {
    name: "Akshay Kumar",
    year: 1967, month: 9, day: 9,
    source: wiki("Akshay_Kumar"),
    events: [
      { type: "job_start", date: "1991-07-01", precision: "year", what: "Film debut in Saugandh" },
      { type: "promotion", date: "1992-07-01", precision: "year", what: "First commercial success, Khiladi" },
      { type: "marriage", date: "2001-07-01", precision: "year", what: "Married Twinkle Khanna" },
      { type: "promotion", date: "2009-07-01", precision: "year", what: "Awarded the Padma Shri" },
      { type: "foreign_travel", date: "2011-07-01", precision: "year", what: "Took Canadian citizenship" },
      { type: "promotion", date: "2016-07-01", precision: "year", what: "National Film Award for Best Actor, Rustom" },
    ],
  },
  {
    name: "Dharmendra",
    year: 1935, month: 12, day: 8,
    source: wiki("Dharmendra"),
    events: [
      { type: "marriage", date: "1954-07-01", precision: "year", what: "Married Prakash Kaur" },
      { type: "job_start", date: "1960-07-01", precision: "year", what: "Film debut in Dil Bhi Tera Hum Bhi Tere" },
      { type: "promotion", date: "1964-07-01", precision: "year", what: "Breakthrough with Ayee Milan Ki Bela" },
      { type: "marriage", date: "1980-07-01", precision: "year", what: "Married Hema Malini" },
      { type: "promotion", date: "1997-07-01", precision: "year", what: "Filmfare Lifetime Achievement Award" },
      { type: "promotion", date: "2004-07-01", precision: "year", what: "Elected to the Lok Sabha from Bikaner" },
      { type: "promotion", date: "2012-07-01", precision: "year", what: "Awarded the Padma Bhushan" },
    ],
  },
  {
    name: "Kangana Ranaut",
    year: 1986, month: 3, day: 23,
    source: wiki("Kangana_Ranaut"),
    events: [
      { type: "job_start", date: "2006-07-01", precision: "year", what: "Film debut in Gangster" },
      { type: "promotion", date: "2008-07-01", precision: "year", what: "National Film Award for Best Supporting Actress" },
      { type: "promotion", date: "2020-07-01", precision: "year", what: "Awarded the Padma Shri" },
      { type: "business_start", date: "2024-03-15", precision: "month", what: "Joined the BJP and entered politics" },
      { type: "promotion", date: "2024-06-15", precision: "month", what: "Elected to the Lok Sabha from Mandi" },
    ],
  },
  {
    name: "Ayushmann Khurrana",
    year: 1984, month: 9, day: 14,
    source: wiki("Ayushmann_Khurrana"),
    events: [
      { type: "promotion", date: "2004-07-01", precision: "year", what: "Won the second season of MTV Roadies" },
      { type: "job_start", date: "2007-07-01", precision: "year", what: "Television debut in Kayamath" },
      { type: "marriage", date: "2008-07-01", precision: "year", what: "Married Tahira Kashyap" },
      { type: "job_start", date: "2012-07-01", precision: "year", what: "Film debut in Vicky Donor" },
      { type: "promotion", date: "2013-07-01", precision: "year", what: "First Filmfare awards, for Vicky Donor" },
      { type: "promotion", date: "2019-07-01", precision: "year", what: "National Film Award for Best Actor, Andhadhun" },
    ],
  },
  {
    name: "Nawazuddin Siddiqui",
    year: 1974, month: 5, day: 19,
    source: wiki("Nawazuddin_Siddiqui"),
    events: [
      { type: "education", date: "1999-07-01", precision: "year", what: "Graduated from the National School of Drama" },
      { type: "job_start", date: "1999-07-01", precision: "year", what: "Film debut in Sarfarosh" },
      { type: "marriage", date: "2009-07-01", precision: "year", what: "Married Aaliya" },
      { type: "promotion", date: "2010-07-01", precision: "year", what: "Breakthrough role in Peepli Live" },
      { type: "promotion", date: "2012-07-01", precision: "year", what: "National Film Award special jury recognition" },
      { type: "childbirth", date: "2015-05-19", precision: "exact", what: "Birth of his son, on his own birthday" },
    ],
  },
  {
    name: "Rajkummar Rao",
    year: 1984, month: 8, day: 31,
    source: wiki("Rajkummar_Rao"),
    events: [
      { type: "education", date: "2008-07-01", precision: "year", what: "Graduated from the Film and Television Institute of India" },
      { type: "job_start", date: "2010-07-01", precision: "year", what: "Film debut in Love Sex Aur Dhokha" },
      { type: "promotion", date: "2014-07-01", precision: "year", what: "National Film Award for Best Actor, Shahid" },
      { type: "bereavement_mother", date: "2016-07-01", precision: "year", what: "Death of his mother" },
      { type: "bereavement_father", date: "2019-07-01", precision: "year", what: "Death of his father" },
      { type: "marriage", date: "2021-11-15", precision: "exact", what: "Married Patralekha" },
    ],
  },
  {
    name: "Anurag Kashyap",
    year: 1972, month: 9, day: 10,
    source: wiki("Anurag_Kashyap"),
    events: [
      { type: "marriage", date: "1997-07-01", precision: "year", what: "Married Aarti Bajaj" },
      { type: "promotion", date: "1998-07-01", precision: "year", what: "Co-wrote Satya, his breakthrough as a writer" },
      { type: "job_start", date: "2003-07-01", precision: "year", what: "Directorial debut, Paanch" },
      { type: "promotion", date: "2012-07-01", precision: "year", what: "Gangs of Wasseypur released" },
      { type: "promotion", date: "2013-05-20", precision: "exact", what: "Made a Knight of the Order of Arts and Letters" },
      { type: "financial_loss", date: "2015-05-15", precision: "month", what: "Divorce from Kalki Koechlin finalised" },
    ],
  },
  {
    name: "Vishal Bhardwaj",
    year: 1965, month: 8, day: 4,
    source: wiki("Vishal_Bhardwaj"),
    events: [
      { type: "job_start", date: "1985-07-01", precision: "year", what: "First composition used in a film" },
      { type: "job_start", date: "1995-07-01", precision: "year", what: "Debut as music director, Abhay" },
      { type: "promotion", date: "1999-07-01", precision: "year", what: "National Film Award for Best Music Direction" },
      { type: "job_start", date: "2002-07-01", precision: "year", what: "Directorial debut, Makdee" },
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
