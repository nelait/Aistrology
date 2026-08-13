import { useCallback, useEffect, useState } from "react";
import { Chart } from "../astro/types";
import { api, ApiLifeEvent } from "../api/client";
import { celebrityEventsFor } from "../data/celebrityEvents";
import EventsView from "./EventsView";
import LifeEventsView from "./LifeEventsView";
import RectifyView from "./RectifyView";

interface Props {
  chart: Chart;
  chartId: string | null;
}

type View = "predicted" | "mine" | "rectify";

/**
 * The Events tab holds three views of the same idea, so they share a tab rather
 * than each taking one of their own:
 *   - what the chart says *should* be significant (derived milestones),
 *   - what actually happened (the user's own dated events, read back), and
 *   - what those events imply about an unknown birth time.
 *
 * The event list is loaded here rather than in either child, because the last
 * two both need it and neither should own it.
 */
export default function EventsTab({ chart, chartId }: Props) {
  const [view, setView] = useState<View>("predicted");
  const [events, setEvents] = useState<ApiLifeEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!chartId) { setEvents([]); setLoading(false); return; }
    setLoading(true);
    api.listLifeEvents(chartId)
      .then(setEvents)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load events"))
      .finally(() => setLoading(false));
  }, [chartId]);

  useEffect(() => { load(); }, [load]);

  // Sample charts carry documented events. They are matched off the loaded
  // birth data rather than passed down from the picker, so they appear however
  // the chart was loaded — and they are never written to the database: these
  // are somebody else's life, not the user's own records.
  const demo = celebrityEventsFor(chart.birth);
  const demoEvents: ApiLifeEvent[] = demo
    ? demo.events.map((e, i) => ({
        id: `demo-${i}`,
        chartId: chartId ?? "demo",
        type: e.type,
        eventDate: e.date,
        precision: e.precision,
        confidence: "sure",
        note: e.what,
        createdAt: 0,
        updatedAt: 0,
      }))
    : [];
  const combined = [...demoEvents, ...events].sort((a, b) => a.eventDate.localeCompare(b.eventDate));

  return (
    <div className="events-tab">
      <div className="subtabs">
        <button className={view === "predicted" ? "active" : ""} onClick={() => setView("predicted")}>
          From the chart
        </button>
        <button className={view === "mine" ? "active" : ""} onClick={() => setView("mine")}>
          {demo ? "Life events" : "Your life events"}{combined.length ? ` (${combined.length})` : ""}
        </button>
        <button className={view === "rectify" ? "active" : ""} onClick={() => setView("rectify")}>
          Unknown birth time
        </button>
      </div>

      {view === "predicted" && <EventsView chart={chart} />}
      {view === "mine" && (
        <LifeEventsView
          chart={chart}
          chartId={chartId}
          events={combined}
          demoSource={demo ? { name: demo.name, source: demo.source, count: demoEvents.length } : null}
          loading={loading}
          loadError={error}
          onChange={setEvents}
        />
      )}
      {view === "rectify" && <RectifyView chart={chart} events={combined} />}
    </div>
  );
}
