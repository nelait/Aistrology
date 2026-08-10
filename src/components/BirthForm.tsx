import { useEffect, useMemo, useState } from "react";
import { BirthData } from "../astro/types";
import { City, searchCities, cityZone } from "../data/cities";
import { zoneOffsetHours } from "../astro/timezone";
import { formatTz } from "../utils/format";
import { celebrityToBirth, type Celebrity } from "../data/celebrities";
import CelebrityPicker from "./CelebrityPicker";

interface Props {
  onSubmit: (data: BirthData) => void;
  initial?: BirthData;
}

const EXAMPLES: BirthData[] = [
  {
    name: "Mahatma Gandhi",
    year: 1869, month: 10, day: 2, hour: 7, minute: 45, second: 0,
    tzOffsetHours: 5.5, latitude: 21.6417, longitude: 69.6293,
    placeLabel: "Porbandar, Gujarat, India",
  },
  {
    name: "A. P. J. Abdul Kalam",
    year: 1931, month: 10, day: 15, hour: 1, minute: 15, second: 0,
    tzOffsetHours: 5.5, latitude: 9.2881, longitude: 79.3129,
    placeLabel: "Rameswaram, Tamil Nadu, India",
  },
];

export default function BirthForm({ onSubmit, initial }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [date, setDate] = useState(
    initial
      ? `${initial.year}-${String(initial.month).padStart(2, "0")}-${String(initial.day).padStart(2, "0")}`
      : "1990-01-01",
  );
  const [time, setTime] = useState(
    initial
      ? `${String(initial.hour).padStart(2, "0")}:${String(initial.minute).padStart(2, "0")}`
      : "12:00",
  );
  const [placeQuery, setPlaceQuery] = useState(initial?.placeLabel ?? "");
  const [lat, setLat] = useState(initial ? String(initial.latitude) : "28.6139");
  const [lon, setLon] = useState(initial ? String(initial.longitude) : "77.2090");
  const [tz, setTz] = useState(initial ? String(initial.tzOffsetHours) : "5.5");
  const [dst, setDst] = useState(false);
  // IANA zone of the picked city, if any. When set, the timezone offset is
  // resolved automatically for the birth date (historical rules + DST) and the
  // manual DST checkbox is not needed.
  const [zone, setZone] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCelebs, setShowCelebs] = useState(false);

  const matches = useMemo(() => searchCities(placeQuery), [placeQuery]);

  // When a zone is active, keep the offset in sync with the birth date/time.
  useEffect(() => {
    if (!zone) return;
    const [y, mo, d] = date.split("-").map(Number);
    const [hh, mm] = time.split(":").map(Number);
    if (!y || !mo || !d || Number.isNaN(hh) || Number.isNaN(mm)) return;
    const off = zoneOffsetHours(zone, y, mo, d, hh, mm);
    setTz(String(off));
  }, [zone, date, time]);

  function pickCity(c: City) {
    setPlaceQuery(`${c.name}, ${c.admin}, ${c.country}`);
    setLat(String(c.lat));
    setLon(String(c.lon));
    const z = cityZone(c);
    setZone(z);
    setDst(false);
    if (!z) setTz(String(c.tz)); // no zone data: fall back to the static offset
    // (when z is set, the effect above fills the offset for the birth date)
    setShowList(false);
  }

  function loadExample(ex: BirthData) {
    setName(ex.name);
    setDate(`${ex.year}-${String(ex.month).padStart(2, "0")}-${String(ex.day).padStart(2, "0")}`);
    setTime(`${String(ex.hour).padStart(2, "0")}:${String(ex.minute).padStart(2, "0")}`);
    setPlaceQuery(ex.placeLabel);
    setLat(String(ex.latitude));
    setLon(String(ex.longitude));
    setZone(null); // examples carry their own historically-correct offset
    setTz(String(ex.tzOffsetHours));
    setDst(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const [y, mo, d] = date.split("-").map(Number);
    const [hh, mm] = time.split(":").map(Number);
    const latN = parseFloat(lat);
    const lonN = parseFloat(lon);
    const tzN = parseFloat(tz) - (dst ? 1 : 0); // subtract DST to get standard clock->UT

    if (!y || !mo || !d) return setError("Please enter a valid birth date.");
    if (Number.isNaN(hh) || Number.isNaN(mm)) return setError("Please enter a valid birth time.");
    if (Number.isNaN(latN) || latN < -90 || latN > 90) return setError("Latitude must be between -90 and 90.");
    if (Number.isNaN(lonN) || lonN < -180 || lonN > 180) return setError("Longitude must be between -180 and 180.");
    if (Number.isNaN(tzN)) return setError("Please select a place or enter a timezone.");

    onSubmit({
      name: name.trim() || "Native",
      year: y, month: mo, day: d,
      hour: hh, minute: mm, second: 0,
      tzOffsetHours: tzN,
      latitude: latN, longitude: lonN,
      placeLabel: placeQuery.trim() || `${latN.toFixed(2)}, ${lonN.toFixed(2)}`,
    });
  }

  return (
    <form className="birth-form" onSubmit={submit}>
      <div className="form-row">
        <label>
          Name <span className="muted">(optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Whose chart is this?" />
        </label>
      </div>

      <div className="form-grid">
        <label>
          Date of birth
          <input type="date" value={date} min="1800-01-01" max="2099-12-31" onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label>
          Time of birth <span className="muted">(24h, local)</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
        </label>
      </div>

      <div className="form-row place">
        <label>
          Place of birth
          <input
            value={placeQuery}
            onChange={(e) => { setPlaceQuery(e.target.value); setZone(null); setShowList(true); }}
            onFocus={() => setShowList(true)}
            placeholder="Start typing a city…"
            autoComplete="off"
          />
        </label>
        {showList && matches.length > 0 && (
          <ul className="city-list">
            {matches.map((c) => (
              <li key={`${c.name}-${c.lat}`} onMouseDown={() => pickCity(c)}>
                <strong>{c.name}</strong> <span className="muted">{c.admin}, {c.country} · {formatTz(c.tz)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="tz-note muted">
        Only major cities are listed. If you can't find your birth place, search{" "}
        <strong>&ldquo;your city latitude longitude&rdquo;</strong> on Google and enter the values
        manually below (also set the timezone as UTC±hours).
      </p>

      <div className="form-grid three">
        <label>
          Latitude <span className="muted">(N+)</span>
          <input value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Longitude <span className="muted">(E+)</span>
          <input value={lon} onChange={(e) => setLon(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Timezone <span className="muted">(UTC±h)</span>
          <input
            value={tz}
            onChange={(e) => { setTz(e.target.value); setZone(null); }}
            inputMode="decimal"
          />
        </label>
      </div>

      {zone ? (
        <p className="tz-note muted">
          Timezone resolved from <strong>{zone}</strong> for the birth date —{" "}
          {formatTz(parseFloat(tz) || 0)}, with any daylight saving and historical
          changes already applied.
        </p>
      ) : (
        <>
          <label className="checkbox">
            <input type="checkbox" checked={dst} onChange={(e) => setDst(e.target.checked)} />
            Daylight saving time (DST) was in effect at birth
          </label>
          <p className="tz-note muted">
            DST is a seasonal 1-hour clock change some countries use in summer. Tick this only if
            your birth <strong>place and date</strong> were observing DST — then we subtract that
            hour to get the correct standard time. <strong>India never uses DST</strong>, so for
            Indian births leave this unchecked. If you're unsure, leave it unchecked.
          </p>
        </>
      )}

      {error && <p className="error">{error}</p>}

      <button type="submit" className="primary">Cast the Chart · Janma Kundali</button>

      <div className="examples">
        <span className="muted">Try an example:</span>
        {EXAMPLES.map((ex) => (
          <button type="button" key={ex.name} className="chip" onClick={() => loadExample(ex)}>
            {ex.name}
          </button>
        ))}
        <button type="button" className="chip chip-more" onClick={() => setShowCelebs(true)}>
          ⭐ Other celebrities
        </button>
      </div>

      {showCelebs && (
        <CelebrityPicker
          onClose={() => setShowCelebs(false)}
          onPick={(c: Celebrity) => {
            loadExample(celebrityToBirth(c));
            setShowCelebs(false);
          }}
        />
      )}
    </form>
  );
}
