// Interpret a divisional chart for the life-area it governs. Each varga is read
// like a chart in its own right for its domain: its Lagna, the key house(s) for
// that domain, that house's lord, and the natural significator (karaka). The
// result is a plain-language reading — e.g. what the D9 says about marriage.

import { PlanetName, RASHIS } from "./constants";
import { Chart } from "./types";
import { signDignity, naturalRelation } from "./dignity";
import { aspectedSigns } from "./aspects";
import { ordinal, houseReading } from "./interpret";
import { computeVimshottari, activePeriod } from "./dasha";
import { birthDateUT } from "./engine";
import { divisionalSign, Varga, VARGA_BY_CODE } from "./varga";
import { Reference } from "./references";

export type VargaTone = "Favourable" | "Mixed" | "Challenging";

// The life-areas shown in the "at a glance" summaries (order + compact labels).
export const LIFE_AREA_ORDER: Varga[] = ["D9", "D10", "D7", "D2", "D3", "D12"];
export const LIFE_AREA_LABEL: Record<string, string> = {
  D9: "Marriage & spouse",
  D10: "Career & status",
  D7: "Children",
  D2: "Wealth",
  D3: "Siblings & courage",
  D12: "Parents",
};

export interface VargaReading {
  varga: Varga;
  domain: string; // e.g. "marriage, the spouse and dharma"
  lagnaSign: number; // the varga's ascendant sign
  tone: VargaTone;
  headline: string;
  lines: string[];
  facts: string[]; // for LLM grounding
  references: Reference[];
}

const BENEFICS: PlanetName[] = ["Jupiter", "Venus", "Moon", "Mercury"];

interface DomainCfg {
  domain: string;
  houses: { n: number; label: string }[];
  karakas: PlanetName[];
}

const DOMAIN: Record<Exclude<Varga, "D1" | "D2">, DomainCfg> = {
  D3: { domain: "siblings, courage and initiative", houses: [{ n: 3, label: "3rd (siblings & courage)" }], karakas: ["Mars"] },
  D7: { domain: "children and progeny", houses: [{ n: 5, label: "5th (children)" }], karakas: ["Jupiter"] },
  D9: { domain: "marriage, the spouse and dharma", houses: [{ n: 7, label: "7th (spouse & marriage)" }], karakas: ["Venus", "Jupiter"] },
  D10: { domain: "career, work and public standing", houses: [{ n: 10, label: "10th (career)" }], karakas: ["Sun", "Saturn", "Mercury"] },
  D12: { domain: "parents and ancestry", houses: [{ n: 4, label: "4th (mother)" }, { n: 9, label: "9th (father)" }], karakas: ["Sun", "Moon"] },
  D4: { domain: "home, land and fixed property", houses: [{ n: 4, label: "4th (home & land)" }], karakas: ["Mars", "Venus"] },
  D16: { domain: "vehicles and material comforts", houses: [{ n: 4, label: "4th (conveyances)" }], karakas: ["Venus"] },
  D24: { domain: "learning, education and skill", houses: [{ n: 4, label: "4th (schooling)" }, { n: 5, label: "5th (intellect)" }], karakas: ["Mercury", "Jupiter"] },
  D30: { domain: "misfortune, illness and hidden weakness", houses: [{ n: 6, label: "6th (disease)" }, { n: 8, label: "8th (chronic ills)" }], karakas: ["Mars", "Saturn"] },
  D60: { domain: "the accumulated weight of past karma", houses: [{ n: 1, label: "1st (the self)" }], karakas: ["Saturn"] },
};

const KARAKA_ROLE: Partial<Record<PlanetName, string>> = {
  Venus: "the spouse and marital happiness",
  Jupiter: "the husband, children and wisdom",
  Mars: "siblings, drive and courage",
  Sun: "the father, authority and status",
  Moon: "the mother and the nurturing bond",
  Saturn: "work, discipline and endurance",
  Mercury: "intellect, skill and commerce",
};

const BPHS_REF = "Brihat Parashara Hora Shastra";

