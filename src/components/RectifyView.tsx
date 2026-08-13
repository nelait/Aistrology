import { useMemo, useState } from "react";
import { Chart } from "../astro/types";
import { api, ApiLifeEvent } from "../api/client";
import {
  EVENT_KARAKA_BY_ID,
  EventTypeId,
  DatePrecision,
  EventConfidence,
} from "../astro/eventKaraka";
import { LifeEventInput } from "../astro/eventAnalysis";
import {
  rectifySteps,
  verdictFor,
  formatMinute,
  RectifyResult,
  RectifyVerdict,
  TimeOfDay,
  TIME_OF_DAY,
} from "../astro/rectify";
import { ordinal } from "../astro/interpret";
import { celebrityEventsFor } from "../data/celebrityEvents";

interface Props {
  chart: Chart;
  events: ApiLifeEvent[];
}

const VERDICT: Record<RectifyVerdict, { label: string; blurb: string }> = {
  narrow: {
    label: "Narrowed",
    blurb: "Your events point consistently at one part of the day.",
  },
  indicative: {
    label: "Indicative",
    blurb: "There is a preferred stretch of the day, but it is a wide one.",
  },
  weak: {
    label: "Weak",
    blurb: "Only a loose preference — treat this as a hint, not an answer.",
  },
  inconclusive: {
    label: "Inconclusive",
    blurb:
      "Your events do not separate one time of day from another any better than unrelated " +
      "dates would. That is a real answer, not a failure: add more events, or more exactly " +
      "dated ones, and run it again.",
  },
};

function parseISO(d: string): Date {
  return new Date(`${d}T00:00:00Z`);
}

/**
 * The score curve as a strip across the searched span, with the winning
 * windows marked over the top.
 *
 * The markers are an overlay rather than a colour on the bars themselves: at
 * 480 candidates across a phone screen each bar is under a pixel, so a
 * sixteen-minute window came out as an invisible sliver — which is the one
 * thing the picture exists to show.
 */
function Heatmap({ result }: { result: RectifyResult }) {
  // Downsample for drawing. There are up to 480 candidates and a phone gives
  // the strip about 335px, so one bar per candidate came out at 0.7px — with a
  // 1px gap between them the flex items were squeezed to nothing and the chart
  // rendered empty. ~110 buckets, each keeping its peak, is both visible and
  // faithful about where the maximum is.
  const BUCKETS = 110;
  const size = Math.max(1, Math.ceil(result.scores.length / BUCKETS));
  const bars: number[] = [];
  for (let i = 0; i < result.scores.length; i += size) {
    bars.push(Math.max(...result.scores.slice(i, i + size)));
  }

  const peak = Math.max(...bars);
  const floor = Math.min(...bars);
  const range = peak - floor || 1;
  const span = result.searchTo - result.searchFrom;
  const pos = (m: number) => ((m - result.searchFrom) / span) * 100;

  // Hour ticks across whatever span was searched — the whole day, or just the
  // "morning" band if that was the constraint. Aim for at most nine labels and
  // snap to a round interval, so the marks land on 03:00 rather than 02:53.
  const interval = [30, 60, 120, 180, 360].find((iv) => span / iv <= 9) ?? 720;
  const ticks: number[] = [];
  for (let m = Math.ceil(result.searchFrom / interval) * interval; m <= result.searchTo; m += interval) {
    ticks.push(m);
  }

  const best = result.windows[0];

  return (
    <div className="rx-heat" role="img" aria-label="Score across the searched span">
      <div className="rx-bars">
        {bars.map((s, i) => {
          const v = (s - floor) / range;
          return (
            <span
              key={i}
              className="rx-bar"
              style={{ height: `${8 + v * 92}%`, opacity: 0.3 + v * 0.7 }}
              title={`${formatMinute(result.minutes[i * size])} — ${Math.round(v * 100)}%`}
            />
          );
        })}
      </div>
      {ticks.map((m) => (
        <span key={`t${m}`} className="rx-tick" style={{ left: `${pos(m)}%` }} />
      ))}

      {result.windows.slice(0, 3).map((w, i) => (
        <span
          key={i}
          className={i === 0 ? "rx-mark best" : "rx-mark"}
          style={{
            left: `${pos(w.startMinute)}%`,
            // Never thinner than a couple of pixels, or the marker vanishes at
            // exactly the moment the result is most precise.
            width: `max(3px, ${pos(w.endMinute) - pos(w.startMinute)}%)`,
          }}
          title={`${formatMinute(w.startMinute)} – ${formatMinute(w.endMinute % 1440)}`}
        />
      ))}

      {/* The range written on the chart, not only in the list below it — a
          16-minute band on a 24-hour axis is a hairline, and reading it off the
          ticks alone is guesswork. Nudged to whichever side has room. */}
      {best && (
        <span
          // Centred normally, but hung to one side near either edge — the pill
          // is ~95px and the strip is clipped, so a window at 03:00 or 23:00
          // would otherwise have its own label cut in half.
          className={
            "rx-flag" +
            (pos(best.startMinute) > 62 ? " left" : pos(best.endMinute) < 16 ? " right" : "")
          }
          style={{ left: `${pos((best.startMinute + best.endMinute) / 2)}%` }}
        >
          {formatMinute(best.startMinute)}–{formatMinute(best.endMinute % 1440)}
        </span>
      )}
    </div>
  );
}

