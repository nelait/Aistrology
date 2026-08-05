import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { api, SavedChart } from "../api/client";
import { computeChart, ChartOptions } from "../astro/engine";
import { analyseHealth, HealthResult, HealthArea, HealthFactor } from "../astro/health";
import { healthGrounding, healthFactorGrounding, healthAreaGrounding } from "../astro/healthReferences";
import { assessCurrentPeriod, PeriodQuality } from "../astro/periodHealth";
import { Chart } from "../astro/types";
import { RASHIS, NAKSHATRAS } from "../astro/constants";
import Justify from "./Justify";
import HealthExportReport from "./HealthExportReport";
import NorthChart from "./NorthChart";
import SouthChart from "./SouthChart";

interface Props {
  currentChart: Chart | null;
  chartOptions: ChartOptions;
  style: "north" | "south";
}

const SEVERITY_COLORS = { high: "#ef4444", moderate: "#eab308", low: "#22c55e" };
const SEVERITY_LABELS = { high: "High", moderate: "Moderate", low: "Low" };

function VitalityRing({ score }: { score: number }) {
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
      <text x="64" y="72" textAnchor="middle" fontSize="12" fill="rgba(255,255,255,0.5)">Vitality</text>
      <text x="64" y="92" textAnchor="middle" fontSize="13" fontWeight="600" fill={color}>
        {score >= 75 ? "Strong" : score >= 55 ? "Moderate" : score >= 35 ? "Below Avg" : "Vulnerable"}
      </text>
    </svg>
  );
}

