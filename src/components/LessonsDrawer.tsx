import { lazy, Suspense, useState } from "react";

/**
 * The lessons handle, and nothing else, until someone opens it.
 *
 * The course itself is the single heaviest thing in the bundle — the two
 * lesson datasets plus the diagram and worked-example components come to ~84KB
 * of source — and it was being downloaded by every visitor on first paint,
 * including the ones who never open it. Only the handle needs to be eager; the
 * panel behind it is a `lazy()` boundary.
 *
 * The open/closed state lives here, not in the panel, so the handle renders
 * immediately and the chunk is only requested on the first click.
 */
const LessonsPanel = lazy(() => import("./LessonsPanel"));

interface Props {
  /** Whether a chart is loaded — enables the "See it live" deep links. */
  hasChart: boolean;
  /** Navigate the app to a tab (chart, dasha, predictions, remedies…). */
  onGoToTab: (tab: string) => void;
}

export default function LessonsDrawer({ hasChart, onGoToTab }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className={`lessons-handle${open ? " hidden" : ""}`}
        onClick={() => setOpen(true)}
        aria-label="Open astrology lessons"
      >
        📖 Lessons
      </button>

      {open && (
        <Suspense
          fallback={
            <div className="lessons-overlay" onClick={() => setOpen(false)}>
              <aside className="lessons-drawer" aria-label="Astrology lessons">
                <div className="lessons-head">
                  <div className="lessons-head-top">
                    <strong className="lessons-title">📖 Lessons</strong>
                  </div>
                </div>
                <p className="muted small lessons-list">Loading the course…</p>
              </aside>
            </div>
          }
        >
          <LessonsPanel
            hasChart={hasChart}
            onGoToTab={onGoToTab}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}
