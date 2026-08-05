// Pure, dependency-light builders for the Astro Chat context payload. Kept out
// of the React component so they can be unit-tested deterministically (see
// context.test.ts) — this is the backbone that certifies the model always
// receives the *selected profile's* data. See docs/astro-chat.md § Validation.

import type { Chart } from "../astro/types";
import { RASHIS, NAKSHATRAS } from "../astro/constants";
import { detectDoshas } from "../astro/doshas";
import type { ChatContext } from "../api/client";

/** Compact, LLM-friendly summary of a computed chart: ascendant + placements. */
export function summarizeChart(chart: Chart): string {
  const asc = RASHIS[chart.ascendantSign]?.name ?? "?";
  const lines = [`Ascendant (Lagna): ${asc}.`];
  for (const p of chart.planets) {
    const sign = RASHIS[p.signIndex]?.name ?? "?";
    const nak = NAKSHATRAS[p.nakshatraIndex]?.name;
    const bits = [`${p.planet} in ${sign}, house ${p.house}`];
    if (p.retrograde) bits.push("retrograde");
    if (p.dignity && p.dignity !== "Neutral") bits.push(p.dignity);
    if (nak) bits.push(`nakshatra ${nak}`);
    lines.push(bits.join(", ") + ".");
  }
  return lines.join("\n");
}

/** Detected doshas as grounding lines — a core, deterministic chart property. */
export function summarizeDoshas(chart: Chart): string[] {
  const doshas = detectDoshas(chart);
  if (doshas.length === 0) return ["Doshas: none of the common chart doshas are present in this chart."];
  return doshas.map((d) =>
    `Dosha present: ${d.name}${d.sanskrit ? ` (${d.sanskrit})` : ""}, severity ${d.severity}, ` +
    `involving ${d.planets.join(", ")}${d.houses?.length ? ` in house(s) ${d.houses.join(", ")}` : ""}. ${d.effect}`,
  );
}

/** Assemble the full chat context for the selected profile. The single source of
 * truth for what the model sees, so profile-correctness is decided (and tested)
 * in one place rather than inline in the component. */
export function buildChatContext(opts: {
  chart: Chart | null;
  moduleLabel?: string;
  /** Findings published by the currently-visible module (Muhurta, Vastu…). */
  moduleFindings?: string[] | null;
}): ChatContext {
  const { chart, moduleLabel, moduleFindings } = opts;
  const findings = [
    ...(chart ? summarizeDoshas(chart) : []),
    ...(moduleFindings ?? []),
  ];
  return {
    chart: chart ? { label: chart.birth.name, summary: summarizeChart(chart) } : undefined,
    module: moduleLabel,
    findings: findings.length ? findings : undefined,
  };
}
