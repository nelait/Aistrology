import { useCallback, useEffect, useState } from "react";
import { Chart } from "../astro/types";
import { api, ApiLifeEvent } from "../api/client";
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

  return (
    <div className="events-tab">
      <div className="subtabs">
        <button className={view === "predicted" ? "active" : ""} onClick={() => setView("predicted")}>
          From the chart
        </button>
        <button className={view === "mine" ? "active" : ""} onClick={() => setView("mine")}>
          Your life events{events.length ? ` (${events.length})` : ""}
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
          events={events}
          loading={loading}
          loadError={error}
          onChange={setEvents}
        />
      )}
      {view === "rectify" && <RectifyView chart={chart} events={events} />}
    </div>
  );
}
