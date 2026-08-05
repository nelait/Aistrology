import { useEffect, useMemo, useState } from "react";
import { Chart, DashaPeriod } from "../astro/types";
import { computeVimshottari, activePeriod } from "../astro/dasha";
import { birthDateUT } from "../astro/engine";
import { GRAHA_BY_NAME } from "../astro/constants";
import { dashaOutlook } from "../astro/interpret";
import { dashaReferences } from "../astro/references";
import Justify from "./Justify";
import { ScopeBadge } from "./ScopeBadge";
import { useTranslation } from "../i18n/TranslationProvider";
import { formatDate, yearsBetween } from "../utils/format";

interface Props {
  chart: Chart;
}

export default function DashaView({ chart }: Props) {
  const moon = chart.planets.find((p) => p.planet === "Moon")!;
  const birth = useMemo(() => birthDateUT(chart.birth), [chart]);
  const timeline = useMemo(
    () => computeVimshottari(moon.longitude, birth, 120),
    [moon.longitude, birth],
  );
  const now = new Date();

  const currentMaha = activePeriod(timeline, now);
  const currentAntar = currentMaha?.children
    ? activePeriod(currentMaha.children, now)
    : undefined;
  const currentPratya = currentAntar?.children
    ? activePeriod(currentAntar.children, now)
    : undefined;

  const { t, ensure, active } = useTranslation();
  const mahaOutlook = currentMaha ? dashaOutlook(chart, currentMaha.lord) : "";
  const antarOutlook =
    currentAntar && currentAntar.lord !== currentMaha?.lord
      ? dashaOutlook(chart, currentAntar.lord)
      : "";
  useEffect(() => {
    if (active) ensure([mahaOutlook, antarOutlook].filter(Boolean));
  }, [active, ensure, mahaOutlook, antarOutlook]);

  const [openIdx, setOpenIdx] = useState<number>(() =>
    Math.max(0, timeline.findIndex((p) => p === currentMaha)),
  );
  // Which antardasha (by "mahaIdx-antarIdx" key) is expanded to its pratyantardashas.
  const [openAntar, setOpenAntar] = useState<string>(() => {
    const mi = timeline.findIndex((p) => p === currentMaha);
    const ai = currentMaha?.children?.findIndex((c) => c === currentAntar) ?? -1;
    return mi >= 0 && ai >= 0 ? `${mi}-${ai}` : "";
  });

  return (
    <div className="dasha">
      <div className="card highlight running">
        <h3>Running period (as of {formatDate(now)}) <ScopeBadge scope="timing" /></h3>
        {currentMaha ? (
          <>
            <p className="running-line">
              <span className="glyph">{GRAHA_BY_NAME[currentMaha.lord].symbol}</span>
              <b>{currentMaha.lord} Mahadasha</b>
              {currentAntar && (
                <>
                  {" "}→ <b>{currentAntar.lord} Antardasha</b>
                </>
              )}
              {currentPratya && (
                <>
                  {" "}→ <b>{currentPratya.lord} Pratyantardasha</b>
                </>
              )}
            </p>
            <p className="muted">
              {currentMaha.lord} major: {formatDate(currentMaha.start)} – {formatDate(currentMaha.end)}
              {currentAntar && (
                <>
                  {" "}· {currentAntar.lord} sub: {formatDate(currentAntar.start)} – {formatDate(currentAntar.end)}
                </>
              )}
              {currentPratya && (
                <>
                  {" "}· {currentPratya.lord} sub-sub: {formatDate(currentPratya.start)} – {formatDate(currentPratya.end)}
                </>
              )}
            </p>
            <p className="outlook">{t(mahaOutlook)}</p>
            {currentAntar && currentAntar.lord !== currentMaha.lord && (
              <p className="outlook sub">
                The sub-period lord shapes the near term: {t(antarOutlook)}
              </p>
            )}
            <Justify
              subject={`${currentMaha.lord} Mahadasha`}
              basePrediction={dashaOutlook(chart, currentMaha.lord)}
              facts={dashaReferences(chart, currentMaha.lord).facts}
              references={dashaReferences(chart, currentMaha.lord).references}
            />
          </>
        ) : (
          <p>This chart's 120-year timeline does not cover today's date.</p>
        )}
      </div>

      <h3 className="section-h">Mahadasha timeline (Vimshottari · 120 years)</h3>
      <p className="muted small">
        Click a Mahadasha for its Antardashas (bhukti), then an Antardasha for its
        Pratyantardashas (sub-sub-periods). The first period is a &ldquo;balance&rdquo; — the
        portion of the Moon&apos;s nakshatra lord already elapsed at birth.
      </p>
      <div className="timeline">
        {timeline.map((maha, idx) => {
          const isCurrent = maha === currentMaha;
          const open = openIdx === idx;
          const years = yearsBetween(maha.start, maha.end);
          return (
            <div className={`maha ${isCurrent ? "current" : ""}`} key={idx}>
              <button className="maha-head" onClick={() => setOpenIdx(open ? -1 : idx)}>
                <span className="glyph">{GRAHA_BY_NAME[maha.lord].symbol}</span>
                <span className="maha-lord">{maha.lord}</span>
                <span className="maha-dates muted">
                  {formatDate(maha.start)} – {formatDate(maha.end)} · {years.toFixed(1)} yrs
                </span>
                {isCurrent && <span className="now-badge">now</span>}
                <span className="chevron">{open ? "▾" : "▸"}</span>
              </button>
              {open && maha.children && (
                <div className="antar-list">
                  {maha.children.map((antar: DashaPeriod, j) => {
                    const running = antar === currentAntar && isCurrent;
                    const key = `${idx}-${j}`;
                    const antarOpen = openAntar === key;
                    return (
                      <div className={`antar-group ${antarOpen ? "open" : ""}`} key={j}>
                        <button
                          className={`antar ${running ? "current" : ""}`}
                          onClick={() => setOpenAntar(antarOpen ? "" : key)}
                        >
                          <span className="glyph small">{GRAHA_BY_NAME[antar.lord].symbol}</span>
                          <span className="antar-lord">{maha.lord}–{antar.lord}</span>
                          <span className="muted">
                            {formatDate(antar.start)} – {formatDate(antar.end)}
                          </span>
                          {running && <span className="now-badge small">now</span>}
                          {antar.children && (
                            <span className="chevron small">{antarOpen ? "▾" : "▸"}</span>
                          )}
                        </button>
                        {antarOpen && antar.children && (
                          <div className="pratya-list">
                            {antar.children.map((pratya: DashaPeriod, k) => {
                              const pRunning = pratya === currentPratya && running;
                              return (
                                <div className={`pratya ${pRunning ? "current" : ""}`} key={k}>
                                  <span className="glyph tiny">
                                    {GRAHA_BY_NAME[pratya.lord].symbol}
                                  </span>
                                  <span>{antar.lord}–{pratya.lord}</span>
                                  <span className="muted">
                                    {formatDate(pratya.start)} – {formatDate(pratya.end)}
                                  </span>
                                  {pRunning && <span className="now-badge small">now</span>}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
