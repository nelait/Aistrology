import { useEffect, useMemo, useState, useCallback } from "react";
import { useAuth } from "../auth/AuthProvider";
import { api, VastuLlmResponse } from "../api/client";
import { computeChart, ChartOptions } from "../astro/engine";
import {
  analyseVastu,
  VastuResult,
  VastuQuestionnaire,
  Direction,
  PlotShape,
  SlopeDirection,
} from "../astro/vastu";
import { vastuFullGrounding, vastuRoomGrounding, vastuAstroGrounding } from "../astro/vastuReferences";
import { Chart } from "../astro/types";
import { RASHIS } from "../astro/constants";
import Justify from "./Justify";
import { AskAiButton, usePublishChatContext } from "../chat/AstroChat";
import PlanGate from "./PlanGate";
import VastuExportReport from "./VastuExportReport";

interface Props {
  currentChart: Chart | null;
  chartOptions: ChartOptions;
  style: "north" | "south";
  chartId?: string | null;
}

// ── Constants ──────────────────────────────────────────────────────────

const DIRECTIONS: Direction[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const DIRECTION_LABELS: Record<Direction, string> = {
  N: "North", NE: "North-East", E: "East", SE: "South-East",
  S: "South", SW: "South-West", W: "West", NW: "North-West",
};
const SHAPES: PlotShape[] = ["square", "rectangle", "L-shaped", "irregular"];
const SLOPES: SlopeDirection[] = ["N", "NE", "E", "SE", "flat", "S", "SW", "W", "NW"];

const SEVERITY_COLORS = { good: "#22c55e", moderate: "#eab308", bad: "#ef4444" };
const SEVERITY_ICONS = { good: "✅", moderate: "⚠️", bad: "❌" };

// ── Score ring (reused pattern) ────────────────────────────────────────

function SuitabilityRing({ score }: { score: number }) {
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
      <text x="64" y="72" textAnchor="middle" fontSize="12" fill="rgba(255,255,255,0.5)">Suitability</text>
      <text x="64" y="92" textAnchor="middle" fontSize="13" fontWeight="600" fill={color}>
        {score >= 80 ? "Excellent" : score >= 65 ? "Good" : score >= 45 ? "Moderate" : "Needs Work"}
      </text>
    </svg>
  );
}

// ── Direction selector ─────────────────────────────────────────────────

function DirSelect({ label, value, onChange, id }: { label: string; value: Direction; onChange: (d: Direction) => void; id: string }) {
  return (
    <label className="vastu-field">
      <span>{label}</span>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as Direction)}>
        {DIRECTIONS.map((d) => (
          <option key={d} value={d}>{DIRECTION_LABELS[d]}</option>
        ))}
      </select>
    </label>
  );
}

// ── Default questionnaire ──────────────────────────────────────────────

const DEFAULT_Q: VastuQuestionnaire = {
  facingDirection: "E",
  entrancePosition: "E",
  kitchenLocation: "SE",
  masterBedroom: "SW",
  bathroomLocation: "NW",
  waterSource: "NE",
  staircasePosition: "SW",
  poojaRoom: "NE",
  gardenOrOpenSpace: "N",
  garage: "NW",
  plotShape: "rectangle",
  landSlope: "NE",
};

// ── Main component ─────────────────────────────────────────────────────

