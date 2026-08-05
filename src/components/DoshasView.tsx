import { useMemo } from "react";
import { Chart } from "../astro/types";
import { detectDoshas, Dosha, DoshaSeverity } from "../astro/doshas";
import { doshaReferences } from "../astro/references";
import Justify from "./Justify";
import { AskAiButton } from "../chat/AstroChat";

const SEVERITY_LABEL: Record<DoshaSeverity, string> = {
  high: "Strong",
  moderate: "Moderate",
  low: "Mild",
};

export default function DoshasView({ chart }: { chart: Chart }) {
  const doshas = useMemo(() => detectDoshas(chart), [chart]);

  return (
    <div className="doshas">
      <header className="doshas-head">
        <h2>🩸 Doshas</h2>
        <p className="muted">
          Classic afflictions read from your birth chart — why each forms, what it traditionally
          signifies, and a customary remedy. Doshas describe tendencies, not verdicts; most have
          well-known cancellations and remedies.
        </p>
      </header>

      {doshas.length === 0 ? (
        <div className="doshas-clear">
          <div className="doshas-clear-icon">✅</div>
          <h3>No major doshas detected</h3>
          <p className="muted">
            None of the common chart doshas (Mangal, Kaal Sarpa, Grahan, Guru Chandal, Pitra,
            Shrapit, Angarak, Kemadruma, Shakata) are present in this chart.
          </p>
        </div>
      ) : (
        <>
          <p className="doshas-count muted small">
            {doshas.length} dosha{doshas.length > 1 ? "s" : ""} found.
          </p>
          <div className="doshas-list">
            {doshas.map((d) => (
              <DoshaCard key={d.name} dosha={d} />
            ))}
          </div>
        </>
      )}

      <p className="doshas-note muted small">
        Note: dosha analysis is nuanced — strength, aspects and the whole chart matter. Treat this as
        a starting point for study and reflection, not medical, legal or financial advice.
      </p>
    </div>
  );
}

function DoshaCard({ dosha: d }: { dosha: Dosha }) {
  return (
    <div className={`dosha-card sev-${d.severity}`}>
      <div className="dosha-card-head">
        <div>
          <h3>{d.name}</h3>
          {d.sanskrit && <span className="dosha-sanskrit">{d.sanskrit}</span>}
        </div>
        <span className={`dosha-sev sev-${d.severity}`}>{SEVERITY_LABEL[d.severity]}</span>
      </div>

      <div className="dosha-tags">
        {d.planets.map((pl) => (
          <span className="dosha-tag" key={pl}>{pl}</span>
        ))}
        {d.houses?.map((h) => (
          <span className="dosha-tag house" key={`h${h}`}>House {h}</span>
        ))}
      </div>

      <p className="dosha-desc">{d.description}</p>

      <div className="dosha-row">
        <span className="dosha-row-label">Signifies</span>
        <p>{d.effect}</p>
      </div>
      <div className="dosha-row">
        <span className="dosha-row-label">Remedy</span>
        <p>{d.remedy}</p>
      </div>
      {d.cancellation && (
        <div className="dosha-cancel">
          <strong>Mitigating factor:</strong> {d.cancellation}
        </div>
      )}

      <div className="dosha-actions">
        <Justify
          subject={`${d.name} dosha`}
          basePrediction={d.effect}
          facts={doshaReferences(d).facts}
          references={doshaReferences(d).references}
          guidelines={[
            "Explain the dosha's classical basis and how it forms in this chart.",
            "Give a balanced, non-fatalistic reading of its real-world tendency.",
            "Note any cancellation/mitigation and the standard remedy (upaya).",
          ]}
        />
        <AskAiButton
          prompt={`My chart has ${d.name}${d.sanskrit ? ` (${d.sanskrit})` : ""}, severity ${SEVERITY_LABEL[d.severity].toLowerCase()}, involving ${d.planets.join(", ")}${d.houses?.length ? ` in house(s) ${d.houses.join(", ")}` : ""}. What does it mean for me, how serious is it given the rest of my chart, and what remedies help?`}
        />
      </div>
    </div>
  );
}
