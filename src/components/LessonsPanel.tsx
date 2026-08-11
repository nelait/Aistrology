import { useEffect, useMemo, useState } from "react";
import { LESSONS, Lesson } from "../data/lessons";
import { VASTU_LESSONS } from "../data/vastuLessons";
import LessonVisual from "./LessonVisuals";
import LessonExamples from "./LessonExamples";
import { useAuth } from "../auth/AuthProvider";

interface Props {
  /** Whether a chart is loaded — enables the "See it live" deep links. */
  hasChart: boolean;
  /** Navigate the app to a tab (chart, dasha, predictions, remedies…). */
  onGoToTab: (tab: string) => void;
  /** Close the drawer — the open/closed state lives in LessonsDrawer, which
   *  stays eager so the handle is on screen before this chunk arrives. */
  onClose: () => void;
}

const TRACKS = ["Beginner", "Advanced", "Pro"] as const;
type Track = (typeof TRACKS)[number];
type Filter = "All" | Track;

// Reading progress is personal but light — kept in localStorage per user.
function progressKey(userId: string | undefined): string {
  return `aistro_lessons_done:${userId ?? "guest"}`;
}
function loadDone(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch { return new Set(); }
}
function saveDone(key: string, done: Set<string>): void {
  try { localStorage.setItem(key, JSON.stringify([...done])); } catch { /* private mode */ }
}

/** The slide-in lessons drawer: chapter list by track, a chapter reader with
 * prev/next, progress ticks, and deep links into the app.
 *
 * Loaded lazily by LessonsDrawer — it is only mounted while open, so it pulls
 * both lesson datasets and the diagram/worked-example components with it. */
