import { useEffect, useMemo } from "react";
import { Chart } from "../astro/types";
import { importantEvents, EventCategory } from "../astro/events";
import { formatDate } from "../utils/format";
import { useTranslation } from "../i18n/TranslationProvider";

interface Props {
  chart: Chart;
}

const CATEGORY_GLYPH: Record<EventCategory, string> = {
  Dasha: "◑",
  "Sade Sati": "♄",
  Saturn: "♄",
  Jupiter: "♃",
  Nodes: "☊",
};

export default function EventsView({ chart }: Props) {
  const events = useMemo(() => importantEvents(chart, { spanYears: 90 }), [chart]);
  const now = Date.now();
  const { t, ensure, active } = useTranslation();
  useEffect(() => {
    if (active) ensure(events.flatMap((e) => [e.title, e.description]));
  }, [active, ensure, events]);

  return (
    <div className="events">
      <h3>Important events</h3>
      <p className="muted small">
        Milestones derived from your chart — Mahadasha changes, Sade Sati windows, and the
        Saturn, Jupiter and nodal returns — with your age at each. Dates are approximate.
      </p>

      <div className="event-timeline">
        {events.map((e, i) => {
          const past = (e.endDate ?? e.date).getTime() < now;
          const current =
            e.endDate && e.date.getTime() <= now && e.endDate.getTime() >= now;
          return (
            <div
              key={i}
              className={`event-row ${past ? "past" : ""} ${current ? "current" : ""}`}
            >
              <div className="event-age">
                <span className="age-num">{Math.max(0, Math.round(e.ageYears))}</span>
                <span className="age-lbl">yrs</span>
              </div>
              <div className={`event-dot cat-${e.category.replace(/\s/g, "-").toLowerCase()}`}>
                {CATEGORY_GLYPH[e.category]}
              </div>
              <div className="event-body">
                <div className="event-head">
                  <strong>{t(e.title)}</strong>
                  <span className="event-cat">{e.category}</span>
                  {current && <span className="now-badge small">now</span>}
                </div>
                <div className="event-date muted">
                  {formatDate(e.date)}
                  {e.endDate && ` – ${formatDate(e.endDate)}`}
                </div>
                <p className="event-desc">{t(e.description)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
