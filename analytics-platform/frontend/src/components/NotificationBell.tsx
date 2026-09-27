"use client";
/** In-app notifications (NTF-001), polled every 30 s. */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button, cx } from "./ui";

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ["notifications"], queryFn: () => api.notifications.list(false), refetchInterval: 30_000, meta: { silent: true } });
  const markRead = useMutation({
    mutationFn: (id: string) => api.notifications.markRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const items = q.data ?? [];
  const unread = items.filter((n) => !n.read);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Notifications${unread.length ? `, ${unread.length} unread` : ""}`}
        className="relative rounded-md p-2 hover:bg-[var(--surface-2)]"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" />
        </svg>
        {unread.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-red-700 px-1 text-center text-[10px] font-bold leading-4 text-white">{unread.length > 99 ? "99+" : unread.length}</span>
        )}
      </button>
      <span className="sr-only" aria-live="polite">
        {unread.length ? `${unread.length} unread notifications` : ""}
      </span>
      {open && (
        <div className="absolute right-0 z-50 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl" role="region" aria-label="Notifications">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
            <h2 className="text-sm font-semibold">Notifications</h2>
            {unread.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => unread.forEach((n) => markRead.mutate(n.id))}>
                Mark all read
              </Button>
            )}
          </div>
          <ul className="max-h-96 overflow-auto">
            {items.length === 0 && <li className="px-3 py-6 text-center text-sm text-[var(--text-2)]">No notifications</li>}
            {items.map((n) => (
              <li key={n.id} className={cx("border-b border-[var(--border)] px-3 py-2 text-sm last:border-0", !n.read && "bg-brand-50/60 dark:bg-brand-900/20")}>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className={cx(!n.read && "font-medium")}>{n.title}</p>
                    <p className="text-xs text-[var(--text-2)]">{n.kind}</p>
                  </div>
                  {!n.read && (
                    <Button size="sm" variant="ghost" onClick={() => markRead.mutate(n.id)} aria-label={`Mark "${n.title}" as read`}>
                      ✓
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