export default function VastuView({ currentChart, chartOptions, style, chartId }: Props) {
  const { user } = useAuth();
  const [q, setQ] = useState<VastuQuestionnaire>(DEFAULT_Q);
  const [result, setResult] = useState<VastuResult | null>(null);
  const [llmResult, setLlmResult] = useState<VastuLlmResponse | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [floorPlan, setFloorPlan] = useState<string | null>(null); // base64
  const [floorPlanPreview, setFloorPlanPreview] = useState<string | null>(null);
  const [step, setStep] = useState<"form" | "results">("form");
  const [showExport, setShowExport] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [hasSaved, setHasSaved] = useState(false);

  const isFree = (user?.plan ?? "free") === "free";

  // Publish computed vastu findings so free-typed chat questions are grounded.
  const chatFindings = useMemo(() => {
    if (!result) return null;
    return [
      `Vastu suitability score: ${result.overallScore}/100 — ${result.overallVerdict}.`,
      ...result.roomFactors.map((f) => `Vastu (room) ${f.area}: ${f.severity} — ${f.finding}`),
      ...result.astroFactors.map((f) => `Vastu (astro) ${f.factor}: ${f.severity} — ${f.finding}`),
    ];
  }, [result]);
  usePublishChatContext(chatFindings);

  // Load saved Vastu settings when chartId changes
  useEffect(() => {
    if (!chartId) { setHasSaved(false); return; }
    let cancelled = false;
    api.getVastuSettings(chartId).then((saved) => {
      if (cancelled) return;
      if (saved) {
        setQ(saved.questionnaire as VastuQuestionnaire);
        if (saved.floorPlan) {
          setFloorPlan(saved.floorPlan);
          setFloorPlanPreview(saved.floorPlan);
        } else {
          setFloorPlan(null);
          setFloorPlanPreview(null);
        }
        setHasSaved(true);
      } else {
        setQ(DEFAULT_Q);
        setFloorPlan(null);
        setFloorPlanPreview(null);
        setHasSaved(false);
      }
    }).catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [chartId]);

  // Update a questionnaire field
  const setField = useCallback(<K extends keyof VastuQuestionnaire>(key: K, val: VastuQuestionnaire[K]) => {
    setQ((prev) => ({ ...prev, [key]: val }));
  }, []);

  // Save Vastu settings to the profile
  const saveSettings = useCallback(async () => {
    if (!chartId) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      await api.saveVastuSettings(chartId, q, floorPlan);
      setHasSaved(true);
      setSaveMsg("✅ Vastu settings saved!");
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (err) {
      setSaveMsg("❌ Failed to save");
    } finally {
      setSaving(false);
    }
  }, [chartId, q, floorPlan]);

  // Handle floor plan upload
  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setLlmError("Floor plan image must be under 2MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setFloorPlan(dataUrl);
      setFloorPlanPreview(dataUrl);
      setLlmError(null);
    };
    reader.readAsDataURL(file);
  }, []);

  // Run analysis
  const analyse = useCallback(() => {
    if (!currentChart) return;
    const r = analyseVastu(currentChart, q);
    setResult(r);
    setStep("results");
    setLlmResult(null);
  }, [currentChart, q]);

  // Get LLM-enhanced analysis
  const runLlmAnalysis = useCallback(async () => {
    if (!result || !currentChart) return;

    setLlmLoading(true);
    setLlmError(null);
    try {
      const lagnaSign = RASHIS[currentChart.ascendantSign];
      const chartSummary = [
        `Lagna: ${lagnaSign}`,
        ...currentChart.planets.map((p) => `${p.planet} in ${RASHIS[p.signIndex]} (house ${p.house}${p.retrograde ? ", retrograde" : ""})`),
      ].join("; ");

      const vastuSummary = [
        `Overall score: ${result.overallScore}/100 — ${result.overallVerdict}`,
        ...result.roomFactors.map((f) => `${f.area}: ${f.severity} (${f.score}/10) — ${f.finding}`),
        ...result.astroFactors.map((f) => `${f.factor}: ${f.severity} (${f.score}/10) — ${f.finding}`),
      ].join("\n");

      const references = vastuFullGrounding(result);

      const resp = await api.analyseVastu({
        chartSummary,
        vastuSummary,
        references,
        floorPlanBase64: floorPlan ?? undefined,
      });
      setLlmResult(resp);
    } catch (err) {
      setLlmError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setLlmLoading(false);
    }
  }, [result, currentChart, floorPlan]);

  if (!currentChart) {
    return (
      <div className="vastu-empty">
        <p className="muted">Cast a birth chart first to use Vastu analysis.</p>
      </div>
    );
  }

  return (
    <div className="vastu-view">
      <div className="vastu-header">
        <h2>🏠 Vastu Analysis</h2>
        <p className="muted">Analyse your property's Vastu compliance based on your birth chart.</p>
      </div>

      {step === "form" && (
        <div className="vastu-form">
          <h3>Property Details</h3>
          <p className="muted small">Answer the questions below about your property. All directions refer to compass directions.</p>

          <div className="vastu-grid">
            <DirSelect label="🏗️ Property Facing Direction" value={q.facingDirection} onChange={(v) => setField("facingDirection", v)} id="vastu-facing" />
            <DirSelect label="🚪 Main Entrance Position" value={q.entrancePosition} onChange={(v) => setField("entrancePosition", v)} id="vastu-entrance" />
            <DirSelect label="🍳 Kitchen Location" value={q.kitchenLocation} onChange={(v) => setField("kitchenLocation", v)} id="vastu-kitchen" />
            <DirSelect label="🛏️ Master Bedroom" value={q.masterBedroom} onChange={(v) => setField("masterBedroom", v)} id="vastu-bedroom" />
            <DirSelect label="🚿 Bathroom Location" value={q.bathroomLocation} onChange={(v) => setField("bathroomLocation", v)} id="vastu-bathroom" />
            <DirSelect label="💧 Water Source / Tank" value={q.waterSource} onChange={(v) => setField("waterSource", v)} id="vastu-water" />
            <DirSelect label="🪜 Staircase Position" value={q.staircasePosition} onChange={(v) => setField("staircasePosition", v)} id="vastu-staircase" />
            <DirSelect label="🕉️ Pooja Room" value={q.poojaRoom} onChange={(v) => setField("poojaRoom", v)} id="vastu-pooja" />
            <DirSelect label="🌿 Garden / Open Space" value={q.gardenOrOpenSpace} onChange={(v) => setField("gardenOrOpenSpace", v)} id="vastu-garden" />
            <DirSelect label="🚗 Garage / Parking" value={q.garage} onChange={(v) => setField("garage", v)} id="vastu-garage" />

            <label className="vastu-field">
              <span>📐 Plot Shape</span>
              <select id="vastu-shape" value={q.plotShape} onChange={(e) => setField("plotShape", e.target.value as PlotShape)}>
                {SHAPES.map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
              </select>
            </label>

            <label className="vastu-field">
              <span>⛰️ Land Slope</span>
              <select id="vastu-slope" value={q.landSlope} onChange={(e) => setField("landSlope", e.target.value as SlopeDirection)}>
                {SLOPES.map((s) => <option key={s} value={s}>{s === "flat" ? "Flat" : DIRECTION_LABELS[s as Direction]}</option>)}
              </select>
            </label>
          </div>

          {/* Floor plan upload */}
          <div className="vastu-upload-section">
            <h3>📋 Floor Plan (Optional)</h3>
            <p className="muted small">Upload a floor plan image for AI-powered layout analysis. Max 2MB, JPG or PNG.</p>
            <PlanGate requiredPlan="pro" featureName="Floor Plan Analysis">
              <div className="vastu-upload-area">
                <input
                  type="file"
                  id="vastu-floor-plan"
                  accept="image/jpeg,image/png"
                  onChange={handleFileUpload}
                  className="vastu-file-input"
                />
                <label htmlFor="vastu-floor-plan" className="vastu-upload-label">
                  {floorPlanPreview ? "Change image" : "📎 Choose file or drag & drop"}
                </label>
                {floorPlanPreview && (
                  <div className="vastu-preview">
                    <img src={floorPlanPreview} alt="Floor plan preview" />
                    <button className="vastu-remove-btn" onClick={() => { setFloorPlan(null); setFloorPlanPreview(null); }}>✕ Remove</button>
                  </div>
                )}
              </div>
            </PlanGate>
          </div>

          <div className="vastu-form-actions">
            <button className="vastu-analyse-btn" onClick={analyse}>
              🔍 Analyse Vastu Suitability
            </button>
            {chartId && (
              <button className="vastu-save-btn" onClick={saveSettings} disabled={saving}>
                {saving ? "Saving…" : hasSaved ? "💾 Update Settings" : "💾 Save Settings"}
              </button>
            )}
            {!chartId && user && (
              <p className="muted small" style={{ textAlign: "center", marginTop: 8 }}>
                Load a saved profile to save Vastu settings.
              </p>
            )}
            {saveMsg && <p className="vastu-save-msg">{saveMsg}</p>}
          </div>
        </div>
      )}

      {step === "results" && result && (
        <div className="vastu-results">
          <div className="vastu-results-actions">
            <button className="vastu-back-btn" onClick={() => setStep("form")}>← Edit Property Details</button>
            <button className="vastu-export-btn" onClick={() => setShowExport(true)}>📄 Export Report</button>
          </div>

          {/* Score ring */}
          <div className="vastu-score-section">
            <SuitabilityRing score={result.overallScore} />
            <p className="vastu-verdict">{result.overallVerdict}</p>
            <AskAiButton
              prompt={`My property scored ${result.overallScore}/100 on Vastu (${result.overallVerdict}). The main issues are: ${[...result.roomFactors, ...result.astroFactors].filter((f) => f.severity !== "good").slice(0, 5).map((f) => ("area" in f ? f.area : f.factor) + " — " + f.finding).join("; ") || "none major"}. What should I prioritise fixing, and how?`}
            />
          </div>

          {/* Room-by-room analysis */}
          <div className="vastu-section">
            <h3>🏗️ Room-by-Room Analysis</h3>
            <div className="vastu-factors">
              {result.roomFactors.map((f, i) => (
                <div key={i} className={`vastu-factor severity-${f.severity}`}>
                  <div className="vastu-factor-header">
                    <span className="vastu-factor-icon">{SEVERITY_ICONS[f.severity]}</span>
                    <strong>{f.area}</strong>
                    <span className="vastu-factor-score" style={{ color: SEVERITY_COLORS[f.severity] }}>
                      {f.score}/10
                    </span>
                  </div>
                  <p className="vastu-factor-finding">{f.finding}</p>
                  {f.remedy && (
                    <div className="vastu-remedy">
                      <span className="vastu-remedy-label">💡 Remedy:</span>
                      <span>{f.remedy}</span>
                    </div>
                  )}
                  <Justify
                    subject={`Vastu: ${f.area}`}
                    basePrediction={f.finding}
                    references={vastuRoomGrounding(f).map((text) => ({ text, source: "Classical Vastu Shastra" }))}
                    facts={[`Lagna: ${RASHIS[currentChart.ascendantSign]}`, `${f.area} direction: ${f.severity}`]}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Astrological factors */}
          <div className="vastu-section">
            <h3>🪐 Astrological Compatibility</h3>
            <div className="vastu-factors">
              {result.astroFactors.map((f, i) => (
                <div key={i} className={`vastu-factor severity-${f.severity}`}>
                  <div className="vastu-factor-header">
                    <span className="vastu-factor-icon">{SEVERITY_ICONS[f.severity]}</span>
                    <strong>{f.factor}</strong>
                    <span className="vastu-factor-score" style={{ color: SEVERITY_COLORS[f.severity] }}>
                      {f.score}/10
                    </span>
                  </div>
                  <p className="vastu-factor-finding">{f.finding}</p>
                  <Justify
                    subject={f.factor}
                    basePrediction={f.finding}
                    references={vastuAstroGrounding(f).map((text) => ({ text, source: "Jyotish–Vastu Literature" }))}
                    facts={[`Lagna: ${RASHIS[currentChart.ascendantSign]}`]}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Top remedies */}
          {result.topRemedies.length > 0 && (
            <div className="vastu-section">
              <h3>🛡️ Priority Remedies</h3>
              <ul className="vastu-remedies-list">
                {result.topRemedies.map((r, i) => (
                  <li key={i} dangerouslySetInnerHTML={{ __html: r.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>") }} />
                ))}
              </ul>
            </div>
          )}

          {/* LLM-enhanced analysis */}
          <div className="vastu-section">
            <h3>🤖 AI-Enhanced Analysis</h3>
            <PlanGate requiredPlan="pro" featureName="AI Vastu Analysis">
              {!llmResult && !llmLoading && (
                <button className="vastu-llm-btn" onClick={runLlmAnalysis} disabled={llmLoading}>
                  {floorPlan ? "🔍 Analyse with Floor Plan" : "🔍 Get AI Analysis"}
                </button>
              )}
              {llmLoading && <p className="muted vastu-loading">Analysing… this may take a moment.</p>}
              {llmError && <p className="error small">{llmError}</p>}
              {llmResult && (
                <div className="vastu-llm-result">
                  <div className="vastu-llm-block">
                    <h4>Analysis</h4>
                    <p>{llmResult.analysis}</p>
                  </div>
                  {llmResult.floorPlanObservations && (
                    <div className="vastu-llm-block">
                      <h4>📋 Floor Plan Observations</h4>
                      <p>{llmResult.floorPlanObservations}</p>
                    </div>
                  )}
                  {llmResult.additionalRemedies.length > 0 && (
                    <div className="vastu-llm-block">
                      <h4>Additional Remedies</h4>
                      <ul>
                        {llmResult.additionalRemedies.map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                    </div>
                  )}
                  <p className="muted small" style={{ marginTop: 8 }}>
                  Powered by {llmResult.provider} · Results grounded in classical Vastu Shastra texts
                  </p>
                </div>
              )}
            </PlanGate>
          </div>
        </div>
      )}

      {/* Export overlay */}
      {currentChart && result && (
        <VastuExportReport
          chart={currentChart}
          result={result}
          questionnaire={q}
          llmResult={llmResult}
          label={currentChart.birth.name}
          open={showExport}
          onClose={() => setShowExport(false)}
          style={style}
          floorPlan={floorPlan}
        />
      )}
    </div>
  );
}
