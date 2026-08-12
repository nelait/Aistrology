import { describe, it, expect } from "vitest";
import { computeChart } from "./engine";
import { analyseEvent, dashaTreeFor } from "./eventAnalysis";
import { EVENT_KARAKAS, EVENT_KARAKA_BY_ID } from "./eventKaraka";
import { buildEventNarrativeRequest } from "./eventNarrative";
import { BirthData } from "./types";

const BIRTH: BirthData = {
  name: "Test",
  year: 1979, month: 3, day: 18,
  hour: 9, minute: 42, second: 0,
  tzOffsetHours: 5.5, latitude: 19.076, longitude: 72.877,
  placeLabel: "Mumbai",
};
const chart = computeChart(BIRTH);
const tree = dashaTreeFor(chart);

function analysisFor(type: (typeof EVENT_KARAKAS)[number]["id"], iso: string) {
  return analyseEvent(
    chart,
    { type, date: new Date(`${iso}T00:00:00Z`), precision: "exact", confidence: "sure" },
    { dashas: tree, nullSamples: 60 },
  );
}

describe("event narrative request", () => {
  const a = analysisFor("marriage", "2014-06-27");
  const req = buildEventNarrativeRequest(a);

  it("hands the model every computed reason as a fact", () => {
    for (const r of a.reasons) {
      expect(req.facts, `reason missing from facts: ${r.text}`).toContain(r.text);
    }
  });

  it("states the running periods and the classical basis", () => {
    expect(req.facts.some((f) => f.includes("Mahadasha"))).toBe(true);
    expect(req.facts.some((f) => f.includes("bhava") && f.includes("karaka"))).toBe(true);
  });

  it("carries the percentile through, and says what a middling one means", () => {
    const pctFact = req.facts.find((f) => f.includes("random dates"));
    expect(pctFact).toBeTruthy();
    expect(pctFact).toContain(String(a.percentile));
    // Without this the model is free to read 52% as a resounding yes.
    expect(pctFact).toMatch(/near 50/);
  });

  it("passes counter-indications through instead of dropping them", () => {
    // A narration that quietly omits what does not fit is worse than none.
    const withDissent = EVENT_KARAKAS
      .map((k) => analysisFor(k.id, "2003-11-04"))
      .find((x) => x.dissent.length > 0);
    expect(withDissent, "no dissenting analysis found to test with").toBeTruthy();
    const r = buildEventNarrativeRequest(withDissent!);
    for (const d of withDissent!.dissent) {
      expect(r.facts.some((f) => f.includes(d))).toBe(true);
    }
    expect(r.guidelines.some((g) => /counter-indications/i.test(g))).toBe(true);
  });

  it("supplies references with no duplicate sources", () => {
    const sources = req.references.map((r) => r.source);
    expect(new Set(sources).size).toBe(sources.length);
    // The karaka's own classical basis leads.
    expect(req.references[0].source).toBe(EVENT_KARAKA_BY_ID.marriage.source);
    expect(req.references[0].text).toBe(EVENT_KARAKA_BY_ID.marriage.basis);
  });

  it("forbids the model inventing anything the engine did not compute", () => {
    const joined = req.guidelines.join(" ");
    expect(joined).toMatch(/supplied facts only/i);
    expect(joined).toMatch(/do not introduce/i);
  });

  it("forbids claiming the chart caused the event", () => {
    // These readings cover bereavement, illness and accidents. The tone rule is
    // not decoration.
    expect(req.guidelines.join(" ")).toMatch(/never say the chart caused/i);
  });

  it("reflects the band honestly in the base prediction", () => {
    const strong = EVENT_KARAKAS
      .map((k) => analysisFor(k.id, "2014-06-27"))
      .find((x) => x.band === "strong");
    const weak = EVENT_KARAKAS
      .map((k) => analysisFor(k.id, "2014-06-27"))
      .find((x) => x.band === "weak" || x.band === "unsupported");
    if (strong) expect(buildEventNarrativeRequest(strong).basePrediction).toMatch(/strongly/i);
    if (weak) {
      const bp = buildEventNarrativeRequest(weak).basePrediction;
      expect(bp).toMatch(/weakly|not indicated/i);
      expect(bp).not.toMatch(/strongly/i);
    }
  });

  it("builds a request for every event type without throwing", () => {
    for (const k of EVENT_KARAKAS) {
      const r = buildEventNarrativeRequest(analysisFor(k.id, "2010-05-05"));
      expect(r.subject).toContain(k.label);
      expect(r.facts.length).toBeGreaterThan(2);
      expect(r.references.length).toBeGreaterThan(0);
    }
  });
});
