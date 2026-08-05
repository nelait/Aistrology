import { Chart } from "../astro/types";
import { VastuResult, VastuQuestionnaire } from "../astro/vastu";
import { VastuLlmResponse } from "../api/client";
import { RASHIS, NAKSHATRAS } from "../astro/constants";
import { formatTz } from "../utils/format";

interface Props {
  chart: Chart;
  result: VastuResult;
  questionnaire: VastuQuestionnaire;
  llmResult?: VastuLlmResponse | null;
  label: string;
  open: boolean;
  onClose: () => void;
  style: "north" | "south";
  floorPlan?: string | null;
}

const SEVERITY_COLORS: Record<string, string> = { good: "#22c55e", moderate: "#eab308", bad: "#ef4444" };
const DIR_LABELS: Record<string, string> = {
  N: "North", NE: "North-East", E: "East", SE: "South-East",
  S: "South", SW: "South-West", W: "West", NW: "North-West",
};

export default function VastuExportReport({ chart, result, questionnaire, llmResult, label, open, onClose, floorPlan }: Props) {
  if (!open) return null;

  const b = chart.birth;
  const moon = chart.planets.find((p) => p.planet === "Moon")!;

  return (
    <div className="export-overlay" onClick={onClose}>
      <div className="export-shell" onClick={(e) => e.stopPropagation()}>
        <div className="export-actions">
          <div />
          <div>
            <button className="primary" onClick={() => window.print()}>Print / Save as PDF</button>
            <button className="ghost" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="chart-report match-report">
          <header className="report-head">
            <h1>☸ Aistrology — Vastu Analysis Report</h1>
            <p className="report-native"><strong>{label}</strong></p>
          </header>

          <section className="career-report-profile">
            <div>
              <p>
                {String(b.day).padStart(2, "0")}/{String(b.month).padStart(2, "0")}/{b.year}{" "}
                · {String(b.hour).padStart(2, "0")}:{String(b.minute).padStart(2, "0")}{" "}
                · {b.placeLabel} ({formatTz(b.tzOffsetHours)})
              </p>
              <p className="muted">
                Lagna: {RASHIS[chart.ascendantSign].name} · Moon: {RASHIS[moon.signIndex].name}, {NAKSHATRAS[moon.nakshatraIndex].name} (pada {moon.pada})
              </p>
              <p className="muted">
                Vastu Score: <strong>{result.overallScore}/100</strong> — {result.overallScore >= 75 ? "Excellent" : result.overallScore >= 55 ? "Good" : result.overallScore >= 35 ? "Moderate" : "Needs Work"}
              </p>
            </div>
            {floorPlan ? (
              <div className="match-report-chart vastu-report-plan">
                <img src={floorPlan} alt="Floor Plan" style={{ maxWidth: "100%", maxHeight: 200, borderRadius: 8, objectFit: "contain" }} />
              </div>
            ) : (
              <div className="match-report-chart vastu-report-plan" style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13 }}>
                No floor plan uploaded
              </div>
            )}
          </section>

          {/* Property Details */}
          <section>
            <h2>Property Details</h2>
            <table className="report-table">
              <thead><tr><th>Property</th><th>Value</th></tr></thead>
              <tbody>
                <tr><td>Facing Direction</td><td>{DIR_LABELS[questionnaire.facingDirection] ?? questionnaire.facingDirection}</td></tr>
                <tr><td>Main Entrance</td><td>{DIR_LABELS[questionnaire.entrancePosition] ?? questionnaire.entrancePosition}</td></tr>
                <tr><td>Kitchen</td><td>{DIR_LABELS[questionnaire.kitchenLocation] ?? questionnaire.kitchenLocation}</td></tr>
                <tr><td>Master Bedroom</td><td>{DIR_LABELS[questionnaire.masterBedroom] ?? questionnaire.masterBedroom}</td></tr>
                <tr><td>Bathroom</td><td>{DIR_LABELS[questionnaire.bathroomLocation] ?? questionnaire.bathroomLocation}</td></tr>
                <tr><td>Water Source</td><td>{DIR_LABELS[questionnaire.waterSource] ?? questionnaire.waterSource}</td></tr>
                <tr><td>Staircase</td><td>{DIR_LABELS[questionnaire.staircasePosition] ?? questionnaire.staircasePosition}</td></tr>
                <tr><td>Pooja Room</td><td>{DIR_LABELS[questionnaire.poojaRoom] ?? questionnaire.poojaRoom}</td></tr>
                <tr><td>Garden / Open Space</td><td>{DIR_LABELS[questionnaire.gardenOrOpenSpace] ?? questionnaire.gardenOrOpenSpace}</td></tr>
                <tr><td>Garage</td><td>{DIR_LABELS[questionnaire.garage] ?? questionnaire.garage}</td></tr>
                <tr><td>Plot Shape</td><td>{questionnaire.plotShape}</td></tr>
                <tr><td>Land Slope</td><td>{questionnaire.landSlope === "flat" ? "Flat" : DIR_LABELS[questionnaire.landSlope] ?? questionnaire.landSlope}</td></tr>
              </tbody>
            </table>
          </section>

          {/* Room-by-Room Analysis */}
          <section>
            <h2>Room-by-Room Analysis</h2>
            <table className="report-table">
              <thead><tr><th>Area</th><th>Score</th><th>Status</th><th>Finding</th><th>Remedy</th></tr></thead>
              <tbody>
                {result.roomFactors.map((f) => (
                  <tr key={f.area}>
                    <td><strong>{f.area}</strong></td>
                    <td>{f.score}/10</td>
                    <td><span style={{ color: SEVERITY_COLORS[f.severity], fontWeight: 700 }}>{f.severity.toUpperCase()}</span></td>
                    <td>{f.finding}</td>
                    <td>{f.remedy ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* Astrological Factors */}
          <section>
            <h2>Astrological Compatibility</h2>
            <table className="report-table">
              <thead><tr><th>Factor</th><th>Score</th><th>Status</th><th>Finding</th></tr></thead>
              <tbody>
                {result.astroFactors.map((f) => (
                  <tr key={f.factor}>
                    <td><strong>{f.factor}</strong></td>
                    <td>{f.score}/10</td>
                    <td><span style={{ color: SEVERITY_COLORS[f.severity], fontWeight: 700 }}>{f.severity.toUpperCase()}</span></td>
                    <td>{f.finding}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* Top Remedies */}
          {result.topRemedies.length > 0 && (
            <section>
              <h2>Priority Remedies</h2>
              <ol>
                {result.topRemedies.map((r, i) => <li key={i}>{r.replace(/\*\*(.*?)\*\*/g, "$1")}</li>)}
              </ol>
            </section>
          )}

          {/* AI Analysis (if available) */}
          {llmResult && (
            <section>
              <h2>AI-Enhanced Analysis</h2>
              <p>{llmResult.analysis}</p>
              {llmResult.floorPlanObservations && (
                <>
                  <h3>Floor Plan Observations</h3>
                  <p>{llmResult.floorPlanObservations}</p>
                </>
              )}
              {llmResult.additionalRemedies.length > 0 && (
                <>
                  <h3>Additional Remedies</h3>
                  <ol>
                    {llmResult.additionalRemedies.map((r, i) => <li key={i}>{r}</li>)}
                  </ol>
                </>
              )}
            </section>
          )}




          <footer className="report-foot">
            Generated by Aistrology · Vastu Analysis · for learning and reflection only. <strong>This is not professional architectural or Vastu advice.</strong> Always consult qualified Vastu consultants.
          </footer>
        </div>
      </div>
    </div>
  );
}
