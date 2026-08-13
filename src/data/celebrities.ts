// Sample public figures offered as one-click examples for the birth form.
//
// Two deliberate choices:
//
// 1. Each entry stores an IANA `zone` rather than a fixed UTC offset. The offset
//    is resolved for the birth DATE via zoneOffsetHours(), so historical rules
//    apply automatically — WWII "war time" in 1942 New York, pre-1942 Ceylon,
//    US daylight saving, and India's pre-1906 local mean time.
//
// 2. Birth TIMES are not publicly documented for these figures, so every entry
//    uses 12:00 local with `timeKnown: false`. That is honest rather than
//    invented — but it matters: the Ascendant moves a full sign roughly every
//    two hours, so houses and the Lagna in these charts are illustrative only.
//    Planetary signs, nakshatras and the dasha sequence remain meaningful.

import type { BirthData } from "../astro/types";
import { zoneOffsetHours } from "../astro/timezone";

export type CelebrityRegion = "South India" | "North India" | "United States";

export interface Celebrity {
  name: string;
  region: CelebrityRegion;
  field: string;
  year: number;
  month: number;
  day: number;
  /** Local clock time. 12:00 when unknown — see `timeKnown`. */
  hour: number;
  minute: number;
  /** False when the birth time is not documented and noon is a placeholder. */
  timeKnown: boolean;
  zone: string;
  latitude: number;
  longitude: number;
  placeLabel: string;
  wiki: string;
}

const IN = "Asia/Kolkata";
const NY = "America/New_York";
const LA = "America/Los_Angeles";
const w = (slug: string) => `https://en.wikipedia.org/wiki/${slug}`;