/** Clock labels under the strip, at the same positions as the ticks. */
function Axis({ result }: { result: RectifyResult }) {
  const span = result.searchTo - result.searchFrom;
  const interval = [30, 60, 120, 180, 360].find((iv) => span / iv <= 9) ?? 720;
  const ticks: number[] = [];
  for (let m = Math.ceil(result.searchFrom / interval) * interval; m <= result.searchTo; m += interval) {
    ticks.push(m);
  }
  return (
    <div className="rx-axis muted small">
      {ticks.map((m, i) => (
        <span
          key={m}
          // Every other label is dropped on a phone, where nine of them overlap.
          className={i % 2 === 1 ? "rx-tick-label alt" : "rx-tick-label"}
          style={{ left: `${((m - result.searchFrom) / span) * 100}%` }}
        >
          {m >= 1440 ? "24:00" : formatMinute(m)}
        </span>
      ))}
    </div>
  );
}

type Contribution = "no" | "sending" | "yes" | "declined" | "failed";

/** Circular distance between two minutes-of-day. */
function circularError(a: number, b: number): number {
  const raw = Math.abs(a - b);
  return Math.min(raw, 1440 - raw);
}

/**
 * The hold-out check, and the one honest route to a real accuracy figure.
 *
 * A user who already knows their birth time has just watched the search run
 * without it. Comparing the two is a genuine held-out test — and unlike every
 * other validation route considered (see docs/rectification-and-event-analysis.md
 * Part 5) it needs no licensed data, because it is their own.
 *
 * The result is shown first and the contribution asked for second, so opting in
 * is never a blind act. What leaves the browser is the error and the shape of
 * the run — never the birth time, the date, the place or the events.
 */
