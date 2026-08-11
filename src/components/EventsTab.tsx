import { useState } from "react";
import { Chart } from "../astro/types";
import EventsView from "./EventsView";
import LifeEventsView from "./LifeEventsView";

interface Props {
  chart: Chart;
  chartId: string | null;
}

/**
 * The Events tab holds two halves of the same idea, so they share a tab rather
 * than each taking one of their own:
 *   - what the chart says *should* be significant (derived milestones), and
 *   - what actually happened (the user's own dated events, read back).
 */
export default function EventsTab({ chart, chartId }: Props) {
  const [view, setView] = useState<"predicted" | "mine">("predicted");

  return (
    <div className="events-tab">
      <div className="subtabs">
        <button className={view === "predicted" ? "active" : ""} onClick={() => setView("predicted")}>
          From the chart
        </button>
        <button className={view === "mine" ? "active" : ""} onClick={() => setView("mine")}>
          Your life events
        </button>
      </div>

      {view === "predicted"
        ? <EventsView chart={chart} />
        : <LifeEventsView chart={chart} chartId={chartId} />}
    </div>
  );
}
