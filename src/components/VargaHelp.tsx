import { DISPLAYED_VARGAS, Varga } from "../astro/varga";

interface Props {
  current: Varga;
  onPick: (v: Varga) => void;
}

// An in-app explainer for the divisional charts (vargas): what each one is and
// what it signifies. Clicking a row switches the displayed chart to it.
export default function VargaHelp({ current, onPick }: Props) {
  return (
    <div className="varga-help">
      <h3>Understanding the divisional charts (Vargas)</h3>
      <p className="muted small">
        A divisional chart (varga) splits each 30° sign into equal parts and re-maps them to
        new signs, magnifying one area of life. Read them <b>alongside</b> the Rāśi (D1): a
        result promised in D1 is confirmed and refined by the relevant varga, and a planet&apos;s
        real strength shows across charts (especially the D9). The exported PDF shows the chart
        you have selected here — switch below to export a different one.
      </p>

      <div className="varga-help-list">
        {DISPLAYED_VARGAS.map((v) => (
          <button
            key={v.code}
            className={`varga-help-item ${v.code === current ? "current" : ""}`}
            onClick={() => onPick(v.code)}
          >
            <div className="varga-help-head">
              <span className="varga-code">{v.code}</span>
              <strong>{v.name}</strong>
              <span className="muted small">
                {v.division === 1 ? "whole sign" : `${v.division} parts / sign`}
              </span>
              {v.code === current && <span className="now-badge small">showing</span>}
            </div>
            <p className="varga-help-about">{v.about}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
