import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { api, SavedChart } from "../api/client";
import { computeChart, ChartOptions } from "../astro/engine";
import { analyseMentalHealth, MentalHealthResult } from "../astro/mentalHealth";
import { mentalHealthGrounding, mentalFactorGrounding, mentalDimensionGrounding } from "../astro/mentalHealthReferences";
import { assessCurrentPeriod, PeriodQuality } from "../astro/periodHealth";
import { Chart } from "../astro/types";
import Justify from "./Justify";
import MentalHealthExportReport from "./MentalHealthExportReport";
import NorthChart from "./NorthChart";
import SouthChart from "./SouthChart";

interface Props {
  currentChart: Chart | null;
  chartOptions: ChartOptions;
  style: "north" | "south";
}

const DIM_COLORS: Record<string, string> = {
  "Emotional Well-being": "#a78bfa",
  "Cognitive Clarity": "#3b82f6",
  "Inner Peace & Security": "#22c55e",
  "Creativity & Joy": "#f59e0b",
  "Wisdom & Optimism": "#f97316",
};

function ScoreBar({ score, color }: { score: number; color: string }) {
  return (
    <div className="kuta-bar-track" style={{ height: 8 }}>
      <div className="kuta-bar-fill"
        style={{ width: `${score}%`, background: color, transition: "width 0.8s ease-out", height: "100%" }} />
    </div>
  );
}

function MindRing({ score }: { score: number }) {
  const r = 54;
  const circ = 2 * Math.PI * r;
  const pct = score / 100;
  const dash = circ * pct;
  const color = score >= 75 ? "#22c55e" : score >= 55 ? "#3b82f6" : score >= 35 ? "#eab308" : "#ef4444";
  return (
    <svg className="match-score-ring" viewBox="0 0 128 128" width="160" height="160">
      <circle cx="64" cy="64" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="10" />
      <circle cx="64" cy="64" r={r} fill="none" stroke={color} strokeWidth="10"
        strokeLinecap="round" strokeDasharray={`${dash} ${circ}`}
        strokeDashoffset={circ * 0.25} style={{ transition: "stroke-dasharray 1s ease-out" }} />
      <text x="64" y="56" textAnchor="middle" fontSize="28" fontWeight="700" fill="#fff">{score}</text>
      <text x="64" y="72" textAnchor="middle" fontSize="11" fill="rgba(255,255,255,0.5)">Mental</text>
      <text x="64" y="85" textAnchor="middle" fontSize="11" fill="rgba(255,255,255,0.5)">Well-being</text>
    </svg>
  );
}

