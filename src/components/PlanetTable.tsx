import { Chart } from "../astro/types";
import { GRAHA_BY_NAME, RASHIS, NAKSHATRAS } from "../astro/constants";
import { cuspInfo } from "../astro/cusp";
import { formatDegInSign } from "../utils/format";
import { ordinal } from "../astro/interpret";

interface Props {
  chart: Chart;
}

/** A small "borderline" marker with an explanatory tooltip. */
function CuspFlag({ title }: { title: string }) {
  return (
    <sup className="cusp-flag" title={title}>
      ±
    </sup>
  );
}

const arcmin = (deg: number) => `${(deg * 60).toFixed(1)}′`;

export default function PlanetTable({ chart }: Props) {
  const anyCusp = chart.planets.some((p) => cuspInfo(p.longitude).any);
  return (
    <div className="table-wrap">
      <table className="planet-table">
        <thead>
          <tr>
            <th>Graha</th>
            <th>Sign (Rashi)</th>
            <th>Degree</th>
            <th>House</th>
            <th>Nakshatra</th>
            <th>Pada</th>
            <th>Dignity</th>
            <th>Motion</th>
          </tr>
        </thead>
        <tbody>
          {chart.planets.map((p) => {
            const g = GRAHA_BY_NAME[p.planet];
            const sign = RASHIS[p.signIndex];
            const nak = NAKSHATRAS[p.nakshatraIndex];
            const cusp = cuspInfo(p.longitude);
            return (
              <tr key={p.planet}>
                <td>
                  <span className="glyph">{g.symbol}</span> {p.planet}
                  <span className="muted"> {g.sanskrit}</span>
                </td>
                <td>
                  {sign.symbol} {sign.name}
                  {cusp.sign.near && (
                    <CuspFlag
                      title={`Borderline sign — ${arcmin(cusp.sign.distanceDeg)} from ${RASHIS[cusp.sign.neighborIndex].name}`}
                    />
                  )}
                </td>
                <td className="mono">{formatDegInSign(p.degreeInSign)}</td>
                <td>{ordinal(p.house)}</td>
                <td>
                  {nak.name}
                  {cusp.nakshatra.near && (
                    <CuspFlag
                      title={`Borderline nakshatra — ${arcmin(cusp.nakshatra.distanceDeg)} from ${NAKSHATRAS[cusp.nakshatra.neighborIndex].name}`}
                    />
                  )}
                </td>
                <td>
                  {p.pada}
                  {cusp.pada.near && (
                    <CuspFlag
                      title={`Borderline pada — ${arcmin(cusp.pada.distanceDeg)} from pada ${cusp.pada.neighborIndex}`}
                    />
                  )}
                </td>
                <td>
                  <span className={`dignity ${p.dignity.replace(/\s/g, "-").toLowerCase()}`}>
                    {p.dignity}
                  </span>
                </td>
                <td>{p.retrograde ? <span className="retro-tag">Retrograde ↺</span> : "Direct"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {anyCusp && (
        <p className="cusp-legend muted small">
          <span className="cusp-flag">±</span> marks a placement within ~6′ of a
          boundary — borderline given the engine's precision, so the sign,
          nakshatra or pada could tip either way. Verify a birth time to the
          minute for these.
        </p>
      )}

      <div className="asc-row">
        <div>
          <span className="muted">Ascendant (Lagna)</span>
          <strong>
            {RASHIS[chart.ascendantSign].symbol} {RASHIS[chart.ascendantSign].name} ·{" "}
            {formatDegInSign(chart.ascendant - chart.ascendantSign * 30)}
          </strong>
        </div>
        <div>
          <span className="muted">Ayanamsa ({chart.ayanamsaSystem})</span>
          <strong className="mono">{formatDegInSign(chart.ayanamsa)}</strong>
        </div>
        <div>
          <span className="muted">Midheaven (MC)</span>
          <strong>
            {RASHIS[Math.floor(chart.mc / 30)].name} · {formatDegInSign(chart.mc - Math.floor(chart.mc / 30) * 30)}
          </strong>
        </div>
      </div>
    </div>
  );
}
