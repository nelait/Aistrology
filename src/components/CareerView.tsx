import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { api, SavedChart } from "../api/client";
import { computeChart, ChartOptions } from "../astro/engine";
import { analyseCareer, CareerResult, CareerDomain, CareerFactor } from "../astro/career";
import { careerGrounding, careerFactorGrounding, domainGrounding } from "../astro/careerReferences";
import { assessCurrentPeriod, PeriodQuality } from "../astro/periodHealth";
import { Chart } from "../astro/types";
import { RASHIS, NAKSHATRAS } from "../astro/constants";
import Justify from "./Justify";
import CareerExportReport from "./CareerExportReport";
import NorthChart from "./NorthChart";
import SouthChart from "./SouthChart";

interface Props {
  currentChart: Chart | null;
  chartOptions: ChartOptions;
  style: "north" | "south";
}

function DomainBar({ domain }: { domain: CareerDomain }) {
  const color = domain.score >= 75 ? "#22c55e" : domain.score >= 50 ? "#3b82f6" : domain.score >= 30 ? "#eab308" : "#f97316";
  return (
    <div className="kuta-bar-track" style={{ height: 8 }}>
      <div
        className="kuta-bar-fill"
        style={{ width: `${domain.score}%`, background: color, transition: "width 0.8s ease-out", height: "100%" }}
      />
    </div>
  );
}

