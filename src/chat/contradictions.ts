// Faithfulness check (Layer B in docs/astro-chat.md § Validation): scan a chat
// reply for placement claims and flag any that contradict the actual chart —
// e.g. the model saying "your Sun is in Aries" when it is in Sagittarius.
//
// This is a deterministic *signal*, not a proof: it matches "<planet> … in …
// <sign>" and "ascendant/lagna … <sign>" patterns, so it can miss paraphrases
// and can occasionally over-flag generic sign talk. It never needs an LLM.

import type { Chart } from "../astro/types";
import { RASHIS } from "../astro/constants";

const SIGNS = RASHIS.map((r) => r.name);
const PLANET_ALT = "Sun|Moon|Mars|Mercury|Jupiter|Venus|Saturn|Rahu|Ketu";
const SIGN_ALT = SIGNS.join("|");

export interface Contradiction {
  subject: string;   // "Sun", "Ascendant", …
  claimed: string;   // the sign the reply asserted
  actual: string;    // the sign the chart actually has
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Canonicalise a matched sign to its RASHIS spelling/casing. */
const canonSign = (s: string) => SIGNS.find((n) => eq(n, s)) ?? s;

/** Placement claims in `reply` that contradict `chart`. Empty = none detected. */
export function findChartContradictions(reply: string, chart: Chart): Contradiction[] {
  const out: Contradiction[] = [];
  const signByPlanet = new Map<string, string>();
  for (const p of chart.planets) signByPlanet.set(p.planet, SIGNS[p.signIndex]);

  // "<planet> … in … <sign>"
  const planetSign = new RegExp(`\\b(${PLANET_ALT})\\b[^.]{0,40}?\\bin\\b[^.]{0,25}?\\b(${SIGN_ALT})\\b`, "gi");
  for (const m of reply.matchAll(planetSign)) {
    const subject = canonPlanet(m[1]);
    const claimed = canonSign(m[2]);
    const actual = signByPlanet.get(subject);
    if (actual && !eq(claimed, actual)) out.push({ subject, claimed, actual });
  }

  // "ascendant / lagna / rising sign … <sign>"
  const ascActual = SIGNS[chart.ascendantSign];
  const asc = new RegExp(`\\b(?:ascendant|lagna|rising sign|rising)\\b[^.]{0,30}?\\b(${SIGN_ALT})\\b`, "gi");
  for (const m of reply.matchAll(asc)) {
    const claimed = canonSign(m[1]);
    if (!eq(claimed, ascActual)) out.push({ subject: "Ascendant", claimed, actual: ascActual });
  }

  // De-duplicate identical (subject, claimed) findings.
  const seen = new Set<string>();
  return out.filter((c) => {
    const k = `${c.subject}|${c.claimed}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function canonPlanet(s: string): string {
  const low = s.toLowerCase();
  return low.charAt(0).toUpperCase() + low.slice(1);
}
