import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { api, SavedChart } from "../api/client";
import { computeChart, ChartOptions } from "../astro/engine";
import { computeMatch, MatchResult, KutaScore } from "../astro/matchmaking";
import { matchGrounding, kutaGrounding, manglikGrounding } from "../astro/matchReferences";
import { Chart } from "../astro/types";
import { RASHIS, NAKSHATRAS } from "../astro/constants";
import Justify from "./Justify";
import MatchExportReport from "./MatchExportReport";
import NorthChart from "./NorthChart";
import SouthChart from "./SouthChart";

interface Props {
  /** The current chart in the main view (can pre-select as one partner). */
  currentChart: Chart | null;
  chartOptions: ChartOptions;
  style: "north" | "south";
}

const VERDICT_COLORS: Record<string, string> = {
  Excellent: "#22c55e",
  Good: "#3b82f6",
  Average: "#eab308",
  "Below Average": "#ef4444",
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

function KutaBar({ kuta }: { kuta: KutaScore }) {
  const pct = (kuta.points / kuta.maxPoints) * 100;
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

export default function MatchView({ currentChart, chartOptions, style }: Props) {
  const { user } = useAuth();
  const [charts, setCharts] = useState<SavedChart[]>([]);
  const [brideId, setBrideId] = useState("");
  const [groomId, setGroomId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [expandedKuta, setExpandedKuta] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    api
      .listCharts()
      .then((cs) => {
        setCharts(cs);
        // Auto-select if we have exactly 2
        if (cs.length >= 2 && !brideId && !groomId) {
          setGroomId(cs[0].id);
          setBrideId(cs[1].id);
        }
      })
      .catch(() => setError("Failed to load saved charts"))
      .finally(() => setLoading(false));
  }, [user]);

  const brideChart = useMemo(() => {
    const c = charts.find((c) => c.id === brideId);
    return c ? computeChart(c.birth, chartOptions) : null;
  }, [brideId, charts, chartOptions]);

  const groomChart = useMemo(() => {
    const c = charts.find((c) => c.id === groomId);
    return c ? computeChart(c.birth, chartOptions) : null;
  }, [groomId, charts, chartOptions]);

  const result = useMemo<MatchResult | null>(() => {
    if (!brideChart || !groomChart) return null;
    return computeMatch(brideChart, groomChart);
  }, [brideChart, groomChart]);

  // Grounding for overall Justify
  const overallGrounding = useMemo(() => {
    if (!result || !brideChart || !groomChart) return null;
    return matchGrounding(result, brideChart, groomChart);
  }, [result, brideChart, groomChart]);

  // --- Not signed in or no charts ---
  if (!user) {
    return (
      <div className="match-empty">
        <div className="match-empty-icon">💍</div>
        <h2>Marriage Match</h2>
        <p>
          Sign in and save at least two birth charts to compute Ashtakoot
          (Gun Milan) compatibility.
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
        <div className="match-empty-icon">💍</div>
        <h2>Marriage Match</h2>
        <p>
          You need at least <strong>two saved charts</strong> to compute compatibility.
          Save charts from the main Kundli view using your account menu.
        </p>
        <p className="muted small">
          You have {charts.length} saved chart{charts.length !== 1 ? "s" : ""}. Save{" "}
          {2 - charts.length} more.
        </p>
      </div>
    );
  }

  const brideSaved = charts.find((c) => c.id === brideId);
  const groomSaved = charts.find((c) => c.id === groomId);

  return (
    <div className="match-view">
      {/* ---- Chart Selector ---- */}
      <div className="match-selector">
        <div className="match-selector-col">
          <label className="match-role">
            <span className="match-role-icon">🤵</span> Groom
          </label>
          <select
            value={groomId}
            onChange={(e) => setGroomId(e.target.value)}
          >
            <option value="">— Select chart —</option>
            {charts.map((c) => (
              <option key={c.id} value={c.id} disabled={c.id === brideId}>
                {c.label} · {c.birth.placeLabel}
              </option>
            ))}
          </select>
          {groomSaved && (
            <p className="match-birth-info muted small">
              {String(groomSaved.birth.day).padStart(2, "0")}/
              {String(groomSaved.birth.month).padStart(2, "0")}/
              {groomSaved.birth.year} ·{" "}
              {String(groomSaved.birth.hour).padStart(2, "0")}:
              {String(groomSaved.birth.minute).padStart(2, "0")}
            </p>
          )}
        </div>

        <div className="match-vs">♥</div>

        <div className="match-selector-col">
          <label className="match-role">
            <span className="match-role-icon">👰</span> Bride
          </label>
          <select
            value={brideId}
            onChange={(e) => setBrideId(e.target.value)}
          >
            <option value="">— Select chart —</option>
            {charts.map((c) => (
              <option key={c.id} value={c.id} disabled={c.id === groomId}>
                {c.label} · {c.birth.placeLabel}
              </option>
            ))}
          </select>
          {brideSaved && (
            <p className="match-birth-info muted small">
              {String(brideSaved.birth.day).padStart(2, "0")}/
              {String(brideSaved.birth.month).padStart(2, "0")}/
              {brideSaved.birth.year} ·{" "}
              {String(brideSaved.birth.hour).padStart(2, "0")}:
              {String(brideSaved.birth.minute).padStart(2, "0")}
            </p>
          )}
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {/* ---- Results ---- */}
      {result && brideChart && groomChart && (
        <>
          {/* Score Dashboard */}
          <div className="match-dashboard">
            <div className="match-ring-area">
              <ScoreRing score={result.totalScore} max={36} verdict={result.verdict} />
              <p className="match-verdict-desc">{result.verdictDescription}</p>
            </div>

            {/* Side-by-side mini charts */}
            <div className="match-charts-row">
              <div className="match-mini-chart">
                <p className="match-mini-label">🤵 {groomSaved?.label}</p>
                {style === "south" ? (
                  <SouthChart chart={groomChart} mode="D1" />
                ) : (
                  <NorthChart chart={groomChart} mode="D1" />
                )}
                <p className="muted small">
                  Moon: {RASHIS[groomChart.planets.find((p) => p.planet === "Moon")!.signIndex].name},{" "}
                  {NAKSHATRAS[groomChart.planets.find((p) => p.planet === "Moon")!.nakshatraIndex].name}
                </p>
              </div>
              <div className="match-mini-chart">
                <p className="match-mini-label">👰 {brideSaved?.label}</p>
                {style === "south" ? (
                  <SouthChart chart={brideChart} mode="D1" />
                ) : (
                  <NorthChart chart={brideChart} mode="D1" />
                )}
                <p className="muted small">
                  Moon: {RASHIS[brideChart.planets.find((p) => p.planet === "Moon")!.signIndex].name},{" "}
                  {NAKSHATRAS[brideChart.planets.find((p) => p.planet === "Moon")!.nakshatraIndex].name}
                </p>
              </div>
            </div>
          </div>

          {/* Kuta Grid */}
          <h3 className="match-section-title">Ashtakoot — 8-factor breakdown</h3>
          <div className="kuta-grid">
            {result.kutas.map((k) => {
              const isExpanded = expandedKuta === k.name;
              const grounding = kutaGrounding(k);
              return (
                <div
                  className={`kuta-card${isExpanded ? " expanded" : ""}`}
                  key={k.name}
                >
                  <button
                    className="kuta-card-head"
                    onClick={() => setExpandedKuta(isExpanded ? null : k.name)}
                  >
                    <div className="kuta-card-top">
                      <span className="kuta-name">{k.name}</span>
                      <span className="kuta-score">
                        {k.points}/{k.maxPoints}
                      </span>
                    </div>
                    <KutaBar kuta={k} />
                    <p className="kuta-desc muted small">{k.description}</p>
                  </button>
                  {isExpanded && (
                    <div className="kuta-card-body">
                      <p>{k.detail}</p>
                      <Justify
                        subject={`${k.name} Kuta compatibility`}
                        basePrediction={k.detail}
                        facts={grounding.facts}
                        references={grounding.references}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Manglik Status */}
          <h3 className="match-section-title">Manglik (Kuja Dosha) Status</h3>
          <div className="manglik-row">
            <div className="manglik-card">
              <h4>🤵 {groomSaved?.label}</h4>
              <p className={`manglik-badge ${result.groomManglik.isManglik && !result.groomManglik.cancelled ? "dosha" : "ok"}`}>
                {result.groomManglik.isManglik
                  ? result.groomManglik.cancelled
                    ? "Manglik (Cancelled)"
                    : "Manglik ⚠"
                  : "Non-Manglik ✓"}
              </p>
              {result.groomManglik.isManglik && (
                <p className="muted small">
                  Mars in house {groomChart.planets.find((p) => p.planet === "Mars")!.house}.
                  {result.groomManglik.cancelled && ` ${result.groomManglik.cancellationReason}`}
                </p>
              )}
              <Justify
                subject="Groom's Manglik dosha"
                basePrediction={
                  result.groomManglik.isManglik
                    ? "Mars placement indicates Manglik dosha."
                    : "No Manglik dosha present."
                }
                facts={manglikGrounding(result.groomManglik, groomChart, "Groom").facts}
                references={manglikGrounding(result.groomManglik, groomChart, "Groom").references}
              />
            </div>
            <div className="manglik-card">
              <h4>👰 {brideSaved?.label}</h4>
              <p className={`manglik-badge ${result.brideManglik.isManglik && !result.brideManglik.cancelled ? "dosha" : "ok"}`}>
                {result.brideManglik.isManglik
                  ? result.brideManglik.cancelled
                    ? "Manglik (Cancelled)"
                    : "Manglik ⚠"
                  : "Non-Manglik ✓"}
              </p>
              {result.brideManglik.isManglik && (
                <p className="muted small">
                  Mars in house {brideChart.planets.find((p) => p.planet === "Mars")!.house}.
                  {result.brideManglik.cancelled && ` ${result.brideManglik.cancellationReason}`}
                </p>
              )}
              <Justify
                subject="Bride's Manglik dosha"
                basePrediction={
                  result.brideManglik.isManglik
                    ? "Mars placement indicates Manglik dosha."
                    : "No Manglik dosha present."
                }
                facts={manglikGrounding(result.brideManglik, brideChart, "Bride").facts}
                references={manglikGrounding(result.brideManglik, brideChart, "Bride").references}
              />
            </div>
          </div>

          {!result.manglikCompatible && (
            <p className="match-manglik-warn">
              ⚠ One partner is Manglik and the other is not. Classical texts advise matching
              Manglik with Manglik, or seeking specific remedies (Kumbh Vivah, etc.).
            </p>
          )}

          {/* Overall Justify */}
          {overallGrounding && (
            <div className="match-overall-justify">
              <Justify
                subject={`Marriage compatibility between ${groomSaved?.label ?? "Groom"} and ${brideSaved?.label ?? "Bride"}`}
                basePrediction={result.verdictDescription}
                facts={overallGrounding.facts}
                references={overallGrounding.references}
                guidelines={[
                  "Examine all 8 kutas systematically, noting which are strong and which are weak.",
                  "Consider Manglik dosha and any cancellations.",
                  "Comment on the overall suitability and any specific areas that need attention or remedies.",
                ]}
              />
            </div>
          )}

          {/* Export */}
          <button
            className="match-export-btn"
            onClick={() => setShowExport(true)}
          >
            ⬇ Export Match Report
          </button>

          <MatchExportReport
            brideChart={brideChart}
            groomChart={groomChart}
            result={result}
            brideLabel={brideSaved?.label ?? "Bride"}
            groomLabel={groomSaved?.label ?? "Groom"}
            open={showExport}
            onClose={() => setShowExport(false)}
            style={style}
          />
        </>
      )}
    </div>
  );
}
