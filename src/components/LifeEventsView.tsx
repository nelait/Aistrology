import { useMemo, useState } from "react";
import { Chart } from "../astro/types";
import { api, ApiLifeEvent } from "../api/client";
import { usePublishChatContext } from "../chat/AstroChat";
import {
  EVENT_KARAKAS,
  EVENT_KARAKA_BY_ID,
  EventTypeId,
  DatePrecision,
  EventConfidence,
  PRECISION_LABEL,
} from "../astro/eventKaraka";
import {
  analyseEvents,
  dashaTreeFor,
  EventAnalysis,
  EventBand,
  LifeEventInput,
} from "../astro/eventAnalysis";
import { ordinal } from "../astro/interpret";
import { buildEventNarrativeRequest } from "../astro/eventNarrative";
import { useLlm } from "../llm/LlmProvider";
import { useAuth } from "../auth/AuthProvider";
import { useLanguage } from "../i18n/LanguageProvider";

interface Props {
  chart: Chart;
  chartId: string | null;
  /** Owned by EventsTab, because the rectification view needs the same list. */
  events: ApiLifeEvent[];
  /** Set when the loaded chart is a sample figure with documented events. */
  demoSource: { name: string; source: string; count: number } | null;
  loading: boolean;
  loadError: string | null;
  onChange: (events: ApiLifeEvent[]) => void;
}

const BAND_LABEL: Record<EventBand, string> = {
  strong: "Strongly indicated",
  moderate: "Moderately indicated",
  weak: "Weakly indicated",
  unsupported: "Not indicated",
};

const CONFIDENCE_LABEL: Record<EventConfidence, string> = {
  sure: "Certain",
  fairly: "Fairly sure",
  vague: "Vague",
};

const LAYER_GLYPH: Record<string, string> = {
  dasha: "◑",
  boundary: "⟡",
  transit: "☄",
  varga: "▦",
  yoga: "✦",
};

/** yyyy-mm-dd → a UTC Date. Parsing the bare string would use local time and
 *  could land on the previous day west of Greenwich. */
function parseISO(d: string): Date {
  return new Date(`${d}T00:00:00Z`);
}

function fmt(d: Date): string {
  return d.toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
  });
}

