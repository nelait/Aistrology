import { useEffect, useMemo, useState } from "react";
import { City, searchCities, cityZone } from "../data/cities";
import { zoneOffsetHours } from "../astro/timezone";
import { formatTz } from "../utils/format";
import {
  findMuhurta, MuhurtaDay, MuhurtaActivity, MUHURTA_ACTIVITIES, MuhurtaLocation,
} from "../astro/muhurta";
import { muhurtaReferences } from "../astro/references";
import Justify from "./Justify";
import { AskAiButton, usePublishChatContext } from "../chat/AstroChat";

const RATING_LABEL: Record<string, string> = {
  excellent: "Excellent", good: "Good", average: "Average", avoid: "Avoid",
};

function todayISO(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

// Quick-pick major cities across time zones. Each carries an IANA zone so the
// offset is resolved correctly for the chosen date (DST-aware).
const QUICK_CITIES: City[] = [
  { name: "New Delhi", admin: "Delhi", country: "India", lat: 28.6139, lon: 77.209, tz: 5.5, zone: "Asia/Kolkata" },
  { name: "Kathmandu", admin: "Bagmati", country: "Nepal", lat: 27.7172, lon: 85.324, tz: 5.75, zone: "Asia/Kathmandu" },
  { name: "Dubai", admin: "Dubai", country: "UAE", lat: 25.2048, lon: 55.2708, tz: 4, zone: "Asia/Dubai" },
  { name: "Singapore", admin: "Singapore", country: "Singapore", lat: 1.3521, lon: 103.8198, tz: 8, zone: "Asia/Singapore" },
  { name: "London", admin: "England", country: "UK", lat: 51.5074, lon: -0.1278, tz: 0, zone: "Europe/London" },
  { name: "New York", admin: "New York", country: "USA", lat: 40.7128, lon: -74.006, tz: -5, zone: "America/New_York" },
  { name: "Chicago", admin: "Illinois", country: "USA", lat: 41.8781, lon: -87.6298, tz: -6, zone: "America/Chicago" },
  { name: "Los Angeles", admin: "California", country: "USA", lat: 34.0522, lon: -118.2437, tz: -8, zone: "America/Los_Angeles" },
  { name: "Toronto", admin: "Ontario", country: "Canada", lat: 43.6532, lon: -79.3832, tz: -5, zone: "America/Toronto" },
  { name: "Sydney", admin: "NSW", country: "Australia", lat: -33.8688, lon: 151.2093, tz: 10, zone: "Australia/Sydney" },
];

export default function MuhurtaView() {
  const [placeQuery, setPlaceQuery] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [tz, setTz] = useState("");
  const [showList, setShowList] = useState(false);
  const [startDate, setStartDate] = useState(todayISO());
  const [days, setDays] = useState(15);
  const [activity, setActivity] = useState<MuhurtaActivity>("General");
  const [results, setResults] = useState<MuhurtaDay[] | null>(null);
  const [locLabel, setLocLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [onlyGood, setOnlyGood] = useState(false);
  // IANA zone of the picked city, so offsets resolve per date (DST-safe).
  // Cleared when latitude/longitude/timezone are edited by hand.
  const [zone, setZone] = useState<string | null>(null);

  const matches = useMemo(() => searchCities(placeQuery), [placeQuery]);

  function pickCity(c: City) {
    setPlaceQuery(`${c.name}, ${c.admin}, ${c.country}`);
    setLocLabel(`${c.name}, ${c.country}`);
    setLat(String(c.lat));
    setLon(String(c.lon));
    const z = cityZone(c);
    setZone(z);
    const [y, mo, d] = startDate.split("-").map(Number);
    const off = z ? zoneOffsetHours(z, y, mo, d, 12, 0) : c.tz;
    setTz(String(off));
    setShowList(false);
  }

  // Keep the displayed offset honest when the date moves across a DST boundary.
  useEffect(() => {
    if (!zone) return;
    const [y, mo, d] = startDate.split("-").map(Number);
    if (!y || !mo || !d) return;
    setTz(String(zoneOffsetHours(zone, y, mo, d, 12, 0)));
  }, [zone, startDate]);

  function compute() {
    setError(null);
    const latN = parseFloat(lat), lonN = parseFloat(lon), tzN = parseFloat(tz);
    if (Number.isNaN(latN) || latN < -90 || latN > 90) return setError("Enter a valid latitude (-90…90).");
    if (Number.isNaN(lonN) || lonN < -180 || lonN > 180) return setError("Enter a valid longitude (-180…180).");
    if (Number.isNaN(tzN)) return setError("Pick a city or enter a timezone.");
    const [y, mo, d] = startDate.split("-").map(Number);
    if (!y || !mo || !d) return setError("Enter a valid start date.");
    const loc: MuhurtaLocation = {
      latitude: latN, longitude: lonN, tzOffsetHours: tzN,
      zone: zone ?? undefined, label: locLabel,
    };
    const start = new Date(Date.UTC(y, mo - 1, d));
    setResults(findMuhurta(start, days, loc, activity));
  }

  const shown = results?.filter((r) => !onlyGood || r.rating === "excellent" || r.rating === "good");

  // Publish computed muhurta findings so free-typed chat questions are grounded.
  const chatFindings = useMemo(() => {
    if (!results) return null;
    return [
      `Muhurta search for "${activity}" at ${locLabel || "the given location"}, from ${startDate}, ${days} days.`,
      ...results.slice(0, 12).map((d) =>
        `${d.date}: rated ${d.rating} (Tithi ${d.panchanga.tithiName}, Nakshatra ${d.panchanga.nakshatra}, Yoga ${d.panchanga.yoga}).`),
    ];
  }, [results, activity, locLabel, startDate, days]);
  usePublishChatContext(chatFindings);

  return (
    <div className="muhurta">
      <header className="muhurta-head">
        <h2>🗓️ Muhurta — Auspicious Days</h2>
        <p className="muted">
          Find favourable days and times for important work, from your <strong>current location</strong>
          (used to compute local sunrise, Rahu Kaal and the day's Panchanga).
        </p>
      </header>

      <div className="muhurta-form">
        <div className="muhurta-form-row place">
          <label>
            Your location (city of residence)
            <input
              value={placeQuery}
              onChange={(e) => { setPlaceQuery(e.target.value); setShowList(true); }}
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

        <div className="muhurta-quick">
          <span className="muted small">Quick pick:</span>
          {QUICK_CITIES.map((c) => (
            <button key={c.name} type="button" className="chip" onClick={() => pickCity(c)}>
              {c.name} <span className="muted">{formatTz(c.tz)}</span>
            </button>
          ))}
        </div>
        <p className="muhurta-hint muted small">
          Can't find your city? Search <strong>&ldquo;your city latitude longitude&rdquo;</strong> on
          Google and enter the values below (also set the timezone as UTC±hours).
        </p>

        <div className="muhurta-form-grid">
          <label>Latitude <span className="muted">(N+)</span>
            <input value={lat} onChange={(e) => { setLat(e.target.value); setZone(null); }} inputMode="decimal" />
          </label>
          <label>Longitude <span className="muted">(E+)</span>
            <input value={lon} onChange={(e) => { setLon(e.target.value); setZone(null); }} inputMode="decimal" />
          </label>
          <label>Timezone <span className="muted">(UTC±h)</span>
            <input value={tz} onChange={(e) => { setTz(e.target.value); setZone(null); }} inputMode="decimal" />
          </label>
        </div>

        <div className="muhurta-form-grid">
          <label>From date
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label>For
            <select value={days} onChange={(e) => setDays(parseInt(e.target.value))}>
              <option value={7}>Next 7 days</option>
              <option value={15}>Next 15 days</option>
              <option value={30}>Next 30 days</option>
            </select>
          </label>
          <label>Purpose
            <select value={activity} onChange={(e) => setActivity(e.target.value as MuhurtaActivity)}>
              {MUHURTA_ACTIVITIES.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
        </div>

        {error && <p className="error small">{error}</p>}
        <button className="primary" onClick={compute}>🔎 Find auspicious days</button>
      </div>

      {results && (
        <div className="muhurta-results">
          <div className="muhurta-results-head">
            <h3>{activity === "General" ? "Auspicious days" : `Best days for ${activity}`} · {locLabel || "your location"}</h3>
            <label className="checkbox small">
              <input type="checkbox" checked={onlyGood} onChange={(e) => setOnlyGood(e.target.checked)} />
              Only good days
            </label>
          </div>
          {shown && shown.length === 0 ? (
            <p className="muted small">No days match the filter in this range.</p>
          ) : (
            <div className="muhurta-days">
              {shown!.map((day) => <MuhurtaCard key={day.date} day={day} activity={activity} />)}
            </div>
          )}
        </div>
      )}

      <p className="muhurta-note muted small">
        Sunrise, Rahu Kaal and the Panchanga are computed for the location and date shown. Muhurta is
        nuanced — for major events, confirm with a qualified astrologer.
      </p>
    </div>
  );
}

function MuhurtaCard({ day, activity }: { day: MuhurtaDay; activity: MuhurtaActivity }) {
  // day.date is a LOCAL civil date at the searched location, pinned to UTC
  // midnight. Format it in UTC — without this, a browser west of UTC renders
  // the previous day, so the card would show one weekday's Rahu Kaal under
  // another weekday's heading.
  const nice = new Date(day.date + "T00:00:00Z").toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", timeZone: "UTC",
  });
  return (
    <div className={`muhurta-card rate-${day.rating}`}>
      <div className="muhurta-card-head">
        <div>
          <h4>{nice}</h4>
          <span className="muted small">☀ {day.sunrise ?? "—"} · 🌇 {day.sunset ?? "—"}</span>
        </div>
        <span className={`muhurta-rate rate-${day.rating}`}>{RATING_LABEL[day.rating]}</span>
      </div>

      <div className="muhurta-panchanga">
        <span><b>Tithi</b> {day.panchanga.tithiName}</span>
        <span><b>Nakshatra</b> {day.panchanga.nakshatra}</span>
        <span><b>Yoga</b> {day.panchanga.yoga}</span>
      </div>

      <div className="muhurta-windows">
        <div className="muhurta-win good">
          <span className="muhurta-win-label">✓ Auspicious</span>
          {day.auspicious.map((w) => <span key={w.name} className="muhurta-slot">{w.name}: {w.from}–{w.to}</span>)}
        </div>
        <div className="muhurta-win bad">
          <span className="muhurta-win-label">✕ Avoid</span>
          {day.inauspicious.map((w) => <span key={w.name} className="muhurta-slot">{w.name}: {w.from}–{w.to}</span>)}
        </div>
      </div>

      {day.reasons.length > 0 && (
        <ul className="muhurta-reasons">
          {day.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}

      <div className="muhurta-actions">
        <Justify
          subject={`Muhurta on ${day.date} (${activity})`}
          basePrediction={`This day is rated ${day.rating} for ${activity.toLowerCase()} muhurta.`}
          facts={muhurtaReferences(day).facts}
          references={muhurtaReferences(day).references}
          guidelines={[
            "Weigh the Panchanga limbs (Tithi, Nakshatra, Yoga, Vara) and explain the rating.",
            "Point to the best auspicious window and the periods to avoid.",
            "Be practical and non-fatalistic.",
          ]}
        />
        <AskAiButton
          prompt={`For ${activity.toLowerCase()} on ${nice}, this day is rated "${RATING_LABEL[day.rating]}" (Tithi ${day.panchanga.tithiName}, Nakshatra ${day.panchanga.nakshatra}, Yoga ${day.panchanga.yoga}). Should I go ahead, and which time window is best or worst?`}
        />
      </div>
    </div>
  );
}
