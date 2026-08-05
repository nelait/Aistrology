import { Chart } from "../astro/types";
import { PartnershipResult } from "../astro/partnership";
import { RASHIS, NAKSHATRAS, GRAHA_BY_NAME } from "../astro/constants";
import { formatDegInSign, formatTz } from "../utils/format";
import NorthChart from "./NorthChart";
import SouthChart from "./SouthChart";

interface Props {
  chart1: Chart;
  chart2: Chart;
  result: PartnershipResult;
  label1: string;
  label2: string;
  open: boolean;
  onClose: () => void;
  style: "north" | "south";
}

export default function PartnershipExportReport({
  chart1, chart2, result, label1, label2, open, onClose, style,
}: Props) {
  if (!open) return null;

  const ChartFor = ({ chart }: { chart: Chart }) =>
    style === "south" ? <SouthChart chart={chart} mode="D1" /> : <NorthChart chart={chart} mode="D1" />;

  const b1 = chart1.birth;
  const b2 = chart2.birth;
  const moon1 = chart1.planets.find((p) => p.planet === "Moon")!;
  const moon2 = chart2.planets.find((p) => p.planet === "Moon")!;

  const VERDICT_EMOJI: Record<string, string> = {
    "Power Duo": "🚀",
    "Strong Alliance": "🔵",
    Workable: "🟡",
    Challenging: "🔴",
  };

  return (
    <div className="export-overlay" onClick={onClose}>
      <div className="export-shell" onClick={(e) => e.stopPropagation()}>
        <div className="export-actions">
          <div />
          <div>
            <button className="primary" onClick={() => window.print()}>
              Print / Save as PDF
            </button>
            <button className="ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="chart-report match-report">
          <header className="report-head">
            <h1>☸ Aistrology — Business Partnership Report</h1>
            <p className="report-native">
              <strong>{label1}</strong> ⚡ <strong>{label2}</strong>
            </p>
          </header>

          {/* Birth Details */}
          <section className="match-report-pair">
            <div className="match-report-person">
              <h3>💼 {label1}</h3>
              <p>
                {String(b1.day).padStart(2, "0")}/{String(b1.month).padStart(2, "0")}/{b1.year}{" "}
                · {String(b1.hour).padStart(2, "0")}:{String(b1.minute).padStart(2, "0")}{" "}
                · {b1.placeLabel} ({formatTz(b1.tzOffsetHours)})
              </p>
              <p className="muted">
                Moon: {RASHIS[moon1.signIndex].name},{" "}
                {NAKSHATRAS[moon1.nakshatraIndex].name} (pada {moon1.pada})
              </p>
              <div className="match-report-chart"><ChartFor chart={chart1} /></div>
            </div>
            <div className="match-report-person">
              <h3>💼 {label2}</h3>
              <p>
                {String(b2.day).padStart(2, "0")}/{String(b2.month).padStart(2, "0")}/{b2.year}{" "}
                · {String(b2.hour).padStart(2, "0")}:{String(b2.minute).padStart(2, "0")}{" "}
                · {b2.placeLabel} ({formatTz(b2.tzOffsetHours)})
              </p>
              <p className="muted">
                Moon: {RASHIS[moon2.signIndex].name},{" "}
                {NAKSHATRAS[moon2.nakshatraIndex].name} (pada {moon2.pada})
              </p>
              <div className="match-report-chart"><ChartFor chart={chart2} /></div>
            </div>
          </section>

          {/* Score */}
          <section>
            <h2>
              {VERDICT_EMOJI[result.verdict]} Partnership Score: {result.totalScore} / {result.maxScore} — {result.verdict}
            </h2>
            <p>{result.verdictDescription}</p>
          </section>

          {/* Factor Table */}
          <section>
            <h2>Factor Breakdown</h2>
            <table className="report-table">
              <thead>
                <tr>
                  <th>Factor</th>
                  <th>Max</th>
                  <th>Score</th>
                  <th>Description</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {result.factors.map((f) => (
                  <tr key={f.name}>
                    <td><strong>{f.name}</strong></td>
                    <td>{f.maxPoints}</td>
                    <td>
                      <strong style={{
                        color: f.points >= f.maxPoints * 0.75 ? "#22c55e"
                          : f.points <= f.maxPoints * 0.25 ? "#ef4444" : "#eab308",
                      }}>
                        {f.points}
                      </strong>
                    </td>
                    <td>{f.description}</td>
                    <td>{f.detail}</td>
                  </tr>
                ))}
                <tr className="report-total">
                  <td><strong>Total</strong></td>
                  <td><strong>{result.maxScore}</strong></td>
                  <td><strong>{result.totalScore}</strong></td>
                  <td colSpan={2}>{result.verdict} ({result.percentage}%)</td>
                </tr>
              </tbody>
            </table>
          </section>

          {/* Planetary Positions */}
          <section>
            <h2>Planetary Positions</h2>
            {[
              { label: label1, chart: chart1 },
              { label: label2, chart: chart2 },
            ].map(({ label, chart }) => (
              <div key={label} className="report-item">
                <h3>💼 {label}</h3>
                <table className="report-table">
                  <thead>
                    <tr>
                      <th>Graha</th>
                      <th>Sign</th>
                      <th>Degree</th>
                      <th>Ho.</th>
                      <th>Nakshatra</th>
                      <th>Dignity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chart.planets.map((p) => (
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
              </div>
            ))}
          </section>

          <footer className="report-foot">
            Generated by Aistrology · Business Partnership Analysis · for learning
            and reflection, not medical, legal, financial or psychological advice.
          </footer>
        </div>
      </div>
    </div>
  );
}
