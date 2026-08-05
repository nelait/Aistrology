// The engine: turn birth data into a full sidereal (Nirayana) Vedic chart.

import {
  GRAHAS,
  NAKSHATRA_SPAN,
  PADA_SPAN,
  PlanetName,
} from "./constants";
import { norm360 } from "./math";
import { julianDayFromLocal } from "./time";
import { deltaTSeconds } from "./deltat";
import { ayanamsaValue, Ayanamsa } from "./ayanamsa";
import { sunApparentLongitude } from "./sun";
import { moonApparentLongitude } from "./moon";
import { planetLongitude } from "./planets";
import { rahuLongitude, ketuLongitude, trueNodeLongitude } from "./nodes";
import { ascendantMc } from "./ascendant";
import { dignityOf } from "./dignity";
import { divisionalSign } from "./varga";
import { BirthData, Chart, NodeType, PlanetPosition } from "./types";

/** Tropical (equinox of date) longitude of a body at a given JD. */
function tropicalLongitude(
  planet: PlanetName,
  jd: number,
  nodeType: NodeType,
): number {
  switch (planet) {
    case "Sun":
      return sunApparentLongitude(jd);
    case "Moon":
      return moonApparentLongitude(jd);
    case "Rahu":
      return nodeType === "true" ? trueNodeLongitude(jd) : rahuLongitude(jd);
    case "Ketu":
      return nodeType === "true"
        ? norm360(trueNodeLongitude(jd) + 180)
        : ketuLongitude(jd);
    default:
      return planetLongitude(planet, jd);
  }
}

/** Sidereal longitude = tropical(of date) − ayanamsa(of date). */
export function siderealLongitude(
  planet: PlanetName,
  jd: number,
  ayanamsaSystem: Ayanamsa = "Lahiri",
  nodeType: NodeType = "mean",
): number {
  return norm360(
    tropicalLongitude(planet, jd, nodeType) - ayanamsaValue(jd, ayanamsaSystem),
  );
}

/** Detect retrograde motion by sampling the longitude a short time later. */
export function isRetrograde(
  planet: PlanetName,
  jd: number,
  nodeType: NodeType = "mean",
): boolean {
  if (planet === "Sun" || planet === "Moon") return false;
  // The mean node is always retrograde; the true node is usually retrograde but
  // can turn briefly direct, so sample it like the planets.
  if ((planet === "Rahu" || planet === "Ketu") && nodeType === "mean") return true;
  const dt = 0.5; // days
  const l1 = tropicalLongitude(planet, jd, nodeType);
  const l2 = tropicalLongitude(planet, jd + dt, nodeType);
  // Handle wrap-around at 360.
  let delta = l2 - l1;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta < 0;
}

export interface ChartOptions {
  ayanamsa?: Ayanamsa; // default "Lahiri"
  nodeType?: NodeType; // default "mean"
}

export function computeChart(birth: BirthData, options: ChartOptions = {}): Chart {
  const ayanamsaSystem = options.ayanamsa ?? "Lahiri";
  const nodeType = options.nodeType ?? "mean";

  const jd = julianDayFromLocal(
    birth.year,
    birth.month,
    birth.day,
    birth.hour,
    birth.minute,
    birth.second,
    birth.tzOffsetHours,
  );

  // The ephemeris series are expressed in Terrestrial Time, so shift the UT
  // instant by ΔT before sampling body positions. Sidereal time and the
  // Ascendant stay on UT (they are defined against the rotating Earth).
  const jdTT = jd + deltaTSeconds(jd) / 86400;

  const ayanamsa = ayanamsaValue(jdTT, ayanamsaSystem);

  const { ascendant: ascTropical, mc: mcTropical } = ascendantMc(
    jd,
    birth.longitude,
    birth.latitude,
  );
  const ascendant = norm360(ascTropical - ayanamsa);
  const mc = norm360(mcTropical - ayanamsa);
  const ascendantSign = Math.floor(ascendant / 30);

  // Whole-sign houses: house 1 is the ascendant's sign, and each subsequent
  // sign is the next house.
  const houseSigns: number[] = [];
  for (let h = 0; h < 12; h++) houseSigns.push((ascendantSign + h) % 12);

  const planets: PlanetPosition[] = GRAHAS.map((g) => {
    const lon = siderealLongitude(g.name, jdTT, ayanamsaSystem, nodeType);
    const signIndex = Math.floor(lon / 30);
    const degreeInSign = lon - signIndex * 30;
    const nakshatraIndex = Math.floor(lon / NAKSHATRA_SPAN) % 27;
    const pada = Math.floor((lon % NAKSHATRA_SPAN) / PADA_SPAN) + 1;
    const house = ((signIndex - ascendantSign + 12) % 12) + 1;
    const navamsaSign = divisionalSign(lon, "D9");

    return {
      planet: g.name,
      longitude: lon,
      signIndex,
      degreeInSign,
      nakshatraIndex,
      pada,
      house,
      retrograde: isRetrograde(g.name, jdTT, nodeType),
      dignity: dignityOf(g.name, signIndex, degreeInSign),
      navamsaSign,
    };
  });

  return {
    birth,
    julianDayUT: jd,
    ayanamsaSystem,
    nodeType,
    ayanamsa,
    ascendant,
    ascendantSign,
    mc,
    planets,
    houseSigns,
  };
}

/** The birth instant as a UT Date, handy for the dasha timeline. */
export function birthDateUT(birth: BirthData): Date {
  const utHours =
    birth.hour + birth.minute / 60 + birth.second / 3600 - birth.tzOffsetHours;
  const ms = Date.UTC(birth.year, birth.month - 1, birth.day) + utHours * 3600 * 1000;
  return new Date(ms);
}

export function moonPosition(chart: Chart): PlanetPosition {
  return chart.planets.find((p) => p.planet === "Moon")!;
}
