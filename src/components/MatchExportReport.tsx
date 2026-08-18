import { Chart } from "../astro/types";
import { MatchResult } from "../astro/matchmaking";
import { RASHIS, NAKSHATRAS, GRAHA_BY_NAME } from "../astro/constants";
import { formatDegInSign, formatTz } from "../utils/format";
import NorthChart from "./NorthChart";
import SouthChart from "./SouthChart";

interface Props {
  brideChart: Chart;
  groomChart: Chart;
  result: MatchResult;
  brideLabel: string;
  groomLabel: string;
  open: boolean;
  onClose: () => void;
  style: "north" | "south";
}

// Print-friendly marriage match report. Uses browser Print / Save as PDF,
// following the same pattern as ExportReport.tsx.
export default function MatchExportReport({
  brideChart,
  groomChart,
  result,
  brideLabel,
  groomLabel,
  open,
  onClose,
  style,
}: Props) {
  if (!open) return null;

  const ChartFor = ({ chart }: { chart: Chart }) =>
    style === "south" ? (
      <SouthChart chart={chart} mode="D1" />
    ) : (
      <NorthChart chart={chart} mode="D1" />
    );

  const bb = brideChart.birth;
  const gb = groomChart.birth;
  const brideMoon = brideChart.planets.find((p) => p.planet === "Moon")!;
  const groomMoon = groomChart.planets.find((p) => p.planet === "Moon")!;

  const VERDICT_EMOJI: Record<string, string> = {
    Excellent: "🟢",
    Good: "🔵",
    Average: "🟡",
    "Below Average": "🔴",
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
            <h1>☸ Shastri — Marriage Match Report</h1>
            <p className="report-native">
              <strong>{groomLabel}</strong> (Groom) ♥ <strong>{brideLabel}</strong> (Bride)
            </p>
          </header>

          {/* Birth Details Side by Side */}
          <section className="match-report-pair">
            <div className="match-report-person">
              <h3>🤵 {groomLabel}</h3>
              <p>
                {String(gb.day).padStart(2, "0")}/{String(gb.month).padStart(2, "0")}/{gb.year}{" "}
                · {String(gb.hour).padStart(2, "0")}:{String(gb.minute).padStart(2, "0")}{" "}
                · {gb.placeLabel} ({formatTz(gb.tzOffsetHours)})
              </p>
              <p className="muted">
                Lagna: {RASHIS[groomChart.ascendantSign].name} ·{" "}
                Moon: {RASHIS[groomMoon.signIndex].name},{" "}
                {NAKSHATRAS[groomMoon.nakshatraIndex].name} (pada {groomMoon.pada})
              </p>
              <div className="match-report-chart">
                <ChartFor chart={groomChart} />
              </div>
            </div>
            <div className="match-report-person">
              <h3>👰 {brideLabel}</h3>
              <p>
                {String(bb.day).padStart(2, "0")}/{String(bb.month).padStart(2, "0")}/{bb.year}{" "}
                · {String(bb.hour).padStart(2, "0")}:{String(bb.minute).padStart(2, "0")}{" "}
                · {bb.placeLabel} ({formatTz(bb.tzOffsetHours)})
              </p>
              <p className="muted">
                Lagna: {RASHIS[brideChart.ascendantSign].name} ·{" "}
                Moon: {RASHIS[brideMoon.signIndex].name},{" "}
                {NAKSHATRAS[brideMoon.nakshatraIndex].name} (pada {brideMoon.pada})
              </p>
              <div className="match-report-chart">
                <ChartFor chart={brideChart} />
              </div>
            </div>
          </section>

          {/* Score Summary */}
          <section>
            <h2>
              {VERDICT_EMOJI[result.verdict]} Compatibility Score: {result.totalScore} / {result.maxScore} — {result.verdict}
            </h2>
            <p>{result.verdictDescription}</p>
          </section>

          {/* Kuta Table */}
          <section>
            <h2>Ashtakoot Breakdown</h2>
            <table className="report-table">
              <thead>
                <tr>
                  <th>Kuta</th>
                  <th>Max</th>
                  <th>Score</th>
                  <th>Description</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {result.kutas.map((k) => (
                  <tr key={k.name}>
                    <td><strong>{k.name}</strong></td>
                    <td>{k.maxPoints}</td>
                    <td>
                      <strong
                        style={{
                          color:
                            k.points === k.maxPoints
                              ? "#22c55e"
                              : k.points === 0
                                ? "#ef4444"
                                : "#eab308",
                        }}
                      >
                        {k.points}
                      </strong>
                    </td>
                    <td>{k.description}</td>
                    <td>{k.detail}</td>
                  </tr>
                ))}
                <tr className="report-total">
                  <td><strong>Total</strong></td>
                  <td><strong>{result.maxScore}</strong></td>
                  <td><strong>{result.totalScore}</strong></td>
                  <td colSpan={2}>{result.verdict} match ({result.percentage}%)</td>
                </tr>
              </tbody>
            </table>
          </section>

          {/* Manglik */}
          <section>
            <h2>Manglik (Kuja Dosha) Status</h2>
            <table className="report-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Status</th>
                  <th>Mars House</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>🤵 {groomLabel}</td>
                  <td>
                    {result.groomManglik.isManglik
                      ? result.groomManglik.cancelled
                        ? "Manglik (Cancelled)"
                        : "Manglik ⚠"
                      : "Non-Manglik ✓"}
                  </td>
                  <td>{groomChart.planets.find((p) => p.planet === "Mars")!.house}</td>
                  <td>{result.groomManglik.cancellationReason || "—"}</td>
                </tr>
                <tr>
                  <td>👰 {brideLabel}</td>
                  <td>
                    {result.brideManglik.isManglik
                      ? result.brideManglik.cancelled
                        ? "Manglik (Cancelled)"
                        : "Manglik ⚠"
                      : "Non-Manglik ✓"}
                  </td>
                  <td>{brideChart.planets.find((p) => p.planet === "Mars")!.house}</td>
                  <td>{result.brideManglik.cancellationReason || "—"}</td>
                </tr>
              </tbody>
            </table>
            {!result.manglikCompatible && (
              <p className="match-manglik-warn">
                ⚠ Manglik mismatch — one partner is Manglik and the other is not.
                Consider specific remedies (Kumbh Vivah, Vishnu Puja, etc.).
              </p>
            )}
          </section>

          {/* Planetary Positions - Both */}
          <section>
            <h2>Planetary Positions</h2>
            {[
              { label: groomLabel, chart: groomChart, icon: "🤵" },
              { label: brideLabel, chart: brideChart, icon: "👰" },
            ].map(({ label, chart, icon }) => (
              <div key={label} className="report-item">
                <h3>{icon} {label}</h3>
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
                        <td>
                          {GRAHA_BY_NAME[p.planet].symbol} {p.planet}
                          {p.retrograde ? " ℞" : ""}
                        </td>
                        <td>{RASHIS[p.signIndex].name}</td>
                        <td>{formatDegInSign(p.degreeInSign)}</td>
                        <td>{p.house}</td>
                        <td>
                          {NAKSHATRAS[p.nakshatraIndex].name} (p{p.pada})
                        </td>
                        <td>{p.dignity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>

          <footer className="report-foot">
            Generated by Shastri · Marriage Match (Ashtakoot Gun Milan) · for learning
            and reflection, not medical, legal, financial or psychological advice.
          </footer>
        </div>
      </div>
    </div>
  );
}