export default function MentalHealthView({ currentChart, chartOptions, style }: Props) {
  const { user } = useAuth();
  const [charts, setCharts] = useState<SavedChart[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [expandedDim, setExpandedDim] = useState<string | null>(null);
  const [expandedFactor, setExpandedFactor] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    api.listCharts()
      .then((cs) => { setCharts(cs); if (cs.length >= 1 && !selectedId) setSelectedId(cs[0].id); })
      .catch(() => setError("Failed to load saved charts"))
      .finally(() => setLoading(false));
  }, [user]);

  const selectedChart = useMemo(() => {
    const c = charts.find((c) => c.id === selectedId);
    return c ? computeChart(c.birth, chartOptions) : null;
  }, [selectedId, charts, chartOptions]);

  const result = useMemo<MentalHealthResult | null>(() => {
    if (!selectedChart) return null;
    return analyseMentalHealth(selectedChart);
  }, [selectedChart]);

  const overallGrounding = useMemo(() => {
    if (!result || !selectedChart) return null;
    return mentalHealthGrounding(result, selectedChart);
  }, [result, selectedChart]);

  const period = useMemo<PeriodQuality | null>(() => {
    if (!selectedChart) return null;
    return assessCurrentPeriod(selectedChart);
  }, [selectedChart]);

  if (!user) {
    return (
      <div className="match-empty">
        <div className="match-empty-icon">🧠</div>
        <h2>Mental Health Analysis</h2>
        <p>Sign in and save at least one chart to see mental well-being insights and remedies.</p>
      </div>
    );
  }
  if (loading) return <div className="match-empty"><p className="muted">Loading saved charts…</p></div>;
  if (charts.length < 1) {
    return (
      <div className="match-empty">
        <div className="match-empty-icon">🧠</div>
        <h2>Mental Health Analysis</h2>
        <p>Save at least <strong>one chart</strong> from the main Kundli view to get mental health insights.</p>
      </div>
    );
  }

  const saved = charts.find((c) => c.id === selectedId);

  return (
    <div className="match-view career-view">
      {/* Selector */}
      <div className="career-selector">
        <label className="match-role"><span className="match-role-icon">👤</span> Select Chart</label>
        <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
          <option value="">— Select chart —</option>
          {charts.map((c) => (
            <option key={c.id} value={c.id}>{c.label} · {c.birth.placeLabel}</option>
          ))}
        </select>
        {saved && (
          <p className="match-birth-info muted small">
            {String(saved.birth.day).padStart(2, "0")}/{String(saved.birth.month).padStart(2, "0")}/{saved.birth.year} · {String(saved.birth.hour).padStart(2, "0")}:{String(saved.birth.minute).padStart(2, "0")} · {saved.birth.placeLabel}
          </p>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {result && selectedChart && (
        <>
          {/* Dashboard */}
          <div className="career-header">
            <div className="career-summary">
              <h3>Mental Health Profile for {saved?.label ?? "Native"}</h3>
              <p className="career-summary-text">{result.overallVerdict}</p>
              {result.afflictions.length > 0 && (
                <div className="mh-affliction-count">
                  <span className="career-tag" style={{ borderColor: "#ef4444", color: "#ef4444" }}>
                    ⚠️ {result.afflictions.length} affliction pattern{result.afflictions.length > 1 ? "s" : ""} detected
                  </span>
                </div>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
              <MindRing score={result.overallScore} />
              <div className="career-mini-chart">
                {style === "south" ? <SouthChart chart={selectedChart} mode="D1" /> : <NorthChart chart={selectedChart} mode="D1" />}
              </div>
            </div>
          </div>

          {/* Disclaimer */}
          <div className="health-disclaimer">
            🧠 <strong>Disclaimer:</strong> This analysis reflects classical Vedic astrological perspectives on mental temperament. It is <strong>not</strong> a psychological assessment or diagnosis. For mental health concerns, please consult a qualified mental health professional.
          </div>

          {/* General vs Current Period */}
          <div className="period-dual">
            <div className="period-card period-general">
              <h4>📋 General (Natal) Mental Health</h4>
              <div className="period-score">
                <span className="period-score-num" style={{ color: result.overallScore >= 60 ? "#22c55e" : result.overallScore >= 40 ? "#eab308" : "#ef4444" }}>{result.overallScore}</span>
                <span className="period-score-label">/100</span>
              </div>
              <p className="period-verdict">{result.overallVerdict}</p>
              <p className="muted small">Based on natal chart — lifelong mental temperament tendencies.</p>
            </div>
            {period && (
              <div className="period-card period-current">
                <h4>⏰ Current Period Mental Health</h4>
                <div className="period-score">
                  <span className="period-score-num" style={{ color: period.mentalScore >= 60 ? "#22c55e" : period.mentalScore >= 40 ? "#eab308" : "#ef4444" }}>{period.mentalScore}</span>
                  <span className="period-score-label">/100</span>
                </div>
                <p className="period-verdict">{period.mentalVerdict}</p>
                <p className="period-label">{period.periodLabel}</p>
                <p className="muted small">{period.periodDates}</p>
              </div>
            )}
          </div>

          {/* Current Period Details */}
          {period && (
            <div className="period-details-section">
              <h3 className="match-section-title">Current Period — What to Watch</h3>
              <div className="period-details-grid">
                {period.mentalDetails.map((d, i) => (
                  <p key={i} className={d.startsWith("  ") ? "period-detail-sub" : "period-detail-head"}>{d}</p>
                ))}
              </div>
              {period.mentalRemedies.length > 0 && (
                <div className="period-remedies">
                  <strong>Period-specific remedies:</strong>
                  <ul>
                    {period.mentalRemedies.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Dimensions */}
          <h3 className="match-section-title">Mental Well-being Dimensions</h3>
          <div className="mh-dimensions">
            {result.dimensions.map((d) => {
              const isExpanded = expandedDim === d.name;
              const color = DIM_COLORS[d.name] ?? "#7c5cff";
              const grounding = mentalDimensionGrounding(d);
              return (
                <div className={`career-domain-card${isExpanded ? " expanded" : ""}`} key={d.name}>
                  <button className="career-domain-head" onClick={() => setExpandedDim(isExpanded ? null : d.name)}>
                    <div className="career-domain-top">
                      <span className="career-domain-icon">{d.icon}</span>
                      <span className="career-domain-name">{d.name}</span>
                      <span className="career-domain-score" style={{ color }}>{d.score}</span>
                    </div>
                    <ScoreBar score={d.score} color={color} />
                    <p className="kuta-desc muted small" style={{ marginTop: 8 }}>{d.description}</p>
                  </button>
                  {isExpanded && (
                    <div className="kuta-card-body">
                      <p>{d.indication}</p>
                      <p><strong>Remedy:</strong> {d.remedy}</p>
                      <Justify subject={`Mental Health: ${d.name}`} basePrediction={d.indication}
                        facts={grounding.facts} references={grounding.references} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Afflictions */}
          {result.afflictions.length > 0 && (
            <>
              <h3 className="match-section-title">Affliction Patterns</h3>
              <div className="mh-afflictions">
                {result.afflictions.map((a, i) => (
                  <div className="mh-affliction-item" key={i}>
                    <span className="mh-affliction-dot" />
                    <p>{a}</p>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Factors */}
          <h3 className="match-section-title">Astrological Factors Analysed</h3>
          <div className="career-factors">
            {result.factors.map((f) => {
              const isExpanded = expandedFactor === f.name;
              const grounding = mentalFactorGrounding(f);
              return (
                <div className={`kuta-card${isExpanded ? " expanded" : ""}`} key={f.name}>
                  <button className="kuta-card-head" onClick={() => setExpandedFactor(isExpanded ? null : f.name)}>
                    <div className="kuta-card-top"><span className="kuta-name">{f.name}</span></div>
                    <p className="kuta-desc muted small">{f.description}</p>
                  </button>
                  {isExpanded && (
                    <div className="kuta-card-body">
                      <p>{f.detail}</p>
                      <Justify subject={f.name} basePrediction={f.detail}
                        facts={grounding.facts} references={grounding.references} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Remedies */}
          <h3 className="match-section-title">Recommended Remedies</h3>
          <div className="health-remedies-list">
            {result.remedies.map((r, i) => (
              <div className="health-remedy-item" key={i}>
                <span className="health-remedy-num">{i + 1}</span>
                <p>{r}</p>
              </div>
            ))}
          </div>

          {/* Overall Justify */}
          {overallGrounding && (
            <div className="match-overall-justify">
              <Justify
                subject={`Mental health analysis for ${saved?.label ?? "Native"}`}
                basePrediction={result.overallVerdict}
                facts={overallGrounding.facts}
                references={overallGrounding.references}
                guidelines={[
                  "Analyse Moon's condition (sign, nakshatra, house, aspects) for emotional health.",
                  "Examine Mercury for cognitive and nervous system health.",
                  "Assess 4th house for inner peace and 5th house for creativity/joy.",
                  "Note any affliction patterns (Grahan Yoga, Saturn-Moon, etc.).",
                  "Recommend both Vedic remedies and practical mental wellness practices.",
                  "ALWAYS include the disclaimer that this is NOT professional mental health advice.",
                ]}
              />
            </div>
          )}

          {/* Export */}
          <button className="match-export-btn" onClick={() => setShowExport(true)}>⬇ Export Mental Health Report</button>
          <MentalHealthExportReport chart={selectedChart} result={result} label={saved?.label ?? "Native"}
            open={showExport} onClose={() => setShowExport(false)} style={style} />
        </>
      )}
    </div>
  );
}
