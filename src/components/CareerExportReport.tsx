import { Chart } from "../astro/types";
import { CareerResult } from "../astro/career";
import { RASHIS, NAKSHATRAS, GRAHA_BY_NAME } from "../astro/constants";
import { formatDegInSign, formatTz } from "../utils/format";
import NorthChart from "./NorthChart";
import SouthChart from "./SouthChart";

interface Props {
  chart: Chart;
  result: CareerResult;
  label: string;
  open: boolean;
  onClose: () => void;
  style: "north" | "south";
}

export default function CareerExportReport({
  chart, result, label, open, onClose, style,
}: Props) {
  if (!open) return null;

  const ChartFor = ({ chart: c }: { chart: Chart }) =>
    style === "south" ? <SouthChart chart={c} mode="D1" /> : <NorthChart chart={c} mode="D1" />;

  const b = chart.birth;
  const moon = chart.planets.find((p) => p.planet === "Moon")!;

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
            <h1>☸ Aistrology — Career Suggestions Report</h1>
            <p className="report-native"><strong>{label}</strong></p>
          </header>

          {/* Birth Details */}
          <section className="career-report-profile">
            <div>
              <p>
                {String(b.day).padStart(2, "0")}/{String(b.month).padStart(2, "0")}/{b.year}{" "}
                · {String(b.hour).padStart(2, "0")}:{String(b.minute).padStart(2, "0")}{" "}
                · {b.placeLabel} ({formatTz(b.tzOffsetHours)})
              </p>
              <p className="muted">
                Lagna: {RASHIS[chart.ascendantSign].name} ·{" "}
                Moon: {RASHIS[moon.signIndex].name},{" "}
                {NAKSHATRAS[moon.nakshatraIndex].name} (pada {moon.pada})
              </p>
              <p className="muted">
                Strongest planet: {result.strongestPlanet} · Career element: {result.careerElement}
              </p>
            </div>
            <div className="match-report-chart"><ChartFor chart={chart} /></div>
          </section>

          {/* Summary */}
          <section>
            <h2>Career Profile Summary</h2>
            <p>{result.tenthHouseSummary}</p>
          </section>

          {/* Top Domains */}
          <section>
            <h2>Recommended Career Domains</h2>
            <table className="report-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Domain</th>
                  <th>Match</th>
                  <th>Key Areas</th>
                  <th>Reasoning</th>
                </tr>
              </thead>
              <tbody>
                {result.topDomains.map((d, i) => (
                  <tr key={d.name}>
                    <td>{i + 1}</td>
                    <td><strong>{d.icon} {d.name}</strong></td>
                    <td>
                      <strong style={{
                        color: d.score >= 75 ? "#22c55e" : d.score >= 50 ? "#3b82f6" : "#eab308",
                      }}>
                        {d.score}%
                      </strong>
                    </td>
                    <td>{d.keywords.join(", ")}</td>
                    <td>{d.reasoning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* Factors */}
          <section>
            <h2>Astrological Factors</h2>
            {result.factors.map((f) => (
              <div key={f.name} className="report-item">
                <h3>{f.name}</h3>
                <p className="muted">{f.description}</p>
                <p>{f.detail}</p>
              </div>
            ))}
          </section>

          {/* Planetary Positions */}
          <section>
            <h2>Planetary Positions</h2>
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
          </section>

          <footer className="report-foot">
            Generated by Aistrology · Career Suggestions · for learning and reflection,
            not medical, legal, financial or psychological advice.
          </footer>
        </div>
      </div>
    </div>
  );
}
