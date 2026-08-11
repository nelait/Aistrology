import { useEffect, useMemo, useState } from "react";
import { Chart } from "../astro/types";
import { GRAHA_BY_NAME, RASHIS, NAKSHATRAS } from "../astro/constants";
import {
  planetReading,
  houseReading,
  personalitySketch,
  moonNakshatraSummary,
  dashaOutlook,
  ordinal,
} from "../astro/interpret";
import { detectYogas } from "../astro/yogas";
import { computeVimshottari, activePeriod } from "../astro/dasha";
import { birthDateUT } from "../astro/engine";
import { importantEvents } from "../astro/events";
import { formatDegInSign, formatDate, formatTz } from "../utils/format";
import { useTranslation } from "../i18n/TranslationProvider";
import { useLanguage } from "../i18n/LanguageProvider";
import { Varga, VARGA_BY_CODE, DISPLAYED_VARGAS } from "../astro/varga";
import { interpretVarga, LIFE_AREA_ORDER, LIFE_AREA_LABEL } from "../astro/vargaInterpret";
import NorthChart from "./NorthChart";
import SouthChart from "./SouthChart";
import { api } from "../api/client";

interface Props {
  chart: Chart;
  open: boolean;
  onClose: () => void;
  style: "north" | "south";
  mode: Varga;
  /** When true (free plan), the report is shown blurred as a teaser and the
   *  PDF export is replaced with an upgrade prompt. */
  locked?: boolean;
}

