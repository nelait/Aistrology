import { useEffect, useMemo, useState } from "react";
import { Chart } from "../astro/types";
import { GRAHA_BY_NAME, RASHIS } from "../astro/constants";
import {
  planetReading,
  houseReading,
  personalitySketch,
  moonNakshatraSummary,
  ordinal,
} from "../astro/interpret";
import { detectYogas } from "../astro/yogas";
import { planetReferences, yogaReferences, houseReferences } from "../astro/references";
import { interpretVarga, LIFE_AREA_ORDER, LIFE_AREA_LABEL } from "../astro/vargaInterpret";
import { Varga } from "../astro/varga";
import Justify from "./Justify";
import { ScopeBadge } from "./ScopeBadge";
import { useTranslation } from "../i18n/TranslationProvider";

interface Props {
  chart: Chart;
  onOpenVarga?: (v: Varga) => void;
}

function toneClass(tone: string): string {
  return tone === "Favourable" ? "favorable" : tone === "Challenging" ? "challenging" : "mixed";
}

export default function Predictions({ chart, onOpenVarga }: Props) {
  const [view, setView] = useState<"overview" | "planets" | "houses" | "yogas">("overview");
  const yogas = detectYogas(chart);
  const { t, ensure, active } = useTranslation();

  // Divisional-chart summary for each life area.
  const lifeAreas = useMemo(
    () => LIFE_AREA_ORDER.map((v) => interpretVarga(chart, v)),
    [chart],
  );

  // Register this section's reading strings for translation.
  const strings = useMemo(() => {
    const set = new Set<string>();
    personalitySketch(chart).forEach((s) => set.add(s));
    set.add(moonNakshatraSummary(chart));
    chart.planets.forEach((p) => {
      const r = planetReading(chart, p);
      set.add(r.strength);
      set.add(r.detail);
    });
    for (let h = 1; h <= 12; h++) {
      const r = houseReading(chart, h);
      set.add(r.meaning);
      set.add(r.verdict);
      set.add(r.lordPlacement);
    }
    yogas.forEach((y) => {
      set.add(y.description);
      set.add(y.effect);
    });
    lifeAreas.forEach((r) => set.add(r.lines[r.lines.length - 1]));
    return [...set];
  }, [chart, yogas, lifeAreas]);

  useEffect(() => {
    if (active) ensure(strings);
  }, [active, ensure, strings]);

  return (
    <div className="predictions">
      <div className="subtabs">
        {(["overview", "planets", "houses", "yogas"] as const).map((v) => (
          <button
            key={v}
            className={view === v ? "active" : ""}
            onClick={() => setView(v)}
          >
            {v === "overview" ? "Overview" : v === "planets" ? "Grahas" : v === "houses" ? "Bhavas" : `Yogas (${yogas.length})`}
          </button>
        ))}
      </div>

      <p className="scope-legend muted small">
        <ScopeBadge scope="general" /> readings in this section are drawn from your fixed
        natal chart, so they hold throughout life. For time-specific predictions —{" "}
        <ScopeBadge scope="timing" /> — see the <b>Dasha</b>, <b>Transit</b> and{" "}
        <b>Forecast</b> tabs.
      </p>

      {view === "overview" && (
        <div className="cards">
          <div className="card highlight">
            <h3>Who you are — the three pillars</h3>
            <p className="note">
              Vedic astrology reads personality from three points: the rising sign (body & approach),
              the Moon sign (mind & emotion — considered primary), and the Sun sign (soul & purpose).
            </p>
            {personalitySketch(chart).map((line, i) => (
              <p key={i} className="pillar">{t(line)}</p>
            ))}
          </div>
          <div className="card">
            <h3>Your birth star (Janma Nakshatra)</h3>
            <p>{t(moonNakshatraSummary(chart))}</p>
          </div>

          <div className="card life-areas">
            <h3>Life areas at a glance <span className="muted small">· divisional charts</span></h3>
            <p className="note">
              Each divisional chart magnifies one area of life. Here is the tone of each from your
              chart — open one for the full reading (Kundli tab → pick a D-chart, or click a row below).
            </p>
            <ul className="life-area-list">
              {lifeAreas.map((r) => (
                <li
                  key={r.varga}
                  className={`life-area ${toneClass(r.tone)} ${onOpenVarga ? "clickable" : ""}`}
                  onClick={() => onOpenVarga?.(r.varga)}
                >
                  <span className="la-label">
                    {LIFE_AREA_LABEL[r.varga]} <span className="muted">({r.varga})</span>
                  </span>
                  <span className={`tone-badge ${toneClass(r.tone)}`}>{r.tone}</span>
                  <span className="la-verdict muted small">
                    {t(r.lines[r.lines.length - 1])}
                  </span>
                </li>
              ))}
            </ul>
            <Justify
              subject="Life-areas overview across the divisional charts (marriage, career, children, wealth, siblings, parents)"
              basePrediction={lifeAreas
                .map((r) => `${LIFE_AREA_LABEL[r.varga]}: ${r.tone}. ${r.lines[r.lines.length - 1]}`)
                .join(" ")}
              facts={lifeAreas.flatMap((r) => r.facts)}
              references={lifeAreas.flatMap((r) => r.references)}
              guidelines={[
                "IMPORTANT — For each divisional chart (D2–D12), check the D1 (Rāśi) chart first: each varga acts as a micro-zoom on the D1's relevant house. The D1 dictates the baseline potential; the varga shows how it is expressed. Begin the analysis of each life-area by stating what the D1 promises, then show how the varga confirms, refines or modifies that promise.",
                "IMPORTANT — Observe the current Mahadasha/Antardasha: identify which planet's planetary period is currently running, find that planet in each varga chart, and explain how its placement and dignity in that varga determines how the life-area behaves during this specific timeframe.",
              ]}
            />
          </div>

          <div className="card">
            <h3>How to read the rest of this section</h3>
            <p className="note">
              The <b>Grahas</b> tab explains what each planet is doing in your chart and why it is
              strong or tested. The <b>Bhavas</b> tab reads each area of life. The <b>Yogas</b> tab
              lists special combinations. Every statement is derived from the placements in your
              chart — nothing is generic.
            </p>
          </div>
        </div>
      )}

      {view === "planets" && (
        <div className="cards">
          {chart.planets.map((p) => {
            const r = planetReading(chart, p);
            const g = GRAHA_BY_NAME[p.planet];
            const grounding = planetReferences(chart, p);
            return (
              <div className="card planet-card" key={p.planet}>
                <h3>
                  <span className="glyph">{g.symbol}</span> {p.planet}{" "}
                  <span className="muted">· {r.headline}</span>
                  <ScopeBadge scope="general" />
                </h3>
                <p className="strength-line">{t(r.strength)}</p>
                <p>{t(r.detail)}</p>
                <Justify
                  subject={`${p.planet} in ${RASHIS[p.signIndex].name} (${ordinal(p.house)} house)`}
                  basePrediction={`${r.strength} ${r.detail}`}
                  facts={grounding.facts}
                  references={grounding.references}
                />
              </div>
            );
          })}
        </div>
      )}

      {view === "houses" && (
        <div className="cards">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => {
            const r = houseReading(chart, h);
            return (
              <div className="card house-card" key={h}>
                <h3>
                  {h}. {r.name}{" "}
                  <span className="muted">· {RASHIS[chart.houseSigns[h - 1]].name}</span>
                  <ScopeBadge scope="general" />
                </h3>
                <p className="meaning">{t(r.meaning)}</p>
                <p className="verdict">{t(r.verdict)}</p>
                <p className="muted small">
                  {r.occupants.length > 0 && (
                    <>Occupied by <b>{r.occupants.join(", ")}</b>. </>
                  )}
                  {r.aspectedBy.length > 0 && (
                    <>Aspected by <b>{r.aspectedBy.join(", ")}</b>. </>
                  )}
                  {t(r.lordPlacement)}
                </p>
                <Justify
                  subject={`${h}. ${r.name} (${RASHIS[chart.houseSigns[h - 1]].name})`}
                  basePrediction={`${r.meaning} ${r.verdict}`}
                  facts={houseReferences(chart, h).facts}
                  references={houseReferences(chart, h).references}
                />
              </div>
            );
          })}
        </div>
      )}

      {view === "yogas" && (
        <div className="cards">
          {yogas.length === 0 && (
            <div className="card">
              <p>No yogas from the app's curated set are present in this chart. That is common — the
              thousands of classical yogas are rarer than they sound, and a chart's strength rests
              mainly on planetary dignity, house placement and the dasha sequence.</p>
            </div>
          )}
          {yogas.map((y) => (
            <div className={`card yoga-card ${y.category.toLowerCase()}`} key={y.name}>
              <h3>
                {y.name} {y.sanskrit && <span className="sanskrit">{y.sanskrit}</span>}
                <span className={`badge ${y.category.toLowerCase()}`}>{y.category}</span>
                <ScopeBadge scope="general" />
              </h3>
              <p className="how"><b>How it forms:</b> {t(y.description)}</p>
              <p className="effect"><b>What it gives:</b> {t(y.effect)}</p>
              <Justify
                subject={y.name}
                basePrediction={y.effect}
                facts={yogaReferences(y).facts}
                references={yogaReferences(y).references}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
