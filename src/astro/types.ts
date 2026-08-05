import { PlanetName } from "./constants";
import { DignityStatus } from "./dignity";
import { Ayanamsa } from "./ayanamsa";

export type NodeType = "mean" | "true";

export interface BirthData {
  name: string;
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23 local
  minute: number; // 0-59 local
  second: number; // 0-59 local
  tzOffsetHours: number; // east of UTC positive, e.g. +5.5 for IST
  latitude: number; // north positive
  longitude: number; // east positive
  placeLabel: string;
}

export interface PlanetPosition {
  planet: PlanetName;
  longitude: number; // sidereal ecliptic longitude 0..360
  signIndex: number; // 0..11
  degreeInSign: number; // 0..30
  nakshatraIndex: number; // 0..26
  pada: number; // 1..4
  house: number; // 1..12 (whole-sign, from Lagna)
  retrograde: boolean;
  dignity: DignityStatus;
  navamsaSign: number; // 0..11
}

export interface Chart {
  birth: BirthData;
  julianDayUT: number;
  ayanamsaSystem: Ayanamsa; // which ayanamsa was used
  nodeType: NodeType; // mean or true lunar node
  ayanamsa: number;
  ascendant: number; // sidereal longitude
  ascendantSign: number; // Lagna sign index
  mc: number; // sidereal longitude of midheaven
  planets: PlanetPosition[];
  // sign index occupying each house 1..12 (house 1 = ascendant sign)
  houseSigns: number[];
}

export interface DashaPeriod {
  lord: PlanetName;
  start: Date;
  end: Date;
  level: number; // 1 = Mahadasha, 2 = Antardasha
  children?: DashaPeriod[];
}