// A print-friendly report of the chart + predictions, including the chart diagram
// (in the chosen North/South style and divisional chart). "Save as PDF" from the
// browser's print dialog produces the PDF. When a translation language is active,
// the reading text renders translated.
export default function ExportReport({ chart, open, onClose, style, mode, locked = false }: Props) {
  const { t, ensure, active } = useTranslation();
  const { language, isEnglish } = useLanguage();
  const [allVargas, setAllVargas] = useState(false);
  const [upgradeBusy, setUpgradeBusy] = useState(false);

  const handleUpgrade = async (plan: "pro" | "premium") => {
    setUpgradeBusy(true);
    try {
      const { url } = await api.createCheckout(plan);
      if (url) window.location.href = url;
    } catch {
      /* surfaced via billing view; keep the preview open */
    } finally {
      setUpgradeBusy(false);
    }
  };

  const ChartFor = ({ v }: { v: Varga }) =>
    style === "south" ? <SouthChart chart={chart} mode={v} /> : <NorthChart chart={chart} mode={v} />;

  const report = useMemo(() => {
    if (!open) return null;
    const now = new Date();
    const timeline = computeVimshottari(
      chart.planets.find((p) => p.planet === "Moon")!.longitude,
      birthDateUT(chart.birth),
      120,
      2,
    );
    const maha = activePeriod(timeline, now);
    const antar = maha?.children ? activePeriod(maha.children, now) : undefined;
    const mahaOutlook = maha ? dashaOutlook(chart, maha.lord) : "";
    const personality = personalitySketch(chart);
    const nakshatra = moonNakshatraSummary(chart);
    const planets = chart.planets.map((p) => ({ pos: p, r: planetReading(chart, p) }));
    const houses = Array.from({ length: 12 }, (_, i) => houseReading(chart, i + 1));
    const yogas = detectYogas(chart);
    const events = importantEvents(chart, { spanYears: 90 }).filter((e) => e.date <= now).slice(-4);
    const vargaReadings = Object.fromEntries(
      DISPLAYED_VARGAS.map((v) => [v.code, interpretVarga(chart, v.code)]),
    ) as Record<Varga, ReturnType<typeof interpretVarga>>;

    const strings = [
      ...personality,
      nakshatra,
      mahaOutlook,
      ...planets.flatMap(({ r }) => [r.strength, r.detail]),
      ...houses.flatMap((r) => [r.meaning, r.verdict, r.lordPlacement]),
      ...yogas.flatMap((y) => [y.description, y.effect]),
      ...Object.values(vargaReadings).flatMap((r) => r.lines),
    ].filter(Boolean);

    return { now, maha, antar, mahaOutlook, personality, nakshatra, planets, houses, yogas, events, vargaReadings, strings };
  }, [chart, open]);

  useEffect(() => {
    if (report && active) ensure(report.strings);
  }, [report, active, ensure]);

  if (!open || !report) return null;
  const b = chart.birth;
  const { maha, antar, mahaOutlook, personality, nakshatra, planets, houses, yogas, events, vargaReadings } = report;

  const positionsTable = (
    <table className="report-table">
      <thead>
        <tr><th>Graha</th><th>Sign</th><th>Degree</th><th>Ho.</th><th>Nakshatra</th><th>Dignity</th></tr>
      </thead>
      <tbody>
        {planets.map(({ pos: p }) => (
          <tr key={p.planet}>
            <td>{GRAHA_BY_NAME[p.planet].symbol} {p.planet}{p.retrograde ? " ℞" : ""}</td>
            <td>{RASHIS[p.signIndex].name}</td>
            <td>{formatDegInSign(p.degreeInSign)}</td>
            <td>{p.house}</td>
            <td>{NAKSHATRAS[p.nakshatraIndex].name} (p{p.pada})</td>
            <td>{p.dignity}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="export-overlay" onClick={onClose}>
      <div className="export-shell" onClick={(e) => e.stopPropagation()}>
        <div className="export-actions">
          <div className="export-opts">
            <span className="muted small">Charts:</span>
            <div className="toggle">
              <button className={!allVargas ? "on" : ""} onClick={() => setAllVargas(false)}>
                {VARGA_BY_CODE[mode].code} only
              </button>
              <button className={allVargas ? "on" : ""} onClick={() => setAllVargas(true)}>
                All D1–D12
              </button>
            </div>
          </div>
          <div>
            {locked ? (
              <button className="primary locked-print" onClick={() => handleUpgrade("pro")} disabled={upgradeBusy}>
                🔒 Upgrade to export
              </button>
            ) : (
              <button className="primary" onClick={() => window.print()}>Print / Save as PDF</button>
            )}
            <button className="ghost" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="export-report-area">
          {locked && (
            <div className="export-lock">
              <div className="export-lock-card">
                <div className="export-lock-icon">🔒</div>
                <h3>Your full report is ready</h3>
                <p>
                  This is a live preview of your chart &amp; predictions PDF. Upgrade to a paid plan
                  to unlock a clean, printable export — with all divisional charts, planet-by-planet
                  readings, yogas and your current dasha.
                </p>
                <div className="export-lock-actions">
                  <button className="btn-plan-upgrade" onClick={() => handleUpgrade("pro")} disabled={upgradeBusy}>
                    Upgrade to Pro — ₹499/mo
                  </button>
                  <button className="btn-plan-upgrade premium" onClick={() => handleUpgrade("premium")} disabled={upgradeBusy}>
                    Go Premium — ₹999/mo
                  </button>
                </div>
              </div>
            </div>
          )}
        <div
          className={`chart-report${locked ? " locked" : ""}`}
          aria-hidden={locked || undefined}
          lang={active && !isEnglish ? language.code : undefined}
        >
          <header className="report-head">
            <h1>☸ Aistrology — Birth Chart Report</h1>
            <p className="report-native">
              <strong>{b.name}</strong> · {String(b.day).padStart(2, "0")}/
              {String(b.month).padStart(2, "0")}/{b.year} ·{" "}
              {String(b.hour).padStart(2, "0")}:{String(b.minute).padStart(2, "0")} ·{" "}
              {b.placeLabel} ({formatTz(b.tzOffsetHours)})
            </p>
            <p className="report-meta">
              Sidereal ({chart.ayanamsaSystem}) · Ayanamsa {formatDegInSign(chart.ayanamsa)} ·{" "}
              Lagna {RASHIS[chart.ascendantSign].name} {formatDegInSign(chart.ascendant - chart.ascendantSign * 30)} ·{" "}
              {chart.nodeType === "true" ? "True" : "Mean"} node
            </p>
          </header>

          <section className="report-lifeareas">
            <h2>Life areas at a glance</h2>
            <table className="report-table">
              <tbody>
                {LIFE_AREA_ORDER.map((v) => {
                  const r = vargaReadings[v];
                  return (
                    <tr key={v}>
                      <td className="la-cell"><b>{LIFE_AREA_LABEL[v]}</b> ({v})</td>
                      <td>{r.tone}</td>
                      <td>{t(r.lines[r.lines.length - 1])}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          {allVargas ? (
            <>
              <section>
                <h2>Divisional charts (D1–D12) · {style === "south" ? "South" : "North"} Indian</h2>
                <div className="varga-grid">
                  {DISPLAYED_VARGAS.map((v) => (
                    <div className="report-varga" key={v.code}>
                      <ChartFor v={v.code} />
                      <p className="report-chart-label">{v.label}</p>
                      <p className="report-chart-note">{v.signifies}</p>
                    </div>
                  ))}
                </div>
              </section>
              <section>
                <h2>Planetary positions (Rāśi / D1)</h2>
                {positionsTable}
              </section>
            </>
          ) : (
            <section className="report-chart-row">
              <div className="report-chart">
                <ChartFor v={mode} />
                <p className="report-chart-label">
                  {VARGA_BY_CODE[mode].label} · {style === "south" ? "South" : "North"} Indian
                </p>
                <p className="report-chart-note">
                  Shows {VARGA_BY_CODE[mode].signifies}. The positions table below is the Rāśi (D1).
                </p>
              </div>
              {positionsTable}
            </section>
          )}

          {allVargas ? (
            <section>
              <h2>What each divisional chart says</h2>
              {DISPLAYED_VARGAS.map((v) => {
                const r = vargaReadings[v.code];
                return (
                  <div className="report-item" key={v.code}>
                    <h3>{r.headline} · {r.tone}</h3>
                    {r.lines.map((line, i) => <p key={i}>{t(line)}</p>)}
                  </div>
                );
              })}
            </section>
          ) : (
            <section className="report-current">
              <h2>{vargaReadings[mode].headline} · {vargaReadings[mode].tone}</h2>
              {vargaReadings[mode].lines.map((line, i) => <p key={i}>{t(line)}</p>)}
            </section>
          )}

          <section>
            <h2>Personality — the three pillars</h2>
            {personality.map((line, i) => <p key={i}>{t(line)}</p>)}
            <p>{t(nakshatra)}</p>
          </section>

          <section className="report-current">
            <h2>Current period (as of {formatDate(report.now)})</h2>
            {maha ? (
              <>
                <p><strong>{maha.lord} Mahadasha{antar ? ` → ${antar.lord} Antardasha` : ""}</strong></p>
                <p>{t(mahaOutlook)}</p>
              </>
            ) : (
              <p>The 120-year dasha timeline does not cover today&apos;s date.</p>
            )}
            {events.length > 0 && (
              <p className="muted">
                Recent milestones: {events.map((e) => `${e.title} (${e.date.getFullYear()})`).join("; ")}.
              </p>
            )}
          </section>

          <section>
            <h2>Grahas — planet by planet</h2>
            {planets.map(({ pos: p, r }) => (
              <div className="report-item" key={p.planet}>
                <h3>{GRAHA_BY_NAME[p.planet].symbol} {p.planet} — {r.headline}</h3>
                <p>{t(r.strength)} {t(r.detail)}</p>
              </div>
            ))}
          </section>

          <section>
            <h2>Bhavas — the twelve houses</h2>
            {houses.map((r, i) => (
              <div className="report-item" key={i}>
                <h3>{i + 1}. {r.name} · {RASHIS[chart.houseSigns[i]].name}</h3>
                <p>{t(r.meaning)} {t(r.verdict)} {t(r.lordPlacement)}</p>
              </div>
            ))}
          </section>

          {yogas.length > 0 && (
            <section>
              <h2>Yogas</h2>
              {yogas.map((y) => (
                <div className="report-item" key={y.name}>
                  <h3>{y.name} [{y.category}]</h3>
                  <p>{t(y.description)} {t(y.effect)}</p>
                </div>
              ))}
            </section>
          )}

          <footer className="report-foot">
            Generated by Aistrology · for learning and reflection, not medical, legal,
            financial or psychological advice.
          </footer>
        </div>
        </div>
      </div>
    </div>
  );
}
