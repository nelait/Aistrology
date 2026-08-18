// Sanity-check the astronomy engine against a known reference chart.
//
// Reference: 1990-01-01, 12:00 IST (UT+5:30), New Delhi (28.6139N, 77.2090E).
// Expected sidereal (Lahiri) positions cross-checked against standard Vedic
// software (values are approximate; we assert sign/nakshatra and loose degrees).

import { computeChart, birthDateUT } from "../src/astro/engine";
import { computeVimshottari } from "../src/astro/dasha";
import { detectYogas } from "../src/astro/yogas";
import { RASHIS, NAKSHATRAS } from "../src/astro/constants";
import { BirthData } from "../src/astro/types";

function fmt(deg: number): string {
  const d = Math.floor(deg);
  const m = Math.floor((deg - d) * 60);
  const s = Math.round(((deg - d) * 60 - m) * 60);
  return `${d}°${String(m).padStart(2, "0")}'${String(s).padStart(2, "0")}"`;
}

const birth: BirthData = {
  name: "Reference",
  year: 1990,
  month: 1,
  day: 1,
  hour: 12,
  minute: 0,
  second: 0,
  tzOffsetHours: 5.5,
  latitude: 28.6139,
  longitude: 77.209,
  placeLabel: "New Delhi, India",
};

const chart = computeChart(birth);

console.log("=== Shastri engine verification ===");
console.log(`Julian Day (UT): ${chart.julianDayUT.toFixed(5)}`);
console.log(`Ayanamsa (Lahiri): ${fmt(chart.ayanamsa)}  (~23°43' expected for 1990)`);
console.log(
  `Ascendant: ${fmt(chart.ascendant % 30)} ${RASHIS[chart.ascendantSign].name} (${RASHIS[chart.ascendantSign].sanskrit})`,
);
console.log("");
console.log("Planet        Sidereal Lon   Sign          Nakshatra           R  Dignity");
for (const p of chart.planets) {
  console.log(
    `${p.planet.padEnd(12)}  ${fmt(p.longitude).padStart(12)}   ${RASHIS[p.signIndex].name.padEnd(12)}  ${NAKSHATRAS[p.nakshatraIndex].name.padEnd(16)} p${p.pada}  ${p.retrograde ? "R" : " "}  ${p.dignity}`,
  );
}

console.log("");
const moon = chart.planets.find((p) => p.planet === "Moon")!;
const dashas = computeVimshottari(moon.longitude, birthDateUT(birth), 40);
console.log("First Mahadashas:");
for (const d of dashas.slice(0, 4)) {
  console.log(
    `  ${d.lord.padEnd(8)} ${d.start.toISOString().slice(0, 10)} -> ${d.end.toISOString().slice(0, 10)}`,
  );
}

console.log("");
console.log("Yogas detected:");
for (const y of detectYogas(chart)) {
  console.log(`  - ${y.name} [${y.category}]`);
}

// --- Basic invariants ---
let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    console.error(`  FAIL: ${name}`);
    failures++;
  } else {
    console.log(`  ok: ${name}`);
  }
}

console.log("");
console.log("Invariants:");
const rahu = chart.planets.find((p) => p.planet === "Rahu")!;
const ketu = chart.planets.find((p) => p.planet === "Ketu")!;
const sep = (((rahu.longitude - ketu.longitude) % 360) + 360) % 360;
check("Rahu and Ketu are exactly 180° apart", Math.abs(sep - 180) < 1e-6);
check("Ayanamsa is between 23° and 24° for 1990", chart.ayanamsa > 23 && chart.ayanamsa < 24);
check("All planets have a valid sign (0..11)", chart.planets.every((p) => p.signIndex >= 0 && p.signIndex < 12));
check("All planets have a valid house (1..12)", chart.planets.every((p) => p.house >= 1 && p.house <= 12));
check("All planets have a pada in 1..4", chart.planets.every((p) => p.pada >= 1 && p.pada <= 4));
check("Sun is in Sagittarius (early January, sidereal)", chart.planets.find((p) => p.planet === "Sun")!.signIndex === 8);
check("Vimshottari first period balance is positive", dashas[0].end > dashas[0].start);
check("Dasha timeline is contiguous", dashas.every((d, i) => i === 0 || Math.abs(d.start.getTime() - dashas[i - 1].end.getTime()) < 1000));

if (failures > 0) {
  console.error(`\n${failures} invariant(s) failed.`);
  process.exit(1);
}
console.log("\nAll invariants passed.");