const REF: Record<Varga, Reference> = {
  D4: { source: BPHS_REF, text: "The Chaturthāṁśa (D4) is examined for the home, land and fixed property — each sign quartered, the parts falling on the kendras from it." },
  D16: { source: BPHS_REF, text: "The Ṣoḍaśāṁśa (D16) is read for conveyances and material comforts, and for the happiness they actually bring; Venus is its karaka." },
  D24: { source: BPHS_REF, text: "The Siddhāṁśa (D24) is the chart of learning and acquired skill, counted from Leo in odd signs and Cancer in even." },
  D30: { source: BPHS_REF, text: "The Triṁśāṁśa (D30) is read for evils, disease and hidden weakness. It alone is divided unequally, among the five grahas other than the luminaries." },
  D60: { source: BPHS_REF, text: "Parashara weights the Ṣaṣṭyāṁśa (D60) above the other vargas in judging a graha's real quality, it being the sum of past karma; at 30' a part it is also the traditional means of rectifying an uncertain birth time." },
  D1: { source: "Brihat Parashara Hora Shastra", text: "The Rāśi (D1) is the primary chart; every area of life is first seen here and then refined in the relevant divisional chart." },
  D2: { source: "Brihat Parashara Hora Shastra", text: "The Horā (D2) shows wealth: planets in the Sun's horā (Leo) give it through effort and enterprise; in the Moon's horā (Cancer) through nurturing, others and liquid means." },
  D3: { source: "Brihat Parashara Hora Shastra", text: "The Drekkāṇa (D3) is examined for co-borns, courage and self-effort — chiefly the 3rd house and Mars." },
  D7: { source: "Brihat Parashara Hora Shastra", text: "Children are seen from the 5th house of the Saptāṁśa (D7) and from Jupiter, the karaka of progeny." },
  D9: { source: "Brihat Parashara Hora Shastra", text: "The Navāṁśa (D9) reveals the spouse and married life through its Lagna, the 7th house and its lord, and Venus (Jupiter for the husband)." },
  D10: { source: "Brihat Parashara Hora Shastra", text: "The Daśāṁśa (D10 / Karmāṁśa) shows profession and status through the 10th house, its lord, and the strongest planet placed there." },
  D12: { source: "Brihat Parashara Hora Shastra", text: "The Dvādaśāṁśa (D12) shows the parents — the 4th house and Moon for the mother, the 9th and Sun for the father." },
};

interface VP {
  planet: PlanetName;
  signIndex: number;
  house: number;
  dignity: ReturnType<typeof signDignity>;
}

function toneFrom(score: number): VargaTone {
  if (score >= 1) return "Favourable";
  if (score <= -1) return "Challenging";
  return "Mixed";
}

function dignityPhrase(d: ReturnType<typeof signDignity>): string {
  return d === "Exalted"
    ? "exalted and very strong"
    : d === "Debilitated"
      ? "debilitated and tested"
      : d === "Own sign"
        ? "in its own sign and comfortable"
        : "neutrally placed";
}

/** The Mahadasha (and Antardasha) lord running on `now`, if any. */
function currentDasha(chart: Chart, now: Date): { maha?: PlanetName; antar?: PlanetName } {
  const moonLon = chart.planets.find((p) => p.planet === "Moon")!.longitude;
  const timeline = computeVimshottari(moonLon, birthDateUT(chart.birth), 120, 2);
  const maha = activePeriod(timeline, now);
  const antar = maha?.children ? activePeriod(maha.children, now) : undefined;
  return { maha: maha?.lord, antar: antar?.lord };
}

/**
 * Read a divisional chart for the life-area it governs, following the classical
 * method: (1) check the D1 baseline for that area first — the varga is a
 * micro-zoom that shows how the D1's potential is expressed; (2) note the
 * currently-running dasha lord's position in the varga, which times when and how
 * the area activates.
 */
