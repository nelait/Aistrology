import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { api, SavedChart } from "../api/client";
import { computeChart, ChartOptions } from "../astro/engine";
import { computePartnership, PartnershipResult, PartnershipFactor } from "../astro/partnership";
import { partnershipGrounding, partnershipFactorGrounding } from "../astro/partnershipReferences";
import { Chart } from "../astro/types";
import { RASHIS, NAKSHATRAS } from "../astro/constants";
import Justify from "./Justify";
import PartnershipExportReport from "./PartnershipExportReport";
import NorthChart from "./NorthChart";
import SouthChart from "./SouthChart";

interface Props {
  currentChart: Chart | null;
  chartOptions: ChartOptions;
  style: "north" | "south";
}

const VERDICT_COLORS: Record<string, string> = {
  "Power Duo": "#22c55e",
  "Strong Alliance": "#3b82f6",
  Workable: "#eab308",
  Challenging: "#ef4444",
};

function ScoreRing({ score, max, verdict }: { score: number; max: number; verdict: string }) {
  const pct = score / max;
  const r = 54;
  const circ = 2 * Math.PI * r;
  const dash = circ * pct;
  const color = VERDICT_COLORS[verdict] ?? "#7c5cff";
  return (
    <svg className="match-score-ring" viewBox="0 0 128 128" width="160" height="160">
      <circle cx="64" cy="64" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="10" />
      <circle
        cx="64" cy="64" r={r}
        fill="none"
        stroke={color}
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circ}`}
        strokeDashoffset={circ * 0.25}
        style={{ transition: "stroke-dasharray 1s ease-out" }}
      />
      <text x="64" y="56" textAnchor="middle" fontSize="28" fontWeight="700" fill="#fff">
        {score}
      </text>
      <text x="64" y="72" textAnchor="middle" fontSize="12" fill="rgba(255,255,255,0.5)">
        out of {max}
      </text>
      <text x="64" y="92" textAnchor="middle" fontSize="13" fontWeight="600" fill={color}>
        {verdict}
      </text>
    </svg>
  );
}

function FactorBar({ factor }: { factor: PartnershipFactor }) {
  const pct = (factor.points / factor.maxPoints) * 100;
  const color = pct >= 75 ? "#22c55e" : pct >= 50 ? "#eab308" : pct > 0 ? "#f97316" : "#ef4444";
  return (
    <div className="kuta-bar-track">
      <div
        className="kuta-bar-fill"
        style={{ width: `${pct}%`, background: color, transition: "width 0.8s ease-out" }}
      />
    </div>
  );
}

export default function PartnershipView({ currentChart, chartOptions, style }: Props) {
  const { user } = useAuth();
  const [charts, setCharts] = useState<SavedChart[]>([]);
  const [person1Id, setPerson1Id] = useState("");
  const [person2Id, setPerson2Id] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [expandedFactor, setExpandedFactor] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    api
      .listCharts()
      .then((cs) => {
        setCharts(cs);
        if (cs.length >= 2 && !person1Id && !person2Id) {
          setPerson1Id(cs[0].id);
          setPerson2Id(cs[1].id);
        }
      })
      .catch(() => setError("Failed to load saved charts"))
      .finally(() => setLoading(false));
  }, [user]);

  const chart1 = useMemo(() => {
    const c = charts.find((c) => c.id === person1Id);
    return c ? computeChart(c.birth, chartOptions) : null;
  }, [person1Id, charts, chartOptions]);

  const chart2 = useMemo(() => {
    const c = charts.find((c) => c.id === person2Id);
    return c ? computeChart(c.birth, chartOptions) : null;
  }, [person2Id, charts, chartOptions]);

  const result = useMemo<PartnershipResult | null>(() => {
    if (!chart1 || !chart2) return null;
    return computePartnership(chart1, chart2);
  }, [chart1, chart2]);

  const overallGrounding = useMemo(() => {
    if (!result || !chart1 || !chart2) return null;
    return partnershipGrounding(result, chart1, chart2);
  }, [result, chart1, chart2]);

  if (!user) {
    return (
      <div className="match-empty">
        <div className="match-empty-icon">🤝</div>
        <h2>Partnership Match</h2>
        <p>
          Sign in and save at least two birth charts to analyse business
          partnership compatibility.
        </p>
        <p className="muted small">
          Go to any chart → click your account → Save current chart.
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

  if (charts.length < 2) {
    return (
      <div className="match-empty">
        <div className="match-empty-icon">🤝</div>
        <h2>Partnership Match</h2>
        <p>
          You need at least <strong>two saved charts</strong> to compute partnership
          compatibility. Save charts from the main Kundli view.
        </p>
        <p className="muted small">
          You have {charts.length} saved chart{charts.length !== 1 ? "s" : ""}. Save{" "}
          {2 - charts.length} more.
        </p>
      </div>
    );
  }

  const saved1 = charts.find((c) => c.id === person1Id);
  const saved2 = charts.find((c) => c.id === person2Id);

  return (
    <div className="match-view">
      {/* Selector */}
      <div className="match-selector">
        <div className="match-selector-col">
          <label className="match-role">
            <span className="match-role-icon">💼</span> Partner 1
          </label>
          <select value={person1Id} onChange={(e) => setPerson1Id(e.target.value)}>
            <option value="">— Select chart —</option>
            {charts.map((c) => (
              <option key={c.id} value={c.id} disabled={c.id === person2Id}>
                {c.label} · {c.birth.placeLabel}
              </option>
            ))}
          </select>
          {saved1 && (
            <p className="match-birth-info muted small">
              {String(saved1.birth.day).padStart(2, "0")}/
              {String(saved1.birth.month).padStart(2, "0")}/
              {saved1.birth.year} ·{" "}
              {String(saved1.birth.hour).padStart(2, "0")}:
              {String(saved1.birth.minute).padStart(2, "0")}
            </p>
          )}
        </div>

        <div className="match-vs" style={{ color: "#3b82f6" }}>⚡</div>

        <div className="match-selector-col">
          <label className="match-role">
            <span className="match-role-icon">💼</span> Partner 2
          </label>
          <select value={person2Id} onChange={(e) => setPerson2Id(e.target.value)}>
            <option value="">— Select chart —</option>
            {charts.map((c) => (
              <option key={c.id} value={c.id} disabled={c.id === person1Id}>
                {c.label} · {c.birth.placeLabel}
              </option>
            ))}
          </select>
          {saved2 && (
            <p className="match-birth-info muted small">
              {String(saved2.birth.day).padStart(2, "0")}/
              {String(saved2.birth.month).padStart(2, "0")}/
              {saved2.birth.year} ·{" "}
              {String(saved2.birth.hour).padStart(2, "0")}:
              {String(saved2.birth.minute).padStart(2, "0")}
            </p>
          )}
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {result && chart1 && chart2 && (
        <>
          {/* Dashboard */}
          <div className="match-dashboard">
            <div className="match-ring-area">
              <ScoreRing score={result.totalScore} max={30} verdict={result.verdict} />
              <p className="match-verdict-desc">{result.verdictDescription}</p>
            </div>

            <div className="match-charts-row">
              <div className="match-mini-chart">
                <p className="match-mini-label">💼 {saved1?.label}</p>
                {style === "south" ? (
                  <SouthChart chart={chart1} mode="D1" />
                ) : (
                  <NorthChart chart={chart1} mode="D1" />
                )}
                <p className="muted small">
                  Moon: {RASHIS[chart1.planets.find((p) => p.planet === "Moon")!.signIndex].name},{" "}
                  {NAKSHATRAS[chart1.planets.find((p) => p.planet === "Moon")!.nakshatraIndex].name}
                </p>
              </div>
              <div className="match-mini-chart">
                <p className="match-mini-label">💼 {saved2?.label}</p>
                {style === "south" ? (
                  <SouthChart chart={chart2} mode="D1" />
                ) : (
                  <NorthChart chart={chart2} mode="D1" />
                )}
                <p className="muted small">
                  Moon: {RASHIS[chart2.planets.find((p) => p.planet === "Moon")!.signIndex].name},{" "}
                  {NAKSHATRAS[chart2.planets.find((p) => p.planet === "Moon")!.nakshatraIndex].name}
                </p>
              </div>
            </div>
          </div>

          {/* Factor Grid */}
          <h3 className="match-section-title">Partnership Factors — 6-dimension analysis</h3>
          <div className="kuta-grid">
            {result.factors.map((f) => {
              const isExpanded = expandedFactor === f.name;
              const grounding = partnershipFactorGrounding(f);
              return (
                <div className={`kuta-card${isExpanded ? " expanded" : ""}`} key={f.name}>
                  <button
                    className="kuta-card-head"
                    onClick={() => setExpandedFactor(isExpanded ? null : f.name)}
                  >
                    <div className="kuta-card-top">
                      <span className="kuta-name">{f.name}</span>
                      <span className="kuta-score">{f.points}/{f.maxPoints}</span>
                    </div>
                    <FactorBar factor={f} />
                    <p className="kuta-desc muted small">{f.description}</p>
                  </button>
                  {isExpanded && (
                    <div className="kuta-card-body">
                      <p>{f.detail}</p>
                      <Justify
                        subject={`${f.name} — Business partnership compatibility`}
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
                subject={`Business partnership between ${saved1?.label ?? "Partner 1"} and ${saved2?.label ?? "Partner 2"}`}
                basePrediction={result.verdictDescription}
                facts={overallGrounding.facts}
                references={overallGrounding.references}
                guidelines={[
                  "Examine all 6 partnership factors systematically.",
                  "Highlight which business areas are naturally aligned and which need contractual safeguards.",
                  "Suggest practical steps: role definition, financial agreements, communication cadence.",
                ]}
              />
            </div>
          )}

          {/* Export */}
          <button className="match-export-btn" onClick={() => setShowExport(true)}>
            ⬇ Export Partnership Report
          </button>

          <PartnershipExportReport
            chart1={chart1}
            chart2={chart2}
            result={result}
            label1={saved1?.label ?? "Partner 1"}
            label2={saved2?.label ?? "Partner 2"}
            open={showExport}
            onClose={() => setShowExport(false)}
            style={style}
          />
        </>
      )}
    </div>
  );
}
