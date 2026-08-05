// The prediction layer: combine the computed chart with the knowledge base to
// produce readable, justified interpretations. Everything here is derived and
// explainable — each statement can be traced to a placement and a rule.

import { GRAHA_BY_NAME, PlanetName, RASHIS, NAKSHATRAS } from "./constants";
import { Chart, PlanetPosition } from "./types";
import { naturalRelation } from "./dignity";
import { planetsAspectingHouse, aspectedSigns } from "./aspects";
import {
  PLANET_SIGNIFICATIONS,
  HOUSE_SIGNIFICATIONS,
  PLANET_IN_SIGN,
  PLANET_IN_HOUSE,
} from "../data/significations";

export interface Reading {
  planet: PlanetName;
  headline: string;
  house: number;
  sign: number;
  detail: string;
  strength: string;
}

/** Ordinal helper: 1 -> "1st", 2 -> "2nd" ... */
export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function planetReading(chart: Chart, pos: PlanetPosition): Reading {
  const sig = PLANET_SIGNIFICATIONS[pos.planet];
  const houseInfo = HOUSE_SIGNIFICATIONS[pos.house - 1];
  const signName = RASHIS[pos.signIndex].name;

  const inSign = PLANET_IN_SIGN[pos.planet]?.[pos.signIndex] ?? "";
  const inHouse = PLANET_IN_HOUSE[pos.planet]?.[pos.house - 1] ?? "";

  const strengthNote =
    pos.dignity === "Exalted"
      ? `${pos.planet} is exalted here — at its most powerful and best-expressed.`
      : pos.dignity === "Debilitated"
        ? `${pos.planet} is debilitated here — its significations are tested and mature through difficulty (and can be cancelled — Neecha Bhanga — by supporting factors).`
        : pos.dignity === "Own sign" || pos.dignity === "Moolatrikona"
          ? `${pos.planet} is in dignity (${pos.dignity.toLowerCase()}) — comfortable and strong.`
          : `${pos.planet} is neutrally placed by sign.`;

  const retro = pos.retrograde
    ? ` It is retrograde (Vakri), turning its energy inward and intensifying its karmic themes.`
    : "";

  const detail =
    `${sig.karaka}. ` +
    `In ${signName}, ${pos.planet} is ${inSign} ` +
    `Placed in the ${ordinal(pos.house)} house (${houseInfo.name}), it brings ${inHouse}` +
    retro;

  return {
    planet: pos.planet,
    headline: `${sig.title}`,
    house: pos.house,
    sign: pos.signIndex,
    detail,
    strength: strengthNote,
  };
}

/** A short life-area summary built from which planet occupies / aspects a house. */
export interface HouseReading {
  house: number;
  name: string;
  meaning: string;
  lord: PlanetName;
  lordPlacement: string;
  occupants: PlanetName[];
  aspectedBy: PlanetName[];
  verdict: string;
}

export function houseReading(chart: Chart, house: number): HouseReading {
  const info = HOUSE_SIGNIFICATIONS[house - 1];
  const signIndex = chart.houseSigns[house - 1];
  const lord = RASHIS[signIndex].lord as PlanetName;
  const lordPos = chart.planets.find((p) => p.planet === lord)!;

  const occupants = chart.planets
    .filter((p) => p.house === house)
    .map((p) => p.planet);
  const aspectedBy = planetsAspectingHouse(chart.planets, chart.houseSigns, house)
    .filter((pl) => !occupants.includes(pl));

  // A light qualitative verdict from occupants + aspects.
  const benefics: PlanetName[] = ["Jupiter", "Venus", "Moon", "Mercury"];
  const malefics: PlanetName[] = ["Saturn", "Mars", "Sun", "Rahu", "Ketu"];
  const beneficInfluence =
    occupants.filter((p) => benefics.includes(p)).length +
    aspectedBy.filter((p) => benefics.includes(p)).length;
  const maleficInfluence =
    occupants.filter((p) => malefics.includes(p)).length +
    aspectedBy.filter((p) => malefics.includes(p)).length;

  let verdict: string;
  if (beneficInfluence > maleficInfluence) {
    verdict = `Well-supported: benefic influence favours the affairs of the ${ordinal(house)} house.`;
  } else if (maleficInfluence > beneficInfluence) {
    verdict = `Tested: malefic influence asks for effort and maturity in this area — often strengthening it over time.`;
  } else if (beneficInfluence === 0 && maleficInfluence === 0) {
    verdict = `Quiet: no planet sits in or aspects this house, so it works largely through its lord ${lord}.`;
  } else {
    verdict = `Mixed: both supportive and challenging influences meet here, giving results in phases.`;
  }

  const lordPlacement =
    `Its lord ${lord} sits in the ${ordinal(lordPos.house)} house in ${RASHIS[lordPos.signIndex].name}, ` +
    `linking ${ordinal(house)}-house matters with ${ordinal(lordPos.house)}-house matters.`;

  return {
    house,
    name: info.name,
    meaning: info.meaning,
    lord,
    lordPlacement,
    occupants,
    aspectedBy,
    verdict,
  };
}