export default function LessonsPanel({ hasChart, onGoToTab, onClose }: Props) {
  const { user } = useAuth();
  const key = progressKey(user?.id);
  const [subject, setSubject] = useState<"astro" | "vastu">("astro");
  const [mode, setMode] = useState<"chapters" | "examples">("chapters");
  const [filter, setFilter] = useState<Filter>("All");
  const [readingId, setReadingId] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(() => loadDone(key));

  // The active course. Lesson ids are unique across subjects, so a single
  // progress set serves both while counts stay per-subject.
  const course = subject === "vastu" ? VASTU_LESSONS : LESSONS;

  // Re-load progress when the signed-in user changes.
  useEffect(() => { setDone(loadDone(key)); }, [key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const reading = readingId ? course.find((l) => l.id === readingId) ?? null : null;
  const shown = filter === "All" ? course : course.filter((l) => l.level === filter);
  const doneCount = course.filter((l) => done.has(l.id)).length;
  const pct = Math.round((doneCount / course.length) * 100);

  const trackStats = useMemo(() => {
    const stats = {} as Record<Track, { done: number; total: number }>;
    for (const t of TRACKS) {
      const inTrack = course.filter((l) => l.level === t);
      stats[t] = { done: inTrack.filter((l) => done.has(l.id)).length, total: inTrack.length };
    }
    return stats;
  }, [done, course]);

  function setLessonDone(id: string, value: boolean) {
    setDone((d) => {
      const next = new Set(d);
      if (value) next.add(id); else next.delete(id);
      saveDone(key, next);
      return next;
    });
  }

  const idx = reading ? course.findIndex((l) => l.id === reading.id) : -1;
  const prev = idx > 0 ? course[idx - 1] : null;
  const next = idx >= 0 && idx < course.length - 1 ? course[idx + 1] : null;

  function goNext() {
    if (!reading) return;
    setLessonDone(reading.id, true); // moving on marks the chapter read
    if (next) setReadingId(next.id);
    else setReadingId(null); // finished the last chapter → back to the list
  }

  return (
    <div className="lessons-overlay" onClick={onClose}>
          <aside
            className="lessons-drawer"
            role="dialog"
            aria-label="Astrology lessons"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="lessons-head">
              <div className="lessons-head-top">
                {reading ? (
                  <button className="link lessons-back" onClick={() => setReadingId(null)}>← Chapters</button>
                ) : (
                  <strong className="lessons-title">📖 Lessons</strong>
                )}
                <button className="chat-icon" onClick={onClose} aria-label="Close lessons">✕</button>
              </div>
              {!reading && (
                <>
                  <div className="lessons-subject" role="tablist" aria-label="Subject">
                    <button role="tab" aria-selected={subject === "astro"} className={subject === "astro" ? "on" : ""}
                      onClick={() => { setSubject("astro"); setFilter("All"); setReadingId(null); }}>☸ Astrology</button>
                    <button role="tab" aria-selected={subject === "vastu"} className={subject === "vastu" ? "on" : ""}
                      onClick={() => { setSubject("vastu"); setFilter("All"); setReadingId(null); setMode("chapters"); }}>🏠 Vastu</button>
                  </div>
                  {subject === "astro" && (
                    <div className="lessons-mode" role="tablist" aria-label="Lessons mode">
                      <button role="tab" aria-selected={mode === "chapters"} className={mode === "chapters" ? "on" : ""}
                        onClick={() => setMode("chapters")}>📚 Chapters</button>
                      <button role="tab" aria-selected={mode === "examples"} className={mode === "examples" ? "on" : ""}
                        onClick={() => { setMode("examples"); setReadingId(null); }}>🧭 Worked examples</button>
                    </div>
                  )}
                  {mode === "chapters" && (
                    <>
                      <div className="lessons-progress">
                        <div className="lessons-progress-bar"><span style={{ width: `${pct}%` }} /></div>
                        <span className="muted small">{doneCount}/{course.length} chapters · {pct}%</span>
                      </div>
                      <div className="lessons-tracks" role="tablist" aria-label="Lesson track">
                        {(["All", ...TRACKS] as Filter[]).map((t) => (
                          <button
                            key={t}
                            role="tab"
                            aria-selected={filter === t}
                            className={filter === t ? "on" : ""}
                            onClick={() => setFilter(t)}
                          >
                            {t}
                            {t !== "All" && (
                              <span className="lessons-track-count">
                                {trackStats[t as Track].done}/{trackStats[t as Track].total}
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </header>

            {reading ? (
              <ChapterReader
                lesson={reading}
                isDone={done.has(reading.id)}
                hasChart={hasChart}
                onToggleDone={(v) => setLessonDone(reading.id, v)}
                onSeeIn={(tab) => { onClose(); onGoToTab(tab); }}
                onPrev={prev ? () => setReadingId(prev.id) : undefined}
                onNext={goNext}
                isLast={!next}
              />
            ) : mode === "examples" && subject === "astro" ? (
              <LessonExamples />
            ) : (
              <div className="lessons-list">
                {filter === "All" && (
                  <p className="muted small lessons-intro">
                    {subject === "vastu"
                      ? "Vastu Shastra in plain language — directions, zones and placement, ending with how your chart personalises it."
                      : "Short, plain-language chapters — start at Beginner and work down. Your progress is saved."}
                  </p>
                )}
                {shown.map((l) => (
                  <button key={l.id} className="lessons-item" onClick={() => setReadingId(l.id)}>
                    <span className={`lessons-tick${done.has(l.id) ? " done" : ""}`}>
                      {done.has(l.id) ? "✓" : ""}
                    </span>
                    <span className="lessons-item-text">
                      <span className="lessons-item-title">{l.title}</span>
                      <span className="muted small">{l.summary}</span>
                    </span>
                    <span className="lessons-item-meta">
                      <span className={`level ${l.level.toLowerCase()}`}>{l.level}</span>
                      <span className="muted small">{l.minutes} min</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
      </aside>
    </div>
  );
}

function ChapterReader({
  lesson, isDone, hasChart, onToggleDone, onSeeIn, onPrev, onNext, isLast,
}: {
  lesson: Lesson;
  isDone: boolean;
  hasChart: boolean;
  onToggleDone: (v: boolean) => void;
  onSeeIn: (tab: string) => void;
  onPrev?: () => void;
  onNext: () => void;
  isLast: boolean;
}) {
  return (
    <div className="lessons-reader" key={lesson.id}>
      <div className="lessons-reader-body">
        <div className="lessons-reader-meta">
          <span className={`level ${lesson.level.toLowerCase()}`}>{lesson.level}</span>
          <span className="muted small">{lesson.minutes} min read</span>
        </div>
        <h3>{lesson.title}</h3>
        <p className="lessons-summary">{lesson.summary}</p>
        {lesson.sections.map((s, i) => (
          <section className="lessons-section" key={i}>
            <h4>{s.heading}</h4>
            <p>{s.body}</p>
            {s.visual && <LessonVisual id={s.visual} />}
            {s.points && (
              <ul>
                {s.points.map((pt, j) => <li key={j}>{pt}</li>)}
              </ul>
            )}
          </section>
        ))}
        {lesson.seeIn && hasChart && (
          <button className="lessons-seein" onClick={() => onSeeIn(lesson.seeIn!.tab)}>
            ✨ See it live — {lesson.seeIn.label} →
          </button>
        )}
      </div>
      <footer className="lessons-reader-foot">
        <button className="mini-btn" onClick={onPrev} disabled={!onPrev}>← Prev</button>
        <button
          className={`lessons-done-btn${isDone ? " on" : ""}`}
          onClick={() => onToggleDone(!isDone)}
        >
          {isDone ? "✓ Completed" : "Mark complete"}
        </button>
        <button className="mini-btn ok" onClick={onNext}>{isLast ? "Finish ✓" : "Next →"}</button>
      </footer>
    </div>
  );
}
