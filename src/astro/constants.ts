// Core Vedic astrology vocabulary: signs (rashis), nakshatras and planet
// (graha) metadata. All longitudes elsewhere are sidereal unless noted.

export interface RashiInfo {
  index: number; // 0 = Aries
  name: string; // English
  sanskrit: string;
  symbol: string;
  element: "Fire" | "Earth" | "Air" | "Water";
  quality: "Movable" | "Fixed" | "Dual"; // Chara / Sthira / Dvisvabhava
  lord: string; // ruling graha
  gender: "Male" | "Female";
}

export const RASHIS: RashiInfo[] = [
  { index: 0, name: "Aries", sanskrit: "Mesha", symbol: "♈", element: "Fire", quality: "Movable", lord: "Mars", gender: "Male" },
  { index: 1, name: "Taurus", sanskrit: "Vrishabha", symbol: "♉", element: "Earth", quality: "Fixed", lord: "Venus", gender: "Female" },
  { index: 2, name: "Gemini", sanskrit: "Mithuna", symbol: "♊", element: "Air", quality: "Dual", lord: "Mercury", gender: "Male" },
  { index: 3, name: "Cancer", sanskrit: "Karka", symbol: "♋", element: "Water", quality: "Movable", lord: "Moon", gender: "Female" },
  { index: 4, name: "Leo", sanskrit: "Simha", symbol: "♌", element: "Fire", quality: "Fixed", lord: "Sun", gender: "Male" },
  { index: 5, name: "Virgo", sanskrit: "Kanya", symbol: "♍", element: "Earth", quality: "Dual", lord: "Mercury", gender: "Female" },
  { index: 6, name: "Libra", sanskrit: "Tula", symbol: "♎", element: "Air", quality: "Movable", lord: "Venus", gender: "Male" },
  { index: 7, name: "Scorpio", sanskrit: "Vrishchika", symbol: "♏", element: "Water", quality: "Fixed", lord: "Mars", gender: "Female" },
  { index: 8, name: "Sagittarius", sanskrit: "Dhanu", symbol: "♐", element: "Fire", quality: "Dual", lord: "Jupiter", gender: "Male" },
  { index: 9, name: "Capricorn", sanskrit: "Makara", symbol: "♑", element: "Earth", quality: "Movable", lord: "Saturn", gender: "Female" },
  { index: 10, name: "Aquarius", sanskrit: "Kumbha", symbol: "♒", element: "Air", quality: "Fixed", lord: "Saturn", gender: "Male" },
  { index: 11, name: "Pisces", sanskrit: "Meena", symbol: "♓", element: "Water", quality: "Dual", lord: "Jupiter", gender: "Female" },
];

export interface NakshatraInfo {
  index: number; // 0 = Ashwini
  name: string;
  lord: string; // Vimshottari dasha lord
  deity: string;
  symbol: string;
}