function AccuracyCheck({
  result, chart, inputs, timeOfDay, checked, onCheck, contributed, setContributed,
}: {
  result: RectifyResult;
  chart: Chart;
  inputs: LifeEventInput[];
  timeOfDay: TimeOfDay;
  checked: boolean;
  onCheck: () => void;
  contributed: Contribution;
  setContributed: (v: Contribution) => void;
}) {
  const best = result.windows[0];
  if (!best) return null;

  // A sample figure's stored time is a 12:00 placeholder, not a birth time.
  // Offering to "check how close it got" against it would be inviting the user
  // to record a meaningless error into the one accuracy dataset there is.
  if (celebrityEventsFor(chart.birth)) {
    return (
      <div className="rx-accuracy">
        <strong className="small">No time to check this against</strong>
        <p className="muted small">
          This is a sample chart, and its birth time is not known — the 12:00 on the profile
          is a placeholder. There is nothing to compare the window with, so nothing is
          recorded. Load a profile whose birth time you actually know to test the search.
        </p>
      </div>
    );
  }

  const trueMinute = chart.birth.hour * 60 + chart.birth.minute;
  const centre = Math.floor((best.startMinute + best.endMinute) / 2);
  const error = circularError(centre, trueMinute);
  const inside = trueMinute >= best.startMinute && trueMinute < best.endMinute;

  async function contribute() {
    setContributed("sending");
    try {
      const mix: Record<string, number> = {};
      for (const e of inputs) mix[e.precision] = (mix[e.precision] ?? 0) + 1;
      await api.contributeAccuracy({
        errorMinutes: error,
        insideWindow: inside,
        windowMinutes: best.widthMinutes,
        verdict: verdictFor(result),
        separationZ: result.separationZ,
        eventCount: inputs.length,
        precisionMix: Object.entries(mix).map(([k, v]) => `${k}:${v}`).join(","),
        timeOfDay,
        // The decade, not the year — enough to spot an era effect, not enough
        // to help identify anybody.
        birthDecade: Math.floor(chart.birth.year / 10) * 10,
      });
      setContributed("yes");
    } catch {
      setContributed("failed");
    }
  }

  return (
    <div className="rx-accuracy">
      {!checked ? (
        <>
          <strong className="small">Do you already know this birth time?</strong>
          <p className="muted small">
            If the time on this profile is one you trust, the search just ran without using
            it — so we can show you how close it came. That is a real test, and it is the
            only kind this method can honestly be given.
          </p>
          <button className="mini-btn" onClick={onCheck}>Show me how close it got</button>
        </>
      ) : (
        <>
          <p className={inside ? "rx-acc-hit" : "rx-acc-miss"}>
            {inside ? "✓ Inside the window." : "✗ Outside the window."}{" "}
            Recorded time <strong>{formatMinute(trueMinute)}</strong>, window centre{" "}
            <strong>{formatMinute(centre)}</strong> — out by{" "}
            <strong>{error} minute{error === 1 ? "" : "s"}</strong>.
          </p>

          {contributed === "yes" ? (
            <p className="muted small">
              Recorded — thank you. That is one more data point towards an accuracy figure
              this feature can actually stand behind.
            </p>
          ) : contributed === "declined" ? (
            <p className="muted small">Nothing was sent. The comparison above is yours alone.</p>
          ) : (
            <>
              <p className="muted small">
                May we keep this result? It would be stored as: the {error}-minute error, the
                window width, the verdict, how many events you used and how well dated they
                were, and your birth <em>decade</em>. <strong>Not</strong> your birth time,
                date, place, or any of your events. It is the only way this method can ever
                lose its “unvalidated” label.
              </p>
              <div className="rx-acc-actions">
                <button className="mini-btn ok" disabled={contributed === "sending"} onClick={contribute}>
                  {contributed === "sending" ? "Sending…" : "Yes, contribute this result"}
                </button>
                <button className="mini-btn" onClick={() => setContributed("declined")}>No thanks</button>
              </div>
              {contributed === "failed" && (
                <p className="error small">Could not record that — nothing was sent.</p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

export default function RectifyView({ chart, events }: Props) {
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDay>("unknown");
  const [result, setResult] = useState<RectifyResult | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  // Accuracy check: revealed only when the user says they know the real time,
  // and contributed only when they then choose to.
  const [checked, setChecked] = useState(false);
  const [contributed, setContributed] = useState<Contribution>("no");

  const inputs = useMemo<LifeEventInput[]>(
    () =>
      events.map((e) => ({
        id: e.id,
        type: e.type as EventTypeId,
        date: parseISO(e.eventDate),
        precision: e.precision as DatePrecision,
        confidence: e.confidence as EventConfidence,
        note: e.note,
      })),
    [events],
  );

  function run() {
    setRunning(true);
    setProgress(0);
    setResult(null);

    // The scan is only ~400ms of actual work, but running it straight through
    // blocks the page for all of it, so the generator is driven in ~40ms
    // slices with the thread handed back between them.
    //
    // The hop between slices goes through a MessageChannel rather than
    // setTimeout: setTimeout(…, 0) is clamped to 4ms in a foreground tab and to
    // a full SECOND in a background one, which turned a 400ms scan into
    // eighteen seconds when the tab lost focus. A message port is not throttled
    // that way. (It is the same reason React's own scheduler uses one.)
    setChecked(false);
    setContributed("no");
    const it = rectifySteps(chart.birth, inputs, { timeOfDay });
    const channel = new MessageChannel();
    const pump = () => {
      const until = performance.now() + 40;
      let step = it.next();
      while (!step.done && performance.now() < until) step = it.next();
      if (step.done) {
        setResult(step.value);
        setRunning(false);
        setProgress(1);
        channel.port1.close();
        channel.port2.close();
      } else {
        setProgress(step.value as number);
        channel.port2.postMessage(null);
      }
    };
    channel.port1.onmessage = pump;
    channel.port2.postMessage(null);
  }

  const enough = inputs.length >= 2;

  return (
    <div className="rectify">
      <h3>Find an unknown birth time</h3>
      <p className="muted small">
        If you do not know what time you were born, your dated life events can narrow it
        down. Every dasha boundary in a chart slides by one to four and a half days for each
        minute of birth time, so an event you can date well is evidence about the clock.
      </p>

      <p className="le-caveat">
        <strong>Traditional method, unvalidated.</strong> This applies classical rules as
        written and has never been tested against real birth certificates — no licence-clean
        set of them exists to test against. Treat the result as a suggestion to weigh
        against whatever else you know, never as a fact. It reports a <em>window</em>, never
        a single time, and it will tell you when your events say nothing.
      </p>

      <div className="rx-controls">
        <label>
          <span className="muted small">Anything you do remember about the time?</span>
          <select value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value as TimeOfDay)}>
            {TIME_OF_DAY.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </label>
        <button className="primary" onClick={run} disabled={running || !enough}>
          {running ? `Scanning the day… ${Math.round(progress * 100)}%` : "Search for the time"}
        </button>
      </div>

      <p className="muted small rx-basis">
        Using {inputs.length} event{inputs.length === 1 ? "" : "s"} from this profile
        {enough ? "" : " — add at least two under “Your life events” first"}.
      </p>

      {result && (
        <div className="rx-result">
          <div className={`rx-verdict v-${verdictFor(result)}`}>
            <strong>{VERDICT[verdictFor(result)].label}</strong>
            <span>{VERDICT[verdictFor(result)].blurb}</span>
          </div>

          <Heatmap result={result} />
          <Axis result={result} />

          {verdictFor(result) !== "inconclusive" && (
            <>
              <div className="rx-windows">
                {result.windows.slice(0, 3).map((w, i) => (
                  <div key={i} className={i === 0 ? "rx-window best" : "rx-window"}>
                    <span className="rx-range">
                      {formatMinute(w.startMinute)} – {formatMinute(w.endMinute % 1440)}
                    </span>
                    <span className="muted small">
                      {w.widthMinutes} min wide{i === 0 ? " · best fit" : ""}
                    </span>
                  </div>
                ))}
              </div>

              <p className="muted small rx-precision">
                Your dates are precise enough to justify about ±{result.expectedPrecisionMinutes}{" "}
                minutes, and the window shown is widened to match — the score curve peaks
                more sharply than the dates deserve, and reporting that peak would be
                claiming precision you do not have.
              </p>
            </>
          )}

          <div className="rx-fits">
            <strong className="small">How each event lines up</strong>
            <ul>
              {result.fits.map((f, i) => (
                <li key={i} className={f.agrees ? "agrees" : "dissents"}>
                  <span className="rx-fit-mark">{f.agrees ? "✓" : "✗"}</span>
                  <span>
                    {EVENT_KARAKA_BY_ID[f.event.type as EventTypeId].label}
                    {" — "}
                    {f.event.date.toLocaleDateString(undefined, {
                      year: "numeric", month: "short", timeZone: "UTC",
                    })}
                    {f.agrees
                      ? ` fits this window (${ordinal(f.percentileWithinDay)} percentile of the day)`
                      : ` does NOT fit this window (${ordinal(f.percentileWithinDay)} percentile — other times explain it better)`}
                  </span>
                </li>
              ))}
            </ul>
            {result.fits.some((f) => !f.agrees) && (
              <p className="muted small">
                A dissenting event is worth more than an agreeing one: either its date is
                wrong, or the window is.
              </p>
            )}
          </div>

          <AccuracyCheck
            result={result}
            chart={chart}
            inputs={inputs}
            timeOfDay={timeOfDay}
            checked={checked}
            onCheck={() => setChecked(true)}
            contributed={contributed}
            setContributed={setContributed}
          />

          <p className="muted small rx-stats">
            Peak stands {result.separation.toFixed(1)} standard deviations above the day&apos;s
            average
            {result.separationZ !== null && (
              <>
                , and {result.separationZ.toFixed(1)} above what the same scan produces on
                unrelated dates — that second figure is the one that matters, because this
                scoring peaks sharply whatever dates you feed it
              </>
            )}
            .
          </p>
        </div>
      )}
    </div>
  );
}
