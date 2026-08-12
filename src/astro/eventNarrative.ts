// Turn a computed EventAnalysis into a grounded request for the LLM.
//
// The model's job here is narration, not analysis. Everything it is allowed to
// say has already been worked out deterministically by eventAnalysis.ts from
// the prior in eventKaraka.ts; this only rewrites those findings as prose the
// reader can follow. It reuses the existing /api/llm/justify/stream endpoint,
// whose whole contract is "explain these supplied facts, cite only these
// supplied sources, invent nothing" — which is exactly what is wanted.
//
// The consequence worth stating plainly: turning the AI engine off costs the
// prose and nothing else. The reasons, the citations and the percentile are all
// still there, because the model never produced them.

import { EventAnalysis } from "./eventAnalysis";
import { EVENT_KARAKA_BY_ID, EventTypeId } from "./eventKaraka";

export interface Reference {
  source: string;
  text: string;
}

export interface EventNarrativeRequest {
  subject: string;
  basePrediction: string;
  facts: string[];
  references: Reference[];
  guidelines: string[];
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

const BAND_PHRASE: Record<EventAnalysis["band"], string> = {
  strong: "strongly indicated by the chart",
  moderate: "moderately indicated by the chart",
  weak: "only weakly indicated by the chart",
  unsupported: "not indicated by the chart",
};

/**
 * Keeps the prose honest about how good the evidence actually is. Without this
 * a weakly-indicated event still came back sounding like a triumph, because the
 * underlying endpoint is built to justify a prediction rather than to weigh one.
 */
const BAND_GUIDELINE: Record<EventAnalysis["band"], string> = {
  strong:
    "The chart supports this clearly. Say so, but stay measured — no grand claims.",
  moderate:
    "The support is real but partial. The tone must be qualified throughout, not confident.",
  weak:
    "The support is WEAK — barely better than a date picked at random. The reading must say " +
    "plainly that the chart does not particularly account for this event, and must not end on " +
    "a positive or reassuring note.",
  unsupported:
    "The chart does NOT account for this event. Say that directly, in the first sentence. " +
    "Explain what would have been expected and was missing. Do not manufacture a reading.",
};

export function buildEventNarrativeRequest(a: EventAnalysis): EventNarrativeRequest {
  const k = EVENT_KARAKA_BY_ID[a.type as EventTypeId];

  const facts: string[] = [
    `Event: ${k.label} on ${fmtDate(a.date)}.`,
    `Running periods on that date: ${a.mahadasha} Mahadasha` +
      (a.antardasha ? `, ${a.antardasha} Antardasha` : "") +
      (a.pratyantardasha ? `, ${a.pratyantardasha} Pratyantardasha` : "") + ".",
    `Classically this matter is read from the ${k.primaryHouses.map((h) => `${h}th`).join(" and ")} ` +
      `bhava, with ${k.karakas.join(" and ")} as karaka, in the ${k.varga} divisional chart.`,
    ...a.reasons.map((r) => r.text),
  ];

  // The percentile is the honest measure and the model must not round it up
  // into certainty, so it is stated as a fact and pinned by a guideline below.
  if (a.percentile !== null) {
    facts.push(
      `This date scores higher than ${a.percentile}% of random dates in the same life ` +
      `for this kind of event. A figure near 50 would mean the chart says nothing in particular.`,
    );
  }
  // Dissent goes in as fact too. A narration that quietly drops the parts that
  // do not fit is worse than no narration.
  for (const d of a.dissent) facts.push(`Counter-indication: ${d}`);

  // One reference per distinct source, the karaka basis first.
  const references: Reference[] = [{ source: k.source, text: k.basis }];
  const seen = new Set([k.source]);
  for (const r of a.reasons) {
    if (r.source && !seen.has(r.source)) {
      seen.add(r.source);
      references.push({ source: r.source, text: r.text });
    }
  }

  return {
    subject: `${k.label} on ${fmtDate(a.date)}`,
    basePrediction:
      `This event is ${BAND_PHRASE[a.band]}` +
      (a.percentile !== null ? ` (${a.percentile}th percentile against random dates)` : "") + ".",
    facts,
    references,
    guidelines: [
      "Explain, in plain prose, why classical Jyotisha reads this event in this period. " +
        "Work from the supplied facts only — do not introduce placements, yogas, transits " +
        "or dashas that are not listed.",
      "Lead with the dasha lords and what connects them to the bhava and karaka of this matter, " +
        "then the transit, then anything else.",
      a.dissent.length
        ? "State the counter-indications too. Do not smooth them away."
        : "If the evidence is thin, say so rather than padding it out.",
      // The shared endpoint's system prompt asks for an "enhanced, personalised
      // prediction" in the second paragraph — right for Justify, wrong here.
      // Left alone it produced "strong potential for intellectual growth" for an
      // event the engine had rated at the 44th percentile, i.e. chance.
      "This event has ALREADY HAPPENED. Do not predict, do not forecast, and do not " +
        "write anything encouraging about what may follow. Explain the period as it was.",
      BAND_GUIDELINE[a.band],
      "Never say the chart caused the event. This is a traditional reading of the period, " +
        "not a claim of cause, and it has not been validated against evidence.",
      "No headings, no bullet points, no markdown. Two short paragraphs at most.",
    ],
  };
}
