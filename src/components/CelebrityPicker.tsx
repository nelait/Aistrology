import { useEffect, useMemo, useRef, useState } from "react";
import {
  CELEBRITIES, CELEBRITY_REGIONS, searchCelebrities,
  type Celebrity, type CelebrityRegion,
} from "../data/celebrities";

interface Props {
  onPick: (c: Celebrity) => void;
  onClose: () => void;
}

const DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
});
const born = (c: Celebrity) =>
  DATE_FMT.format(new Date(Date.UTC(c.year, c.month - 1, c.day)));

/** Modal list of sample public figures; picking one fills the birth form. */
export default function CelebrityPicker({ onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [region, setRegion] = useState<CelebrityRegion | "All">("All");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = useMemo(() => searchCelebrities(query, region), [query, region]);
  const count = (r: CelebrityRegion) => CELEBRITIES.filter((c) => c.region === r).length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal celeb-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Choose a sample chart"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>⭐ Sample charts</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <p className="muted small celeb-intro">
          Pick anyone to fill the birth form, then cast their chart. Birth times
          aren&apos;t publicly documented for these figures, so each uses{" "}
          <strong>12:00 noon</strong> — planets, signs and nakshatras are accurate,
          but the Ascendant and houses are indicative only.
        </p>

        <div className="celeb-controls">
          <input
            ref={searchRef}
            className="celeb-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, place or field…"
          />
          <div className="celeb-regions" role="group" aria-label="Filter by region">
            <button type="button" className={region === "All" ? "on" : ""} onClick={() => setRegion("All")}>
              All <span className="celeb-count">{CELEBRITIES.length}</span>
            </button>
            {CELEBRITY_REGIONS.map((r) => (
              <button type="button" key={r} className={region === r ? "on" : ""} onClick={() => setRegion(r)}>
                {r} <span className="celeb-count">{count(r)}</span>
              </button>
            ))}
          </div>
        </div>

        {shown.length === 0 ? (
          <p className="muted small celeb-empty">No one matches “{query}”.</p>
        ) : (
          <ul className="celeb-list">
            {shown.map((c) => (
              <li key={c.name}>
                <button type="button" className="celeb-item" onClick={() => onPick(c)}>
                  <span className="celeb-item-main">
                    <strong>{c.name}</strong>
                    <span className="muted small">{born(c)} · {c.placeLabel}</span>
                  </span>
                  <span className="celeb-item-meta">
                    <span className="celeb-field">{c.field}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="muted small celeb-foot">
          Showing {shown.length} of {CELEBRITIES.length}. Birth data is drawn from
          public sources; time zones are resolved for the birth date, so historical
          rules apply.
        </p>
      </div>
    </div>
  );
}
