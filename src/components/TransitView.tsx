import { useMemo, useState } from "react";
import { Chart } from "../astro/types";
import { GRAHA_BY_NAME, RASHIS, NAKSHATRAS } from "../astro/constants";
import { computeTransits, sadeSati } from "../astro/transits";
import { formatDegInSign } from "../utils/format";
import { ordinal } from "../astro/interpret";

interface Props {
  chart: Chart;
}

/** yyyy-mm-dd for an <input type="date">, in UTC. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function TransitView({ chart }: Props) {
  const [day, setDay] = useState<string>(() => isoDay(new Date()));

  // Represent the chosen day at 12:00 UTC — representative for slow-moving
  // grahas; the Moon (fast) is still placed to the correct sign for the day.
  const when = useMemo(() => {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  }, [day]);

  const transits = useMemo(() => computeTransits(chart, when), [chart, when]);
  const sat = useMemo(() => sadeSati(transits), [transits]);

  const moonSign = chart.planets.find((p) => p.planet === "Moon")!.signIndex;

  return (
    <div className="transit">
      <div className="transit-head">
        <div>
          <h3>Gochara (transits)</h3>
          <p className="muted small">
            Where the grahas are on a chosen date, read from your natal Moon in{" "}
            <strong>{RASHIS[moonSign].name}</strong> (Janma Rashi) and from your Lagna.
          </p>
        </div>
        <label className="transit-date">
          <span className="muted">Date</span>
          <input
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </label>
      </div>

      <div className={`card sade-sati ${sat.active ? "active" : "calm"}`}>
        {sat.active ? (
          <>
            <h4>Sade Sati is active — {sat.phase} phase</h4>
            <p className="muted">
              Saturn transits the {ordinal(sat.saturnHouseFromMoon)} from your natal
              Moon. This ~7½-year passage (12th → 1st → 2nd from the Moon) is a period
              of maturation, responsibility and consolidation — demanding but formative.
            </p>
          </>
        ) : (
          <>
            <h4>No Sade Sati at this date</h4>
            <p className="muted">
              Saturn is in the {ordinal(sat.saturnHouseFromMoon)} from your natal Moon —
              outside the 12th/1st/2nd band that defines Sade Sati.
            </p>
          </>
        )}
      </div>

      <div className="table-wrap">
        <table className="planet-table">
          <thead>
            <tr>
              <th>Graha</th>
              <th>Transiting sign</th>
              <th>Degree</th>
              <th>Nakshatra</th>
              <th>From Moon</th>
              <th>From Lagna</th>
              <th>Gochara</th>
              <th>Motion</th>
            </tr>
          </thead>
          <tbody>
            {transits.map((t) => {
              const g = GRAHA_BY_NAME[t.planet];
              const sign = RASHIS[t.signIndex];
              const nak = NAKSHATRAS[t.nakshatraIndex];
              return (
                <tr key={t.planet}>
                  <td>
                    <span className="glyph">{g.symbol}</span> {t.planet}
                  </td>
                  <td>
                    {sign.symbol} {sign.name}
                  </td>
                  <td className="mono">{formatDegInSign(t.degreeInSign)}</td>
                  <td>{nak.name}</td>
                  <td>{ordinal(t.houseFromMoon)}</td>
                  <td>{ordinal(t.houseFromLagna)}</td>
                  <td>
                    <span className={`gochara ${t.gochara.toLowerCase()}`}>
                      {t.gochara}
                    </span>
                  </td>
                  <td>
                    {t.retrograde ? (
                      <span className="retro-tag">Retrograde ↺</span>
                    ) : (
                      "Direct"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="muted small">
        Gochara favourability follows the classical Chandra-gochara house tables (results
        counted from the natal Moon). It is one factor among many — dasha, natal strength
        and aspects all colour the outcome.
      </p>
    </div>
  );
}