export default function LifeEventsView({
  chart, chartId, events, demoSource, loading, loadError, onChange,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const { enabled: llmEnabled } = useLlm();
  const { language } = useLanguage();
  const { user } = useAuth();
  // Same gate as Justify: the endpoint is paid-only, so showing the button to a
  // free user would just be a button that always returns 403.
  const canNarrate = llmEnabled && (user?.plan ?? "free") !== "free";
  // Narration per event id: the prose, whether it is still streaming, any error.
  const [narrative, setNarrative] = useState<Record<string, { text: string; streaming: boolean; error?: string }>>({});

  // New-event form
  const [type, setType] = useState<EventTypeId>("marriage");
  const [date, setDate] = useState("");
  const [precision, setPrecision] = useState<DatePrecision>("exact");
  const [confidence, setConfidence] = useState<EventConfidence>("sure");
  const [note, setNote] = useState("");

  // All the analysis is local — the chart, the dashas and the null arm never
  // leave the browser. See docs/rectification-and-event-analysis.md.
  const analyses = useMemo<EventAnalysis[]>(() => {
    if (!events.length) return [];
    const input: LifeEventInput[] = events.map((e) => ({
      id: e.id,
      type: e.type as EventTypeId,
      date: parseISO(e.eventDate),
      precision: e.precision as DatePrecision,
      confidence: e.confidence as EventConfidence,
      note: e.note,
    }));
    return analyseEvents(chart, input, { dashas: dashaTreeFor(chart), nullSamples: 200 });
  }, [events, chart]);

  // Ground Astro Chat in what this tab computed, like the other modules do.
  usePublishChatContext(
    analyses.length
      ? analyses.map(
          (a) =>
            `${a.label} on ${fmt(a.date)}: ${a.periodLabel} dasha; ` +
            `${BAND_LABEL[a.band].toLowerCase()}` +
            (a.percentile !== null ? ` (${ordinal(a.percentile)} percentile vs random dates)` : "") +
            (a.reasons[0] ? ` — ${a.reasons[0].text}` : ""),
        )
      : null,
  );

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!chartId) return;

    // Validated here rather than by the browser. With native validation the
    // form simply refuses to submit when the date is out of range, so `add`
    // never ran, no error was ever set, and pressing "Add event" did nothing
    // visible at all — which reads as the feature silently dropping entries.
    if (!date) {
      setError("Pick a date for the event.");
      return;
    }
    const when = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(when.getTime())) {
      setError("That date is not valid.");
      return;
    }
    if (when.getTime() > Date.now() + 86_400_000) {
      setError("That date is in the future — events have to have happened already.");
      return;
    }
    if (when.getUTCFullYear() < 1800) {
      setError("That date is too far in the past.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const created = await api.createLifeEvent(chartId, { type, eventDate: date, precision, confidence, note });
      onChange([...events, created].sort((a, b) => a.eventDate.localeCompare(b.eventDate)));
      setDate("");
      setNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that event");
    } finally {
      setBusy(false);
    }
  }

  async function narrate(id: string, a: EventAnalysis) {
    setNarrative((n) => ({ ...n, [id]: { text: "", streaming: true } }));
    const req = buildEventNarrativeRequest(a);
    try {
      await api.justifyStream(
        { ...req, language: language.code === "en" ? undefined : language.english },
        {
          onDelta: (t) =>
            setNarrative((n) => ({ ...n, [id]: { text: (n[id]?.text ?? "") + t, streaming: true } })),
          onDone: () =>
            setNarrative((n) => ({ ...n, [id]: { text: n[id]?.text ?? "", streaming: false } })),
          onError: (m) =>
            setNarrative((n) => ({ ...n, [id]: { text: n[id]?.text ?? "", streaming: false, error: m } })),
        },
      );
    } catch (e) {
      setNarrative((n) => ({
        ...n,
        [id]: { text: n[id]?.text ?? "", streaming: false, error: e instanceof Error ? e.message : "Failed" },
      }));
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await api.deleteLifeEvent(id);
      onChange(events.filter((e) => e.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that event");
    } finally {
      setBusy(false);
    }
  }

  // An unsaved profile has nowhere to store events — but a sample figure's
  // documented ones live in the app, not the database, so they must still show.
  // Bailing out here on `!chartId` alone hid the whole point of picking a
  // celebrity: the subtab counted seven events and the panel was blank.
  if (!chartId && !demoSource) {
    return (
      <div className="life-events">
        <h3>Your life events</h3>
        <p className="muted">
          Save this profile first — events are stored against a saved profile so they stay
          with it.
        </p>
      </div>
    );
  }

  return (
    <div className="life-events">
      <h3>Your life events</h3>
      <p className="muted small">
        Add dated events from your life and see what classical Jyotisha reads in each
        moment — the dashas that were running, the transits, and the divisional chart the
        texts send you to.
      </p>

      {demoSource && (
        <p className="le-demo-note">
          <strong>{demoSource.count} documented events</strong> for {demoSource.name}, read from{" "}
          <a className="link" href={demoSource.source} target="_blank" rel="noreferrer noopener">
            Wikipedia
          </a>{" "}
          — marked <span className="le-doc-tag">doc</span> below. They are here to try the
          feature on real facts, and you can add your own alongside them.
          <br />
          <strong>The readings below are not meaningful for this chart.</strong> This sample
          figure&apos;s birth time is unknown, so the chart uses a 12:00 placeholder — and the
          dashas everything is read from depend on it. Use{" "}
          <em>Unknown birth time</em> instead: that is the tab these events are genuinely for,
          because it works out a time rather than assuming one.
        </p>
      )}

      <p className="le-caveat">
        <strong>Traditional method, unvalidated.</strong> These readings apply classical
        rules as written; they have not been tested against a controlled study, and nothing
        here is evidence that the rules predict anything. The percentile beside each event
        is the honest measure — it compares the reading against the same reading for random
        dates in your life, so a figure near 50 means the chart says nothing in particular
        about that date.
      </p>

      {/* noValidate: the browser's own constraint checking blocks submit before
          our handler runs, which left a failed add with no explanation. All of
          it is checked in `add` instead, where the message can be shown. */}
      {!chartId ? (
        <p className="muted small le-unsaved">
          Save this profile to add events of your own alongside the documented ones.
        </p>
      ) : (
      <form className="le-form" onSubmit={add} noValidate>
        <div className="le-form-grid">
          <label>
            <span className="muted small">What happened</span>
            <select value={type} onChange={(e) => setType(e.target.value as EventTypeId)}>
              {EVENT_KARAKAS.map((k) => (
                <option key={k.id} value={k.id}>{k.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="muted small">When</span>
            {/* `max` still constrains the calendar picker; it no longer blocks
                submit, so a typed-in date gets a real message instead. */}
            <input type="date" value={date} max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            <span className="muted small">How well do you know the date?</span>
            <select value={precision} onChange={(e) => setPrecision(e.target.value as DatePrecision)}>
              {(Object.keys(PRECISION_LABEL) as DatePrecision[]).map((p) => (
                <option key={p} value={p}>{PRECISION_LABEL[p]}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="muted small">How sure are you it happened then?</span>
            <select value={confidence} onChange={(e) => setConfidence(e.target.value as EventConfidence)}>
              {(Object.keys(CONFIDENCE_LABEL) as EventConfidence[]).map((c) => (
                <option key={c} value={c}>{CONFIDENCE_LABEL[c]}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted small le-hint">{EVENT_KARAKA_BY_ID[type].hint}</p>
        <div className="le-form-foot">
          <input className="le-note" type="text" maxLength={500} value={note}
            placeholder="A note for yourself (optional) — not used in the reading"
            onChange={(e) => setNote(e.target.value)} />
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Add event"}
          </button>
        </div>
      </form>
      )}

      {(error || loadError) && <p className="error small">{error ?? loadError}</p>}

      {loading ? (
        <p className="muted small">Loading your events…</p>
      ) : analyses.length === 0 ? (
        <p className="muted small">No events yet. Add one above to see the reading.</p>
      ) : (
        <div className="le-list">
          {analyses.map((a, i) => {
            const row = events[i];
            const id = row?.id ?? String(i);
            const expanded = open === id;
              const isDemo = id.startsWith("demo-");
              return (
              <div key={id} className={`le-item band-${a.band}${isDemo ? " demo" : ""}`}>
                <button
                  type="button"
                  className="le-head"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : id)}
                >
                  <span className="le-when">{fmt(a.date)}</span>
                  <span className="le-what">
                    {a.label}
                    {isDemo && <span className="le-doc-tag" title="Documented, from Wikipedia">doc</span>}
                  </span>
                  <span className={`le-band band-${a.band}`}>{BAND_LABEL[a.band]}</span>
                  {a.percentile !== null && (
                    <span className="le-pct muted small" title="Against random dates in your life">
                      {ordinal(a.percentile)} pct
                    </span>
                  )}
                  <span className="le-caret muted">{expanded ? "▴" : "▾"}</span>
                </button>

                {expanded && (
                  <div className="le-body">
                    <p className="le-period">
                      Running then: <strong>{a.periodLabel}</strong>
                      <span className="muted small"> (Mahadasha / Antardasha / Pratyantardasha)</span>
                    </p>

                    {a.reasons.length > 0 ? (
                      <ul className="le-reasons">
                        {a.reasons.map((r, j) => (
                          <li key={j}>
                            <span className="le-layer" title={r.layer}>{LAYER_GLYPH[r.layer] ?? "•"}</span>
                            <span>{r.text}</span>
                            {r.source && <em className="muted small le-src"> — {r.source}</em>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted small">
                        Nothing in the chart speaks to this event on this date.
                      </p>
                    )}

                    {a.dissent.length > 0 && (
                      <div className="le-dissent">
                        <strong className="small">What the chart does not support</strong>
                        <ul>{a.dissent.map((d, j) => <li key={j}>{d}</li>)}</ul>
                      </div>
                    )}

                    {a.vargaNote && <p className="muted small le-varga">{a.vargaNote}</p>}

                    {/* Narration is an optional layer over the findings above,
                        never a replacement for them: with the AI engine off the
                        reasons, citations and percentile are all still here. */}
                    {canNarrate && (
                      <div className="le-narrate">
                        {!narrative[id] ? (
                          <button className="mini-btn" onClick={() => narrate(id, a)}>
                            ✦ Explain this in plain words
                          </button>
                        ) : (
                          <>
                            <p className="le-narrative">
                              {narrative[id].text}
                              {narrative[id].streaming && <span className="le-caret-blink">▌</span>}
                            </p>
                            {narrative[id].error && (
                              <p className="error small">{narrative[id].error}</p>
                            )}
                            {!narrative[id].streaming && (
                              <button className="mini-btn" onClick={() => narrate(id, a)}>
                                ↻ Rewrite
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )}

                    <div className="le-item-foot">
                      {row?.note && <span className="muted small">“{row.note}”</span>}
                      {!isDemo && (
                        <button className="mini-btn no" disabled={busy} onClick={() => remove(id)}>
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