export default function HealthView({ currentChart, chartOptions, style }: Props) {
  const { user } = useAuth();
  const [charts, setCharts] = useState<SavedChart[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [expandedArea, setExpandedArea] = useState<string | null>(null);
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

  const result = useMemo<HealthResult | null>(() => {
    if (!selectedChart) return null;
    return analyseHealth(selectedChart);
  }, [selectedChart]);

  const overallGrounding = useMemo(() => {
    if (!result || !selectedChart) return null;
    return healthGrounding(result, selectedChart);
  }, [result, selectedChart]);

  const period = useMemo<PeriodQuality | null>(() => {
    if (!selectedChart) return null;
    return assessCurrentPeriod(selectedChart);
  }, [selectedChart]);

  if (!user) {
    return (
      <div className="match-empty">
        <div className="match-empty-icon">🏥</div>
        <h2>Health Analysis</h2>
        <p>Sign in and save at least one birth chart to see health insights and remedies.</p>
      </div>
    );
  }
  if (loading) return <div className="match-empty"><p className="muted">Loading saved charts…</p></div>;
  if (charts.length < 1) {
    return (
      <div className="match-empty">
        <div className="match-empty-icon">🏥</div>
        <h2>Health Analysis</h2>
        <p>Save at least <strong>one chart</strong> from the main Kundli view to get health insights.</p>
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
              <h3>Health Profile for {saved?.label ?? "Native"}</h3>
              <div className="health-constitution">
                <span className="career-tag">🧬 {result.constitution}</span>
                <span className="career-tag">💪 Vitality: {result.vitalityScore}%</span>
              </div>
              <p className="career-summary-text">{result.constitutionDescription}</p>
              <p className="career-summary-text">{result.vitalityVerdict}</p>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
              <VitalityRing score={result.vitalityScore} />
              <div className="career-mini-chart">
                {style === "south" ? <SouthChart chart={selectedChart} mode="D1" /> : <NorthChart chart={selectedChart} mode="D1" />}
              </div>
            </div>
          </div>

          {/* Disclaimer */}
          <div className="health-disclaimer">
            ⚕️ <strong>Disclaimer:</strong> This analysis is for educational and reflective purposes based on classical Vedic astrology. It is <strong>not</strong> medical advice. Always consult qualified healthcare professionals for health concerns.
          </div>

          {/* General vs Current Period */}
          <div className="period-dual">
            <div className="period-card period-general">
              <h4>📋 General (Natal) Health</h4>
              <div className="period-score">
                <span className="period-score-num" style={{ color: result.vitalityScore >= 60 ? "#22c55e" : result.vitalityScore >= 40 ? "#eab308" : "#ef4444" }}>{result.vitalityScore}</span>
                <span className="period-score-label">/100</span>
              </div>
              <p className="period-verdict">{result.vitalityVerdict}</p>
              <p className="muted small">Based on natal chart — lifelong constitutional tendencies.</p>
            </div>
            {period && (
              <div className="period-card period-current">
                <h4>⏰ Current Period Health</h4>
                <div className="period-score">
                  <span className="period-score-num" style={{ color: period.healthScore >= 60 ? "#22c55e" : period.healthScore >= 40 ? "#eab308" : "#ef4444" }}>{period.healthScore}</span>
                  <span className="period-score-label">/100</span>
                </div>
                <p className="period-verdict">{period.healthVerdict}</p>
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
                {period.healthDetails.map((d, i) => (
                  <p key={i} className={d.startsWith("  ") ? "period-detail-sub" : "period-detail-head"}>{d}</p>
                ))}
              </div>
              {period.healthRemedies.length > 0 && (
                <div className="period-remedies">
                  <strong>Period-specific remedies:</strong>
                  <ul>
                    {period.healthRemedies.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Health Vulnerabilities */}
          {result.areas.length > 0 && (
            <>
              <h3 className="match-section-title">Potential Health Vulnerabilities</h3>
              <div className="health-areas">
                {result.areas.map((a) => {
                  const isExpanded = expandedArea === a.name;
                  const grounding = healthAreaGrounding(a);
                  return (
                    <div className={`health-area-card${isExpanded ? " expanded" : ""}`} key={a.name}>
                      <button className="health-area-head" onClick={() => setExpandedArea(isExpanded ? null : a.name)}>
                        <div className="health-area-top">
                          <span className="health-area-icon">{a.icon}</span>
                          <span className="health-area-name">{a.name}</span>
                          <span className="health-severity" style={{ color: SEVERITY_COLORS[a.severity], borderColor: SEVERITY_COLORS[a.severity] }}>
                            {SEVERITY_LABELS[a.severity]}
                          </span>
                        </div>
                        <p className="kuta-desc muted small">{a.indication}</p>
                        <div className="career-keywords">
                          {a.bodyParts.map((bp) => <span className="career-keyword" key={bp}>{bp}</span>)}
                        </div>
                      </button>
                      {isExpanded && (
                        <div className="kuta-card-body">
                          <p><strong>Remedy:</strong> {a.remedy}</p>
                          <Justify subject={`Health: ${a.name}`} basePrediction={a.indication}
                            facts={grounding.facts} references={grounding.references} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Astrological Factors */}
          <h3 className="match-section-title">Astrological Factors Analysed</h3>
          <div className="career-factors">
            {result.factors.map((f) => {
              const isExpanded = expandedFactor === f.name;
              const grounding = healthFactorGrounding(f);
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

          {/* General Remedies */}
          <h3 className="match-section-title">General Health Remedies</h3>
          <div className="health-remedies-list">
            {result.generalRemedies.map((r, i) => (
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
                subject={`Health analysis for ${saved?.label ?? "Native"}`}
                basePrediction={`${result.constitutionDescription} ${result.vitalityVerdict}`}
                facts={overallGrounding.facts}
                references={overallGrounding.references}
                guidelines={[
                  "Analyse constitution (Vata/Pitta/Kapha), vitality indicators and vulnerable areas.",
                  "For each vulnerability, explain the astrological basis and suggest specific remedies.",
                  "Include both Vedic remedies (mantras, gemstones, charity) and practical lifestyle advice.",
                  "ALWAYS include the disclaimer that this is not medical advice.",
                ]}
              />
            </div>
          )}

          {/* Export */}
          <button className="match-export-btn" onClick={() => setShowExport(true)}>⬇ Export Health Report</button>
          <HealthExportReport chart={selectedChart} result={result} label={saved?.label ?? "Native"}
            open={showExport} onClose={() => setShowExport(false)} style={style} />
        </>
      )}
    </div>
  );
}