export const CELEBRITIES: Celebrity[] = [
  // ── South India ─────────────────────────────────────────────────────────
  { name: "M. G. Ramachandran", region: "South India", field: "Film & Politics", year: 1917, month: 1, day: 17, hour: 12, minute: 0, timeKnown: false, zone: "Asia/Colombo", latitude: 7.05, longitude: 80.5333, placeLabel: "Nawalapitiya, Kandy District, Sri Lanka", wiki: w("M._G._Ramachandran") },
  { name: "N. T. Rama Rao", region: "South India", field: "Film & Politics", year: 1923, month: 5, day: 28, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 16.2828, longitude: 80.9575, placeLabel: "Nimmakuru, Krishna District, Andhra Pradesh, India", wiki: w("N._T._Rama_Rao") },
  { name: "J. Jayalalithaa", region: "South India", field: "Film & Politics", year: 1948, month: 2, day: 24, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 12.6612, longitude: 76.6534, placeLabel: "Melukote, Mandya District, Karnataka, India", wiki: w("J._Jayalalithaa") },
  { name: "M. Karunanidhi", region: "South India", field: "Film & Politics", year: 1924, month: 6, day: 3, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 10.5839, longitude: 79.7125, placeLabel: "Thirukkuvalai, Nagapattinam District, Tamil Nadu, India", wiki: w("M._Karunanidhi") },
  { name: "C. N. Annadurai", region: "South India", field: "Politics & Film", year: 1909, month: 9, day: 15, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 12.8331, longitude: 79.7167, placeLabel: "Kanchipuram, Tamil Nadu, India", wiki: w("C._N._Annadurai") },
  { name: "Rajinikanth", region: "South India", field: "Film", year: 1950, month: 12, day: 12, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 12.9716, longitude: 77.5946, placeLabel: "Bengaluru, Karnataka, India", wiki: w("Rajinikanth") },
  { name: "Kamal Haasan", region: "South India", field: "Film & Politics", year: 1954, month: 11, day: 7, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 9.5484, longitude: 78.5888, placeLabel: "Paramakudi, Ramanathapuram District, Tamil Nadu, India", wiki: w("Kamal_Haasan") },
  { name: "Chiranjeevi", region: "South India", field: "Film & Politics", year: 1955, month: 8, day: 22, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 16.4167, longitude: 81.6, placeLabel: "Mogalthuru, West Godavari District, Andhra Pradesh, India", wiki: w("Chiranjeevi") },
  { name: "Pawan Kalyan", region: "South India", field: "Film & Politics", year: 1971, month: 9, day: 2, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 15.9042, longitude: 80.4673, placeLabel: "Bapatla, Andhra Pradesh, India", wiki: w("Pawan_Kalyan") },
  { name: "Vijay", region: "South India", field: "Film & Politics", year: 1974, month: 6, day: 22, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 13.0827, longitude: 80.2707, placeLabel: "Chennai, Tamil Nadu, India", wiki: w("C._Joseph_Vijay") },
  { name: "N. Chandrababu Naidu", region: "South India", field: "Politics", year: 1950, month: 4, day: 20, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 13.6167, longitude: 79.2667, placeLabel: "Naravaripalle, Tirupati District, Andhra Pradesh, India", wiki: w("N._Chandrababu_Naidu") },
  { name: "K. Chandrashekar Rao", region: "South India", field: "Politics", year: 1954, month: 2, day: 17, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 18.0678, longitude: 78.8842, placeLabel: "Chintamadaka, Siddipet District, Telangana, India", wiki: w("K._Chandrashekar_Rao") },
  { name: "Y. S. Rajasekhara Reddy", region: "South India", field: "Politics", year: 1949, month: 7, day: 8, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 14.4167, longitude: 78.2333, placeLabel: "Pulivendula, YSR Kadapa District, Andhra Pradesh, India", wiki: w("Y._S._Rajasekhara_Reddy") },
  { name: "Dr. Rajkumar", region: "South India", field: "Film", year: 1929, month: 4, day: 24, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 11.7661, longitude: 77.0057, placeLabel: "Gajanur, Erode District, Tamil Nadu, India", wiki: w("Dr._Rajkumar") },
  { name: "H. D. Deve Gowda", region: "South India", field: "Politics", year: 1933, month: 5, day: 18, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 12.5814, longitude: 76.2067, placeLabel: "Haradanahalli, Hassan District, Karnataka, India", wiki: w("H._D._Deve_Gowda") },
  { name: "B. S. Yediyurappa", region: "South India", field: "Politics", year: 1943, month: 2, day: 27, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 12.5408, longitude: 76.5948, placeLabel: "Bookanakere, Mandya District, Karnataka, India", wiki: w("B._S._Yediyurappa") },
  { name: "E. M. S. Namboodiripad", region: "South India", field: "Politics", year: 1909, month: 6, day: 13, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 10.9, longitude: 76.2167, placeLabel: "Elamkulam, Malappuram District, Kerala, India", wiki: w("E._M._S._Namboodiripad") },
  { name: "Pinarayi Vijayan", region: "South India", field: "Politics", year: 1945, month: 5, day: 24, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 11.8, longitude: 75.5167, placeLabel: "Pinarayi, Kannur District, Kerala, India", wiki: w("Pinarayi_Vijayan") },
  { name: "Mohanlal", region: "South India", field: "Film", year: 1960, month: 5, day: 21, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 9.2833, longitude: 76.7167, placeLabel: "Elanthoor, Pathanamthitta District, Kerala, India", wiki: w("Mohanlal") },
  { name: "Mammootty", region: "South India", field: "Film", year: 1951, month: 9, day: 7, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 9.8481, longitude: 76.3075, placeLabel: "Chandiroor, Alappuzha District, Kerala, India", wiki: w("Mammootty") },

  // ── North India ─────────────────────────────────────────────────────────
  { name: "Amitabh Bachchan", region: "North India", field: "Film & Politics", year: 1942, month: 10, day: 11, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 25.4358, longitude: 81.8463, placeLabel: "Prayagraj, Uttar Pradesh, India", wiki: w("Amitabh_Bachchan") },
  { name: "Shah Rukh Khan", region: "North India", field: "Film", year: 1965, month: 11, day: 2, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 28.6139, longitude: 77.209, placeLabel: "New Delhi, India", wiki: w("Shah_Rukh_Khan") },
  { name: "Akshay Kumar", region: "North India", field: "Film", year: 1967, month: 9, day: 9, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 31.634, longitude: 74.8723, placeLabel: "Amritsar, Punjab, India", wiki: w("Akshay_Kumar") },
  { name: "Dharmendra", region: "North India", field: "Film & Politics", year: 1935, month: 12, day: 8, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 30.67, longitude: 76.27, placeLabel: "Nasrali, Ludhiana District, Punjab, India", wiki: w("Dharmendra") },
  { name: "Kangana Ranaut", region: "North India", field: "Film & Politics", year: 1986, month: 3, day: 23, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 31.5922, longitude: 76.7358, placeLabel: "Bhambla, Mandi District, Himachal Pradesh, India", wiki: w("Kangana_Ranaut") },
  { name: "Ayushmann Khurrana", region: "North India", field: "Film", year: 1984, month: 9, day: 14, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 30.7333, longitude: 76.7794, placeLabel: "Chandigarh, India", wiki: w("Ayushmann_Khurrana") },
  { name: "Nawazuddin Siddiqui", region: "North India", field: "Film", year: 1974, month: 5, day: 19, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 29.28, longitude: 77.47, placeLabel: "Budhana, Muzaffarnagar District, Uttar Pradesh, India", wiki: w("Nawazuddin_Siddiqui") },
  { name: "Rajkummar Rao", region: "North India", field: "Film", year: 1984, month: 8, day: 31, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 28.4595, longitude: 77.0266, placeLabel: "Gurugram, Haryana, India", wiki: w("Rajkummar_Rao") },
  { name: "Anurag Kashyap", region: "North India", field: "Film", year: 1972, month: 9, day: 10, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 26.7606, longitude: 83.3732, placeLabel: "Gorakhpur, Uttar Pradesh, India", wiki: w("Anurag_Kashyap") },
  { name: "Vishal Bhardwaj", region: "North India", field: "Film", year: 1965, month: 8, day: 4, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 29.1333, longitude: 78.2667, placeLabel: "Chandpur, Bijnor District, Uttar Pradesh, India", wiki: w("Vishal_Bhardwaj") },
  { name: "Jawaharlal Nehru", region: "North India", field: "Politics", year: 1889, month: 11, day: 14, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 25.4358, longitude: 81.8463, placeLabel: "Prayagraj, Uttar Pradesh, India", wiki: w("Jawaharlal_Nehru") },
  { name: "Indira Gandhi", region: "North India", field: "Politics", year: 1917, month: 11, day: 19, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 25.4358, longitude: 81.8463, placeLabel: "Prayagraj, Uttar Pradesh, India", wiki: w("Indira_Gandhi") },
  { name: "Atal Bihari Vajpayee", region: "North India", field: "Politics", year: 1924, month: 12, day: 25, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 26.2183, longitude: 78.1828, placeLabel: "Gwalior, Madhya Pradesh, India", wiki: w("Atal_Bihari_Vajpayee") },
  { name: "Rahul Gandhi", region: "North India", field: "Politics", year: 1970, month: 6, day: 19, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 28.6139, longitude: 77.209, placeLabel: "New Delhi, India", wiki: w("Rahul_Gandhi") },
  { name: "Arvind Kejriwal", region: "North India", field: "Politics", year: 1968, month: 8, day: 16, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 28.9084, longitude: 75.6121, placeLabel: "Siwani, Bhiwani District, Haryana, India", wiki: w("Arvind_Kejriwal") },
  { name: "Yogi Adityanath", region: "North India", field: "Politics", year: 1972, month: 6, day: 5, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 30.19, longitude: 78.04, placeLabel: "Panchur, Pauri Garhwal District, Uttarakhand, India", wiki: w("Yogi_Adityanath") },
  { name: "Rajnath Singh", region: "North India", field: "Politics", year: 1951, month: 7, day: 10, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 25.281, longitude: 83.119, placeLabel: "Bhabhaura, Chandauli District, Uttar Pradesh, India", wiki: w("Rajnath_Singh") },
  { name: "Mayawati", region: "North India", field: "Politics", year: 1956, month: 1, day: 15, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 28.6139, longitude: 77.209, placeLabel: "New Delhi, India", wiki: w("Mayawati") },
  { name: "Akhilesh Yadav", region: "North India", field: "Politics", year: 1973, month: 7, day: 1, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 26.9667, longitude: 78.9574, placeLabel: "Saifai, Etawah District, Uttar Pradesh, India", wiki: w("Akhilesh_Yadav") },
  { name: "Bhagwant Mann", region: "North India", field: "Politics & Film", year: 1973, month: 10, day: 17, hour: 12, minute: 0, timeKnown: false, zone: IN, latitude: 30.0561, longitude: 75.655, placeLabel: "Satoj, Sangrur District, Punjab, India", wiki: w("Bhagwant_Mann") },

  // ── United States ───────────────────────────────────────────────────────
  { name: "Ronald Reagan", region: "United States", field: "Politics & Film", year: 1911, month: 2, day: 6, hour: 12, minute: 0, timeKnown: false, zone: "America/Chicago", latitude: 41.6311, longitude: -89.7848, placeLabel: "Tampico, Illinois, United States", wiki: w("Ronald_Reagan") },
  { name: "Abraham Lincoln", region: "United States", field: "Politics", year: 1809, month: 2, day: 12, hour: 12, minute: 0, timeKnown: false, zone: "America/Kentucky/Louisville", latitude: 37.5311, longitude: -85.7311, placeLabel: "Hodgenville, Kentucky, United States", wiki: w("Abraham_Lincoln") },
  { name: "John F. Kennedy", region: "United States", field: "Politics", year: 1917, month: 5, day: 29, hour: 12, minute: 0, timeKnown: false, zone: NY, latitude: 42.3469, longitude: -71.1228, placeLabel: "Brookline, Massachusetts, United States", wiki: w("John_F._Kennedy") },
  { name: "Barack Obama", region: "United States", field: "Politics", year: 1961, month: 8, day: 4, hour: 12, minute: 0, timeKnown: false, zone: "Pacific/Honolulu", latitude: 21.3069, longitude: -157.8583, placeLabel: "Honolulu, Hawaii, United States", wiki: w("Barack_Obama") },
  { name: "Franklin D. Roosevelt", region: "United States", field: "Politics", year: 1882, month: 1, day: 30, hour: 12, minute: 0, timeKnown: false, zone: NY, latitude: 41.7681, longitude: -73.9353, placeLabel: "Hyde Park, New York, United States", wiki: w("Franklin_D._Roosevelt") },
  { name: "Steven Spielberg", region: "United States", field: "Film", year: 1946, month: 12, day: 18, hour: 12, minute: 0, timeKnown: false, zone: NY, latitude: 39.1031, longitude: -84.512, placeLabel: "Cincinnati, Ohio, United States", wiki: w("Steven_Spielberg") },
  { name: "Clint Eastwood", region: "United States", field: "Film & Politics", year: 1930, month: 5, day: 31, hour: 12, minute: 0, timeKnown: false, zone: LA, latitude: 37.7749, longitude: -122.4194, placeLabel: "San Francisco, California, United States", wiki: w("Clint_Eastwood") },
  { name: "Meryl Streep", region: "United States", field: "Film", year: 1949, month: 6, day: 22, hour: 12, minute: 0, timeKnown: false, zone: NY, latitude: 40.7156, longitude: -74.3647, placeLabel: "Summit, New Jersey, United States", wiki: w("Meryl_Streep") },
  // Longitude corrected to New York City's actual -74.0060 (the source table
  // carried -942, which is outside the valid -180..180 range).
  { name: "Martin Scorsese", region: "United States", field: "Film", year: 1942, month: 11, day: 17, hour: 12, minute: 0, timeKnown: false, zone: NY, latitude: 40.7128, longitude: -74.006, placeLabel: "New York City, New York, United States", wiki: w("Martin_Scorsese") },
  { name: "Tom Hanks", region: "United States", field: "Film", year: 1956, month: 7, day: 9, hour: 12, minute: 0, timeKnown: false, zone: LA, latitude: 37.9781, longitude: -122.0311, placeLabel: "Concord, California, United States", wiki: w("Tom_Hanks") },
];

export const CELEBRITY_REGIONS: CelebrityRegion[] = ["South India", "North India", "United States"];

/**
 * Convert an entry into BirthData, resolving the UTC offset for the birth date
 * from the IANA zone so historical rules (war time, DST, pre-standard-time local
 * mean time) are applied rather than guessed.
 */
export function celebrityToBirth(c: Celebrity): BirthData {
  return {
    name: c.name,
    year: c.year, month: c.month, day: c.day,
    hour: c.hour, minute: c.minute, second: 0,
    tzOffsetHours: zoneOffsetHours(c.zone, c.year, c.month, c.day, c.hour, c.minute),
    latitude: c.latitude,
    longitude: c.longitude,
    placeLabel: c.placeLabel,
  };
}

/** Case-insensitive match on name, place or field. */
export function searchCelebrities(query: string, region?: CelebrityRegion | "All"): Celebrity[] {
  const q = query.trim().toLowerCase();
  return CELEBRITIES.filter((c) => {
    if (region && region !== "All" && c.region !== region) return false;
    if (!q) return true;
    return (
      c.name.toLowerCase().includes(q) ||
      c.placeLabel.toLowerCase().includes(q) ||
      c.field.toLowerCase().includes(q)
    );
  });
}