export function interpretVarga(chart: Chart, varga: Varga, now: Date = new Date()): VargaReading {
  const info = VARGA_BY_CODE[varga];
  const lagnaSign = divisionalSign(chart.ascendant, varga);
  const vps: VP[] = chart.planets.map((p) => {
    const signIndex = divisionalSign(p.longitude, varga);
    return {
      planet: p.planet,
      signIndex,
      house: ((signIndex - lagnaSign + 12) % 12) + 1,
      dignity: signDignity(p.planet, signIndex),
    };
  });
  const houseSigns = Array.from({ length: 12 }, (_, h) => (lagnaSign + h) % 12);
  const by = (n: PlanetName) => vps.find((v) => v.planet === n)!;

  // --- D1: point to the main reading ---
  if (varga === "D1") {
    return {
      varga, domain: "your life as a whole", lagnaSign, tone: "Mixed",
      headline: `The Rāśi (D1) with ${RASHIS[lagnaSign].name} rising is your whole birth chart.`,
      lines: [
        `The Rāśi is the foundation chart — body, mind and the overall shape of life. Its detailed graha, bhava and yoga readings are in the Predictions tab; the other divisional charts magnify a single area of it.`,
      ],
      facts: [`The D1 Lagna is ${RASHIS[lagnaSign].name}.`],
      references: [REF.D1],
    };
  }

  // --- D2 (Horā): wealth by Sun's vs Moon's horā ---
  if (varga === "D2") {
    const inSun = vps.filter((v) => v.signIndex === 4).length; // Leo
    const inMoon = vps.filter((v) => v.signIndex === 3).length; // Cancer
    const tone: VargaTone = "Mixed";
    const lean =
      inSun > inMoon
        ? `More grahas fall in the Sun's horā (${inSun} vs ${inMoon}): wealth tends to come through your own effort, enterprise and initiative, and is held with a steady, self-made quality.`
        : inMoon > inSun
          ? `More grahas fall in the Moon's horā (${inMoon} vs ${inSun}): wealth tends to come through nurturing, relationships and others, and is more fluid — savings, liquids, trade and support.`
          : `Grahas are balanced between the Sun's and Moon's horā (${inSun} each): wealth flows both from self-effort and from others, in phases.`;
    const d1wealth = houseReading(chart, 2);
    const { maha: wMaha, antar: wAntar } = currentDasha(chart, now);
    const wealthLines = [
      `First the baseline: in your Rāśi (D1) the 2nd house sets your capacity for wealth — ${d1wealth.verdict} The Horā (D2) then shows how you gather and hold it.`,
      lean,
    ];
    const wealthFacts = [
      `D1 baseline — the 2nd house of the Rāśi (wealth): ${d1wealth.verdict}`,
      `In the D2, ${inSun} graha(s) are in the Sun's horā (Leo) and ${inMoon} in the Moon's horā (Cancer).`,
    ];
    if (wMaha) {
      wealthLines.push(
        `Timing: you are currently running the ${wMaha} Mahadasha${wAntar && wAntar !== wMaha ? ` (${wAntar} Antardasha)` : ""}, which colours how wealth flows in this period.`,
      );
      wealthFacts.push(`Current period: ${wMaha} Mahadasha${wAntar ? ` / ${wAntar} Antardasha` : ""} — activates wealth themes now.`);
    }
    return {
      varga, domain: "wealth and resources", lagnaSign, tone,
      headline: `The Horā (D2) shows how you gather and hold wealth.`,
      lines: wealthLines,
      facts: wealthFacts,
      references: [REF.D2],
    };
  }

  // --- Standard house + karaka reading (D3, D7, D9, D10, D12) ---
  const cfg = DOMAIN[varga as Exclude<Varga, "D1" | "D2">];
  const lines: string[] = [];
  const facts: string[] = [`The ${varga} Lagna is ${RASHIS[lagnaSign].name}.`];
  let score = 0;

  lines.push(
    `Your ${info.name} (${varga}) Lagna is ${RASHIS[lagnaSign].name} — the lens through which ${cfg.domain} is seen.`,
  );

  // Guideline 1 — check the D1 baseline first. The varga zooms into the same
  // house of the Rāśi; the D1 sets the potential, the varga shows its expression.
  for (const h of cfg.houses) {
    const d1 = houseReading(chart, h.n);
    if (d1.verdict.startsWith("Well-supported")) score += 1;
    if (d1.verdict.startsWith("Tested")) score -= 1;
    lines.push(
      `First the baseline: in your Rāśi (D1) the ${ordinal(h.n)} house sets the potential for this area — ${d1.verdict} The ${varga} then shows how you express that.`,
    );
    facts.push(
      `D1 baseline — the ${ordinal(h.n)} house of the Rāśi: ${d1.verdict}${d1.occupants.length ? ` Occupied by ${d1.occupants.join(", ")}.` : ""} Its lord ${d1.lord} ${d1.lordPlacement}`,
    );
  }

  for (const h of cfg.houses) {
    const houseSign = houseSigns[h.n - 1];
    const occupants = vps.filter((v) => v.house === h.n);
    const aspecting = vps.filter(
      (v) => v.house !== h.n && aspectedSigns(v.planet, v.signIndex).includes(houseSign),
    );
    const benefic = [...occupants, ...aspecting].filter((v) => BENEFICS.includes(v.planet)).length;
    const malefic = occupants.length + aspecting.length - benefic;
    score += benefic - malefic;

    const lord = RASHIS[houseSign].lord as PlanetName;
    const lordPos = by(lord);
    const occ = occupants.length ? `occupied by ${occupants.map((v) => v.planet).join(", ")}, ` : "";
    const asp = aspecting.length ? `aspected by ${aspecting.map((v) => v.planet).join(", ")}, ` : "";
    const verdict =
      benefic > malefic
        ? "benefic support here is a good sign for this area."
        : malefic > benefic
          ? "malefic pressure here asks for effort and patience in this area."
          : occupants.length + aspecting.length === 0
            ? "it works mainly through its lord."
            : "mixed influences give results in phases.";

    lines.push(
      `The ${h.label} of the ${varga} is ${RASHIS[houseSign].name}, ${occ}${asp}with its lord ${lord} in the ${ordinal(lordPos.house)} — ${verdict}`,
    );
    facts.push(
      `In the ${varga}, the ${h.label} is ${RASHIS[houseSign].name}${occupants.length ? `, occupied by ${occupants.map((v) => v.planet).join(", ")}` : ""}; its lord ${lord} is in the ${ordinal(lordPos.house)}.`,
    );
  }

  // Karaka(s)
  for (const k of cfg.karakas) {
    const kp = by(k);
    if (kp.dignity === "Exalted" || kp.dignity === "Own sign") score += 1;
    if (kp.dignity === "Debilitated") score -= 1;
    lines.push(
      `${k} (karaka of ${KARAKA_ROLE[k]}) is in ${RASHIS[kp.signIndex].name} in the ${ordinal(kp.house)} of the ${varga}, ${dignityPhrase(kp.dignity)}.`,
    );
    facts.push(`In the ${varga}, ${k} (karaka of ${KARAKA_ROLE[k]}) is ${kp.dignity} in ${RASHIS[kp.signIndex].name}.`);
  }

  // Guideline 2 — the running dasha lord's placement in this varga times how the
  // area behaves during the current period.
  const { maha, antar } = currentDasha(chart, now);
  if (maha) {
    const mp = by(maha);
    const emphasis =
      mp.dignity === "Exalted" || mp.dignity === "Own sign"
        ? " — strongly, and favourably"
        : mp.dignity === "Debilitated"
          ? " — but with tests to work through"
          : "";
    lines.push(
      `Timing: you are currently running the ${maha} Mahadasha${antar && antar !== maha ? ` (${antar} Antardasha)` : ""}. In this ${varga}, ${maha} sits in ${RASHIS[mp.signIndex].name} in the ${ordinal(mp.house)}, ${dignityPhrase(mp.dignity)} — so ${cfg.domain} is activated during this period${emphasis}.`,
    );
    facts.push(
      `Current period: ${maha} Mahadasha${antar ? ` / ${antar} Antardasha` : ""}. In the ${varga}, ${maha} is ${mp.dignity} in ${RASHIS[mp.signIndex].name} (house ${mp.house}) — this timeframe activates ${cfg.domain}.`,
    );
  }

  const tone = toneFrom(score);
  const toneSentence =
    tone === "Favourable"
      ? `On balance the ${varga} is well-supported for ${cfg.domain} — a promising indication.`
      : tone === "Challenging"
        ? `On balance the ${varga} is tested for ${cfg.domain} — it asks for conscious effort and matures over time.`
        : `On balance the ${varga} is mixed for ${cfg.domain} — supportive and testing factors both operate, so results come in phases.`;
  lines.push(toneSentence);

  return {
    varga,
    domain: cfg.domain,
    lagnaSign,
    tone,
    headline: `What your ${info.name} (${varga}) says about ${cfg.domain}`,
    lines,
    facts,
    references: [REF[varga]],
  };
}