/** The Moon's nakshatra reading — the personal "birth star". */
export function moonNakshatraSummary(chart: Chart): string {
  const moon = chart.planets.find((p) => p.planet === "Moon")!;
  const nak = NAKSHATRAS[moon.nakshatraIndex];
  return (
    `Your Janma Nakshatra (birth star) is ${nak.name}, ruled by ${nak.lord}, ` +
    `with the deity ${nak.deity} and the symbol of the ${nak.symbol.toLowerCase()}. ` +
    `The Moon sits in pada ${moon.pada}. This nakshatra shapes your instinctive mind and ` +
    `sets the starting point of your Vimshottari Dasha cycle under ${nak.lord}.`
  );
}

/** Top-line character sketch from Lagna + Moon sign + Sun sign. */
export function personalitySketch(chart: Chart): string[] {
  const lagna = RASHIS[chart.ascendantSign];
  const moon = chart.planets.find((p) => p.planet === "Moon")!;
  const sun = chart.planets.find((p) => p.planet === "Sun")!;
  const moonSign = RASHIS[moon.signIndex];
  const sunSign = RASHIS[sun.signIndex];

  return [
    `Lagna (Ascendant) — ${lagna.name} (${lagna.sanskrit}): your outward personality, body and life-approach are ${lagna.quality.toLowerCase()} ${lagna.element.toLowerCase()}, ruled by ${lagna.lord}. This is how the world meets you.`,
    `Rashi (Moon sign) — ${moonSign.name}: in Vedic astrology the Moon sign is primary. Your emotional nature and instinctive mind are coloured by ${moonSign.element.toLowerCase()}, ${moonSign.quality.toLowerCase()} ${moonSign.name}.`,
    `Surya Rashi (Sun sign) — ${sunSign.name}: your soul, ego and sense of purpose express through ${sunSign.name}, ruled by ${sunSign.lord}.`,
  ];
}

/** Relationship of a dasha lord to the chart, used to colour period predictions. */
export function dashaOutlook(chart: Chart, lord: PlanetName): string {
  const pos = chart.planets.find((p) => p.planet === lord)!;
  const sig = PLANET_SIGNIFICATIONS[lord];
  const houseInfo = HOUSE_SIGNIFICATIONS[pos.house - 1];
  const lagnaLord = RASHIS[chart.ascendantSign].lord as PlanetName;
  const relToLagnaLord =
    lord === lagnaLord ? "is your Lagna lord" : `is a ${naturalRelation(lagnaLord, lord).toLowerCase()} of your Lagna lord ${lagnaLord}`;

  const quality =
    pos.dignity === "Exalted" || pos.dignity === "Own sign" || pos.dignity === "Moolatrikona"
      ? "Because it is strong in the chart, this period tends to deliver its promises well"
      : pos.dignity === "Debilitated"
        ? "Because it is debilitated, this period asks for patience and inner work before results ripen"
        : "Results depend on the running sub-period and transits";

  return (
    `${lord} rules themes of ${sig.karaka.toLowerCase()}. In your chart it sits in the ${ordinal(pos.house)} house ` +
    `(${houseInfo.name} — ${houseInfo.keywords.join(", ")}) in ${RASHIS[pos.signIndex].name}, and ${relToLagnaLord}. ` +
    `${quality}. Expect its period to activate ${ordinal(pos.house)}-house matters.`
  );
}
