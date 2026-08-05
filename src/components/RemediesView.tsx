import { useMemo } from "react";
import { Chart } from "../astro/types";
import { GRAHA_BY_NAME, PlanetName, RASHIS } from "../astro/constants";
import { REMEDIES } from "../data/remedies";
import { ordinal } from "../astro/interpret";

interface Props {
  chart: Chart;
}

// Judge which planets most need attention: debilitated, or a natural malefic in
// a dusthana (6/8/12), gets flagged. Strong planets are noted as supportive.
function assess(chart: Chart) {
  const dusthana = [6, 8, 12];
  const flagged: Array<{ planet: PlanetName; reason: string }> = [];
  const strong: PlanetName[] = [];

  for (const p of chart.planets) {
    if (p.dignity === "Debilitated") {
      flagged.push({
        planet: p.planet,
        reason: `${p.planet} is debilitated in ${RASHIS[p.signIndex].name}, so its significations feel under-supported and benefit most from remedial work.`,
      });
    } else if (dusthana.includes(p.house) && GRAHA_BY_NAME[p.planet].nature === "Malefic") {
      flagged.push({
        planet: p.planet,
        reason: `${p.planet} (a natural malefic) sits in the ${ordinal(p.house)} house, a dusthana — pacifying remedies help smooth its harsher effects.`,
      });
    } else if (["Exalted", "Own sign", "Moolatrikona"].includes(p.dignity)) {
      strong.push(p.planet);
    }
  }
  return { flagged, strong };
}

export default function RemediesView({ chart }: Props) {
  const { flagged, strong } = useMemo(() => assess(chart), [chart]);

  return (
    <div className="remedies">
      <div className="card highlight">
        <h3>How to use this section</h3>
        <p className="note">
          Remedies (<i>upaya</i>) are traditional practices meant to strengthen a weak-but-helpful
          planet, pacify a troublesome one, and above all steady the mind that meets the karma.
          <b> The golden rule:</b> only strengthen a planet that is weak <i>and</i> benefic for your
          chart. When unsure, favour mantra, charity and right conduct — they carry no risk. Treat
          everything here as reflective self-work, not medical, financial or psychological advice.
        </p>
      </div>

      {flagged.length > 0 && (
        <div className="card">
          <h3>Planets your chart suggests focusing on</h3>
          <ul className="focus-list">
            {flagged.map((f) => (
              <li key={f.planet}>
                <b>{f.planet}</b> — {f.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {strong.length > 0 && (
        <div className="card">
          <h3>Naturally strong planets</h3>
          <p className="note">
            {strong.join(", ")} {strong.length > 1 ? "are" : "is"} well-placed by dignity in your
            chart. These are supportive already — you can honour them, but there is usually no need to
            &ldquo;strengthen&rdquo; them further.
          </p>
        </div>
      )}

      <h3 className="section-h">Remedies for each Graha, with justification</h3>
      <div className="remedy-grid">
        {chart.planets.map((p) => {
          const g = GRAHA_BY_NAME[p.planet];
          const R = REMEDIES[p.planet];
          const isFlagged = flagged.some((f) => f.planet === p.planet);
          return (
            <div className={`card remedy-card ${isFlagged ? "flagged" : ""}`} key={p.planet}>
              <h3>
                <span className="glyph">{g.symbol}</span> {p.planet} <span className="muted">{g.sanskrit}</span>
                {isFlagged && <span className="badge challenging">focus</span>}
              </h3>
              <div className="remedy-meta">
                <span><b>Gemstone:</b> {R.gemstone}</span>
                <span><b>Day:</b> {R.day}</span>
                <span><b>Colour:</b> {R.color}</span>
                <span><b>Metal:</b> {R.metal}</span>
                <span><b>Deity:</b> {R.deity}</span>
              </div>
              <p className="mantra">
                <b>Beeja mantra:</b> <span className="devanagari">{R.seedMantra}</span>
                <span className="muted"> · traditionally {R.mantraCount.toLocaleString()} repetitions</span>
              </p>
              <ul className="remedy-list">
                {R.remedies.map((rem, i) => (
                  <li key={i}>
                    <span className={`rtype ${rem.type.toLowerCase()}`}>{rem.type}</span>
                    <span className="raction">{rem.action}</span>
                    <span className="rwhy"><b>Why:</b> {rem.justification}</span>
                  </li>
                ))}
              </ul>
              <p className="caution"><b>Caution:</b> {R.caution}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