// The 27 nakshatras with their Vimshottari lords, deities and symbols.
export const NAKSHATRAS: NakshatraInfo[] = [
  { index: 0, name: "Ashwini", lord: "Ketu", deity: "Ashwini Kumaras", symbol: "Horse's head" },
  { index: 1, name: "Bharani", lord: "Venus", deity: "Yama", symbol: "Yoni" },
  { index: 2, name: "Krittika", lord: "Sun", deity: "Agni", symbol: "Razor / flame" },
  { index: 3, name: "Rohini", lord: "Moon", deity: "Brahma", symbol: "Chariot / ox-cart" },
  { index: 4, name: "Mrigashira", lord: "Mars", deity: "Soma", symbol: "Deer's head" },
  { index: 5, name: "Ardra", lord: "Rahu", deity: "Rudra", symbol: "Teardrop" },
  { index: 6, name: "Punarvasu", lord: "Jupiter", deity: "Aditi", symbol: "Quiver of arrows" },
  { index: 7, name: "Pushya", lord: "Saturn", deity: "Brihaspati", symbol: "Cow's udder / lotus" },
  { index: 8, name: "Ashlesha", lord: "Mercury", deity: "Nagas", symbol: "Coiled serpent" },
  { index: 9, name: "Magha", lord: "Ketu", deity: "Pitris", symbol: "Royal throne" },
  { index: 10, name: "Purva Phalguni", lord: "Venus", deity: "Bhaga", symbol: "Front legs of a bed" },
  { index: 11, name: "Uttara Phalguni", lord: "Sun", deity: "Aryaman", symbol: "Back legs of a bed" },
  { index: 12, name: "Hasta", lord: "Moon", deity: "Savitar", symbol: "Hand / palm" },
  { index: 13, name: "Chitra", lord: "Mars", deity: "Tvashtar", symbol: "Bright jewel / pearl" },
  { index: 14, name: "Swati", lord: "Rahu", deity: "Vayu", symbol: "Sprout / coral" },
  { index: 15, name: "Vishakha", lord: "Jupiter", deity: "Indra-Agni", symbol: "Triumphal arch" },
  { index: 16, name: "Anuradha", lord: "Saturn", deity: "Mitra", symbol: "Lotus / staff" },
  { index: 17, name: "Jyeshtha", lord: "Mercury", deity: "Indra", symbol: "Circular amulet / earring" },
  { index: 18, name: "Mula", lord: "Ketu", deity: "Nirriti", symbol: "Tied bunch of roots" },
  { index: 19, name: "Purva Ashadha", lord: "Venus", deity: "Apas", symbol: "Fan / winnowing basket" },
  { index: 20, name: "Uttara Ashadha", lord: "Sun", deity: "Vishvadevas", symbol: "Elephant tusk" },
  { index: 21, name: "Shravana", lord: "Moon", deity: "Vishnu", symbol: "Ear / three footprints" },
  { index: 22, name: "Dhanishta", lord: "Mars", deity: "Vasus", symbol: "Drum / flute" },
  { index: 23, name: "Shatabhisha", lord: "Rahu", deity: "Varuna", symbol: "Empty circle / 100 healers" },
  { index: 24, name: "Purva Bhadrapada", lord: "Jupiter", deity: "Aja Ekapada", symbol: "Front of funeral cot" },
  { index: 25, name: "Uttara Bhadrapada", lord: "Saturn", deity: "Ahir Budhnya", symbol: "Back of funeral cot" },
  { index: 26, name: "Revati", lord: "Mercury", deity: "Pushan", symbol: "Fish / drum" },
];

export type PlanetName =
  | "Sun"
  | "Moon"
  | "Mars"
  | "Mercury"
  | "Jupiter"
  | "Venus"
  | "Saturn"
  | "Rahu"
  | "Ketu";

export interface GrahaInfo {
  name: PlanetName;
  sanskrit: string;
  symbol: string;
  shortName: string; // 2-letter code used in the chart grid
  nature: "Benefic" | "Malefic" | "Neutral";
  gender: "Male" | "Female" | "Neuter";
}

export const GRAHAS: GrahaInfo[] = [
  { name: "Sun", sanskrit: "Surya", symbol: "☉", shortName: "Su", nature: "Malefic", gender: "Male" },
  { name: "Moon", sanskrit: "Chandra", symbol: "☽", shortName: "Mo", nature: "Benefic", gender: "Female" },
  { name: "Mars", sanskrit: "Mangala", symbol: "♂", shortName: "Ma", nature: "Malefic", gender: "Male" },
  { name: "Mercury", sanskrit: "Budha", symbol: "☿", shortName: "Me", nature: "Neutral", gender: "Neuter" },
  { name: "Jupiter", sanskrit: "Guru", symbol: "♃", shortName: "Ju", nature: "Benefic", gender: "Male" },
  { name: "Venus", sanskrit: "Shukra", symbol: "♀", shortName: "Ve", nature: "Benefic", gender: "Female" },
  { name: "Saturn", sanskrit: "Shani", symbol: "♄", shortName: "Sa", nature: "Malefic", gender: "Neuter" },
  { name: "Rahu", sanskrit: "Rahu", symbol: "☊", shortName: "Ra", nature: "Malefic", gender: "Neuter" },
  { name: "Ketu", sanskrit: "Ketu", symbol: "☋", shortName: "Ke", nature: "Malefic", gender: "Neuter" },
];

export const GRAHA_BY_NAME: Record<PlanetName, GrahaInfo> = Object.fromEntries(
  GRAHAS.map((g) => [g.name, g]),
) as Record<PlanetName, GrahaInfo>;

// Vimshottari Dasha sequence and durations in years (total 120).
export const VIMSHOTTARI_ORDER: PlanetName[] = [
  "Ketu",
  "Venus",
  "Sun",
  "Moon",
  "Mars",
  "Rahu",
  "Jupiter",
  "Saturn",
  "Mercury",
];

export const VIMSHOTTARI_YEARS: Record<string, number> = {
  Ketu: 7,
  Venus: 20,
  Sun: 6,
  Moon: 10,
  Mars: 7,
  Rahu: 18,
  Jupiter: 16,
  Saturn: 19,
  Mercury: 17,
};

export const NAKSHATRA_SPAN = 360 / 27; // 13.3333°
export const PADA_SPAN = NAKSHATRA_SPAN / 4; // 3.3333°