export default function CareerView({ currentChart, chartOptions, style }: Props) {
  const { user } = useAuth();
  const [charts, setCharts] = useState<SavedChart[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [expandedDomain, setExpandedDomain] = useState<string | null>(null);
  const [expandedFactor, setExpandedFactor] = useState<string | null>(null);
  const [showAllDomains, setShowAllDomains] = useState(false);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    api
      .listCharts()
      .then((cs) => {
        setCharts(cs);
        if (cs.length >= 1 && !selectedId) setSelectedId(cs[0].id);
      })
      .catch(() => setError("Failed to load saved charts"))
      .finally(() => setLoading(false));
  }, [user]);

  const selectedChart = useMemo(() => {
    const c = charts.find((c) => c.id === selectedId);
    return c ? computeChart(c.birth, chartOptions) : null;
  }, [selectedId, charts, chartOptions]);

  const result = useMemo<CareerResult | null>(() => {
    if (!selectedChart) return null;
    return analyseCareer(selectedChart);
  }, [selectedChart]);

  const overallGrounding = useMemo(() => {
    if (!result || !selectedChart) return null;
    return careerGrounding(result, selectedChart);
  }, [result, selectedChart]);

  const period = useMemo<PeriodQuality | null>(() => {
    if (!selectedChart) return null;
    return assessCurrentPeriod(selectedChart);
  }, [selectedChart]);

  if (!user) {
    return (
      <div className="match-empty">
        <div className="match-empty-icon">💼</div>
        <h2>Career Suggestions</h2>
        <p>
          Sign in and save at least one birth chart to get personalised
          career guidance based on Vedic astrology.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="match-empty">
        <p className="muted">Loading saved charts…</p>
      </div>
    );
  }

  if (charts.length < 1) {
    return (
      <div className="match-empty">
        <div className="match-empty-icon">💼</div>
        <h2>Career Suggestions</h2>
        <p>
          Save at least <strong>one chart</strong> from the main Kundli view to get career
          suggestions.
        </p>
      </div>
    );
  }

  const saved = charts.find((c) => c.id === selectedId);
  const displayDomains = showAllDomains ? result?.allDomains ?? [] : result?.topDomains ?? [];

  return (
    <div className="match-view career-view">
      {/* Selector — single chart */}
      <div className="career-selector">
        <label className="match-role">
          <span className="match-role-icon">👤</span> Select Chart
        </label>
        <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
          <option value="">— Select chart —</option>
          {charts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} · {c.birth.placeLabel}
            </option>
          ))}
        </select>
        {saved && (
          <p className="match-birth-info muted small">
            {String(saved.birth.day).padStart(2, "0")}/
            {String(saved.birth.month).padStart(2, "0")}/
            {saved.birth.year} ·{" "}
            {String(saved.birth.hour).padStart(2, "0")}:
            {String(saved.birth.minute).padStart(2, "0")} · {saved.birth.placeLabel}
          </p>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {result && selectedChart && (
        <>
          {/* Summary header with mini chart */}
          <div className="career-header">
            <div className="career-summary">
              <h3>Career Profile for {saved?.label ?? "Native"}</h3>
              <p className="career-summary-text">{result.tenthHouseSummary}</p>
              <div className="career-meta">
                <span className="career-tag">🌟 Strongest: {result.strongestPlanet}</span>
                <span className="career-tag">🔥 Element: {result.careerElement}</span>
              </div>
            </div>
            <div className="career-mini-chart">
              {style === "south" ? (
                <SouthChart chart={selectedChart} mode="D1" />
              ) : (
                <NorthChart chart={selectedChart} mode="D1" />
              )}
            </div>
          </div>

          {/* General vs Current Period */}
          <div className="period-dual">
            <div className="period-card period-general">
              <h4>📋 General (Natal) Career</h4>
              <div className="period-score">
                <span className="period-score-num" style={{ color: (result.topDomains[0]?.score ?? 0) >= 60 ? "#22c55e" : (result.topDomains[0]?.score ?? 0) >= 40 ? "#eab308" : "#ef4444" }}>{result.topDomains[0]?.score ?? 0}</span>
                <span className="period-score-label">/100</span>
              </div>
              <p className="period-verdict">{result.tenthHouseSummary}</p>
              <p className="muted small">Lifelong career aptitude based on natal chart.</p>
            </div>
            {period && (
              <div className="period-card period-current">
                <h4>⏰ Current Period Career</h4>
                <div className="period-score">
                  <span className="period-score-num" style={{ color: period.careerScore >= 60 ? "#22c55e" : period.careerScore >= 40 ? "#eab308" : "#ef4444" }}>{period.careerScore}</span>
                  <span className="period-score-label">/100</span>
                </div>
                <p className="period-verdict">{period.careerVerdict}</p>
                <p className="period-label">{period.periodLabel}</p>
                <p className="muted small">{period.periodDates}</p>
              </div>
            )}
          </div>

          {/* Current Period Details */}
          {period && (
            <div className="period-details-section">
              <h3 className="match-section-title">Current Period — Career Outlook</h3>
              <div className="period-details-grid">
                {period.careerDetails.map((d, i) => (
                  <p key={i} className={d.startsWith("  ") ? "period-detail-sub" : "period-detail-head"}>{d}</p>
                ))}
              </div>
              {period.careerRemedies.length > 0 && (
                <div className="period-remedies">
                  <strong>Period-specific career tips:</strong>
                  <ul>
                    {period.careerRemedies.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Top Career Domains */}
          <h3 className="match-section-title">
            {showAllDomains ? "All" : "Top 5"} Recommended Career Domains
          </h3>
          <div className="career-domains">
            {displayDomains.map((d) => {
              const isExpanded = expandedDomain === d.name;
              const grounding = domainGrounding(d);
              return (
                <div className={`career-domain-card${isExpanded ? " expanded" : ""}`} key={d.name}>
                  <button
                    className="career-domain-head"
                    onClick={() => setExpandedDomain(isExpanded ? null : d.name)}
                  >
                    <div className="career-domain-top">
                      <span className="career-domain-icon">{d.icon}</span>
                      <span className="career-domain-name">{d.name}</span>
                      <span className="career-domain-score">{d.score}%</span>
                    </div>
                    <DomainBar domain={d} />
                    <div className="career-keywords">
                      {d.keywords.map((k) => (
                        <span className="career-keyword" key={k}>{k}</span>
                      ))}
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="kuta-card-body">
                      <p>{d.reasoning}</p>
                      <Justify
                        subject={`Career suitability for ${d.name}`}
                        basePrediction={d.reasoning}
                        facts={grounding.facts}
                        references={grounding.references}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {(result.allDomains.length > 5) && (
            <button
              className="career-show-more"
              onClick={() => setShowAllDomains(!showAllDomains)}
            >
              {showAllDomains ? "Show top 5 only" : `Show all ${result.allDomains.length} domains`}
            </button>
          )}

          {/* Astrological Factors */}
          <h3 className="match-section-title">Astrological Factors Analysed</h3>
          <div className="career-factors">
            {result.factors.map((f) => {
              const isExpanded = expandedFactor === f.name;
              const grounding = careerFactorGrounding(f);
              return (
                <div className={`kuta-card${isExpanded ? " expanded" : ""}`} key={f.name}>
                  <button
                    className="kuta-card-head"
                    onClick={() => setExpandedFactor(isExpanded ? null : f.name)}
                  >
                    <div className="kuta-card-top">
                      <span className="kuta-name">{f.name}</span>
                    </div>
                    <p className="kuta-desc muted small">{f.description}</p>
                  </button>
                  {isExpanded && (
                    <div className="kuta-card-body">
                      <p>{f.detail}</p>
                      <Justify
                        subject={f.name}
                        basePrediction={f.detail}
                        facts={grounding.facts}
                        references={grounding.references}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Overall Justify */}
          {overallGrounding && (
            <div className="match-overall-justify">
              <Justify
                subject={`Career analysis for ${saved?.label ?? "Native"}`}
                basePrediction={result.tenthHouseSummary}
                facts={overallGrounding.facts}
                references={overallGrounding.references}
                guidelines={[
                  "Analyse the 10th house sign, lord and occupants to determine primary career direction.",
                  "Consider the strongest planet and its natural domains.",
                  "Recommend specific roles within the top career domains.",
                  "Note any doshas or challenges that might affect career, and suggest remedies.",
                ]}
              />
            </div>
          )}

          {/* Export */}
          <button className="match-export-btn" onClick={() => setShowExport(true)}>
            ⬇ Export Career Report
          </button>

          <CareerExportReport
            chart={selectedChart}
            result={result}
            label={saved?.label ?? "Native"}
            open={showExport}
            onClose={() => setShowExport(false)}
            style={style}
          />
        </>
      )}
    </div>
  );
}
