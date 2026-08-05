import { useEffect, useMemo } from "react";
import { Chart } from "../astro/types";
import { Varga, VARGA_BY_CODE, divisionalSign } from "../astro/varga";
import { interpretVarga, LIFE_AREA_LABEL } from "../astro/vargaInterpret";
import { computeVimshottari, activePeriod } from "../astro/dasha";
import { birthDateUT } from "../astro/engine";
import { RASHIS } from "../astro/constants";
import { signDignity } from "../astro/dignity";
import { ordinal } from "../astro/interpret";
import Justify from "./Justify";
import { useTranslation } from "../i18n/TranslationProvider";

interface Props {
  chart: Chart;
  varga: Varga;
}

function toneClass(t: string): string {
  return t === "Favourable" ? "favorable" : t === "Challenging" ? "challenging" : "mixed";
}

/**
 * Build explicit analytical guidelines for D-chart justifications following the
 * two classical rules:
 * 1. Check the D1 chart first — the varga is a micro-zoom on the D1's relevant
 *    house; D1 dictates the baseline potential, the varga shows how it expresses.
 * 2. Observe the current Mahadasha/Antardasha lord's placement in this varga —
 *    this times how the life-area behaves during the running period.
 */
function buildVargaGuidelines(chart: Chart, varga: Varga): string[] {
  if (varga === "D1") return []; // No cross-reference needed for the Rāśi itself.

  const info = VARGA_BY_CODE[varga];
  const guidelines: string[] = [];
  const area = LIFE_AREA_LABEL[varga] ?? info.signifies;

  // Guideline 1: D1 baseline cross-reference
  guidelines.push(
    `IMPORTANT — Check the D1 (Rāśi) chart first: the ${info.name} (${varga}) acts as a micro-zoom on the D1's relevant house for ${area}. A strong ${varga} shows how the native expresses their potential in this area, but the D1 dictates what that baseline potential is. Always begin your analysis by stating what the D1 promises for this area, then show how the ${varga} confirms, refines or modifies that promise.`,
  );

  // Guideline 2: Current Mahadasha/Antardasha lord placement
  const moonLon = chart.planets.find((p) => p.planet === "Moon")!.longitude;
  const timeline = computeVimshottari(moonLon, birthDateUT(chart.birth), 120, 2);
  const now = new Date();
  const maha = activePeriod(timeline, now);
  const antar = maha?.children ? activePeriod(maha.children, now) : undefined;

  if (maha) {
    const lagnaSign = divisionalSign(chart.ascendant, varga);
    const mahaLon = chart.planets.find((p) => p.planet === maha.lord)!.longitude;
    const mahaSign = divisionalSign(mahaLon, varga);
    const mahaHouse = ((mahaSign - lagnaSign + 12) % 12) + 1;
    const mahaDig = signDignity(maha.lord, mahaSign);

    let dashaNote = `IMPORTANT — Observe the current Mahadasha/Antardasha: the native is running the ${maha.lord} Mahadasha`;
    if (antar && antar.lord !== maha.lord) {
      dashaNote += ` with ${antar.lord} Antardasha`;
    }
    dashaNote += `. In this ${varga} chart, ${maha.lord} sits in ${RASHIS[mahaSign].name} in the ${ordinal(mahaHouse)}, where it is ${mahaDig}. Explain how ${area} will behave during this specific timeframe based on that placement and dignity.`;

    if (antar && antar.lord !== maha.lord) {
      const antarLon = chart.planets.find((p) => p.planet === antar.lord)!.longitude;
      const antarSign = divisionalSign(antarLon, varga);
      const antarHouse = ((antarSign - lagnaSign + 12) % 12) + 1;
      const antarDig = signDignity(antar.lord, antarSign);
      dashaNote += ` The sub-period lord ${antar.lord} is in ${RASHIS[antarSign].name} in the ${ordinal(antarHouse)} (${antarDig}) — factor in how it colours ${area} right now.`;
    }

    guidelines.push(dashaNote);
  }

  return guidelines;
}

// Reads the selected divisional chart for the life-area it governs and explains
// it — e.g. what the D9 says about marriage. Includes a Justify (AI) button
// that now passes explicit D-chart analysis guidelines to the LLM.
export default function VargaReadingPanel({ chart, varga }: Props) {
  const reading = useMemo(() => interpretVarga(chart, varga), [chart, varga]);
  const guidelines = useMemo(() => buildVargaGuidelines(chart, varga), [chart, varga]);
  const { t, ensure, active } = useTranslation();

  useEffect(() => {
    if (active) ensure(reading.lines);
  }, [active, ensure, reading]);

  return (
    <div className={`card varga-reading ${toneClass(reading.tone)}`}>
      <div className="varga-reading-head">
        <h3>{reading.headline}</h3>
        <span className={`tone-badge ${toneClass(reading.tone)}`}>{reading.tone}</span>
      </div>
      {reading.lines.map((line, i) => (
        <p key={i} className="varga-reading-line">{t(line)}</p>
      ))}

      <details className="varga-refs">
        <summary>Classical basis</summary>
        <ul className="refs">
          {reading.references.map((r, i) => (
            <li key={i}>
              <span className="ref-source">{r.source}</span>
              <span className="ref-text">{r.text}</span>
            </li>
          ))}
        </ul>
      </details>

      <Justify
        subject={`${varga} — ${reading.domain}`}
        basePrediction={reading.lines.join(" ")}
        facts={reading.facts}
        references={reading.references}
        guidelines={guidelines}
      />
    </div>
  );
}

