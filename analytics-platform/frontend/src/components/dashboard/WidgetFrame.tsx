"use client";
import { useEffect, useRef, useState } from "react";
import type { Widget } from "@/lib/types";
import { cx } from "../ui";

/** Renders its body only once scrolled into view (DSH-NFR-002). */
export function useInView<T extends Element>(rootMargin = "200px") {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, rootMargin]);
  return { ref, seen };
}

export function WidgetFrame({
  widget,
  editing,
  selected,
  accent,
  onEdit,
  onRemove,
  onDuplicate,
  commentCount,
  onComments,
  children,
}: {
  widget: Widget;
  editing: boolean;
  selected?: boolean;
  accent?: string;
  onEdit?: () => void;
  onRemove?: () => void;
  onDuplicate?: () => void;
  /** SHR-005: open comment threads on this widget */
  commentCount?: number;
  onComments?: () => void;
  children: (visible: boolean) => React.ReactNode;
}) {
  const { ref, seen } = useInView<HTMLDivElement>();
  const bare = widget.type === "text" || widget.type === "image";
  return (
    <section
      ref={ref}
      aria-label={widget.title}
      data-widget-id={widget.id}
      className={cx(
        "flex h-full flex-col overflow-hidden rounded-lg border bg-[var(--surface)]",
        selected ? "border-brand-500 ring-2 ring-brand-500/40" : "border-[var(--border)]",
      )}
      style={accent ? { borderTopColor: accent, borderTopWidth: 3 } : undefined}
    >
      <header className={cx("flex items-center gap-1 px-3 pt-2", editing && "widget-drag cursor-move")}>
        {editing && (
          <span aria-hidden="true" className="text-[var(--text-2)]">
            ⠿
          </span>
        )}
        <h3 className={cx("min-w-0 flex-1 truncate text-sm font-semibold", bare && !editing && "sr-only")}>{widget.title}</h3>
        {onComments && (
          <button
            type="button"
            onClick={onComments}
            className={cx("no-print inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs hover:bg-[var(--surface-2)]", commentCount ? "text-brand-700 dark:text-brand-300" : "text-[var(--text-2)]")}
            aria-label={commentCount ? `${commentCount} open comment thread${commentCount === 1 ? "" : "s"} on ${widget.title}` : `Comment on ${widget.title}`}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.4A8 8 0 1121 12z" />
            </svg>
            {commentCount ? <span className="min-w-4 rounded-full bg-brand-600 px-1 text-[10px] font-semibold leading-4 text-white">{commentCount}</span> : null}
          </button>
        )}
        {editing && (
          <span className="no-print flex gap-0.5">
            <button type="button" onClick={onEdit} className="rounded px-1.5 py-0.5 text-xs hover:bg-[var(--surface-2)]" aria-label={`Configure ${widget.title}`}>
              ⚙
            </button>
            <button type="button" onClick={onDuplicate} className="rounded px-1.5 py-0.5 text-xs hover:bg-[var(--surface-2)]" aria-label={`Duplicate ${widget.title}`}>
              ⧉
            </button>
            <button type="button" onClick={onRemove} className="rounded px-1.5 py-0.5 text-xs hover:bg-[var(--surface-2)]" aria-label={`Remove ${widget.title}`}>
              ✕
            </button>
          </span>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3 pt-2">{seen ? children(true) : <div className="h-full animate-pulse rounded bg-[var(--surface-2)]" aria-hidden="true" />}</div>
    </section>
  );
}
