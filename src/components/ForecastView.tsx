import { useEffect, useMemo, useState } from "react";
import { Chart } from "../astro/types";
import { RASHIS, NAKSHATRAS } from "../astro/constants";
import { dailyForecast, weeklyForecast, Tone } from "../astro/forecast";
import { ordinal } from "../astro/interpret";
import { formatDate } from "../utils/format";
import { ScopeBadge } from "./ScopeBadge";
import { useTranslation } from "../i18n/TranslationProvider";

interface Props {
  chart: Chart;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toneClass(t: Tone): string {
  return t === "Favorable" ? "favorable" : t === "Challenging" ? "challenging" : "mixed";
}

export default function ForecastView({ chart }: Props) {
  const [mode, setMode] = useState<"daily" | "weekly">("daily");
  const [day, setDay] = useState<string>(() => isoDay(new Date()));

  const when = useMemo(() => {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }, [day]);

  const daily = useMemo(() => dailyForecast(chart, when), [chart, when]);
  const weekly = useMemo(() => weeklyForecast(chart, when), [chart, when]);
  const dayName = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });

  const { t, ensure, active } = useTranslation();
  useEffect(() => {
    if (active) ensure([daily.summary, ...daily.highlights, weekly.summary]);
  }, [active, ensure, daily, weekly]);

  return (
    <div className="forecast">
      <div className="forecast-head">
        <ScopeBadge scope="timing" />
        <div className="toggle">
          <button className={mode === "daily" ? "on" : ""} onClick={() => setMode("daily")}>
            Daily
          </button>
          <button className={mode === "weekly" ? "on" : ""} onClick={() => setMode("weekly")}>
            Weekly
          </button>
        </div>
        <label className="forecast-date">
          <span className="muted">{mode === "daily" ? "Date" : "Week from"}</span>
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
      </div>

      {mode === "daily" ? (
        <div className={`card forecast-card ${toneClass(daily.tone)}`}>
          <div className="forecast-top">
            <h3>{formatDate(daily.date)}</h3>
            <span className={`tone-badge ${toneClass(daily.tone)}`}>{daily.tone}</span>
          </div>
          <p className="forecast-summary">{t(daily.summary)}</p>
          <div className="forecast-facts">
            <div>
              <span className="muted">Moon</span>
              <strong>
                {RASHIS[daily.moonSign].name} · {NAKSHATRAS[daily.moonNakshatra].name}
              </strong>
            </div>
            <div>
              <span className="muted">From your Moon</span>
              <strong>{ordinal(daily.moonHouseFromMoon)} house</strong>
            </div>
            {daily.dashaMaha && (
              <div>
                <span className="muted">Dasha</span>
                <strong>
                  {daily.dashaMaha}
                  {daily.dashaAntar && daily.dashaAntar !== daily.dashaMaha
                    ? `–${daily.dashaAntar}`
                    : ""}
                </strong>
              </div>
            )}
            <div>
              <span className="muted">Gochara balance</span>
              <strong>
                {daily.favorable} favourable · {daily.challenging} testing
              </strong>
            </div>
          </div>
          {daily.highlights.length > 0 && (
            <ul className="forecast-highlights">
              {daily.highlights.map((h, i) => (
                <li key={i}>{t(h)}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className={`card forecast-card ${toneClass(weekly.tone)}`}>
          <div className="forecast-top">
            <h3>
              Week of {formatDate(weekly.start)} – {formatDate(weekly.end)}
            </h3>
            <span className={`tone-badge ${toneClass(weekly.tone)}`}>{weekly.tone}</span>
          </div>
          <p className="forecast-summary">{t(weekly.summary)}</p>
          <div className="week-grid">
            {weekly.days.map((d, i) => (
              <div key={i} className={`week-day ${toneClass(d.tone)}`}>
                <span className="wd-name">{dayName(d.date)}</span>
                <span className="wd-moon">{RASHIS[d.moonSign].symbol}</span>
                <span className="wd-tone">{d.tone[0]}</span>
              </div>
            ))}
          </div>
          <p className="muted small">
            Each day shows the Moon&apos;s sign and its tone (F favourable · M mixed · C testing).
          </p>
        </div>
      )}

      <p className="muted small">
        Forecasts combine your running Vimshottari dasha with the day&apos;s transits read from
        your natal Moon. One influence among many — not a prescription.
      </p>
    </div>
  );
}
