"use client";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

export type ToastKind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastCtx {
  toast: (message: string, kind?: ToastKind) => void;
  success: (message: string) => void;
  error: (message: string) => void;
}

const Ctx = createContext<ToastCtx>({ toast: () => {}, success: () => {}, error: () => {} });

let external: ToastCtx["toast"] | null = null;
/** Toast from outside React (e.g. react-query cache callbacks). */
export function notify(message: string, kind: ToastKind = "info") {
  external?.(message, kind);
}

const STYLES: Record<ToastKind, string> = {
  success: "border-green-700/40 bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-100",
  error: "border-red-700/40 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100",
  info: "border-brand-500/40 bg-brand-50 text-brand-900 dark:bg-slate-800 dark:text-slate-100",
};
const ICON: Record<ToastKind, string> = { success: "✓", error: "⚠", info: "ℹ" };

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const toast = useCallback(
    (message: string, kind: ToastKind = "info") => {
      const id = next.current++;
      setToasts((t) => {
        // collapse identical messages fired in a burst
        if (t.some((x) => x.message === message && x.kind === kind)) return t;
        return [...t.slice(-4), { id, kind, message }];
      });
      setTimeout(() => dismiss(id), kind === "error" ? 8000 : 4000);
    },
    [dismiss],
  );

  const value = useMemo<ToastCtx>(
    () => ({ toast, success: (m) => toast(m, "success"), error: (m) => toast(m, "error") }),
    [toast],
  );
  external = toast;

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="no-print pointer-events-none fixed bottom-4 right-4 z-[1000] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
        <div role="status" aria-live="polite" className="contents">
          {toasts
            .filter((t) => t.kind !== "error")
            .map((t) => (
              <ToastItem key={t.id} t={t} onClose={() => dismiss(t.id)} />
            ))}
        </div>
        <div role="alert" aria-live="assertive" className="contents">
          {toasts
            .filter((t) => t.kind === "error")
            .map((t) => (
              <ToastItem key={t.id} t={t} onClose={() => dismiss(t.id)} />
            ))}
        </div>
      </div>
    </Ctx.Provider>
  );
}

function ToastItem({ t, onClose }: { t: Toast; onClose: () => void }) {
  return (
    <div className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg ${STYLES[t.kind]}`}>
      <span aria-hidden="true">{ICON[t.kind]}</span>
      <p className="flex-1 break-words">{t.message}</p>
      <button type="button" onClick={onClose} className="rounded px-1 opacity-70 hover:opacity-100" aria-label="Dismiss notification">
        ×
      </button>
    </div>
  );
}

export function useToast(): ToastCtx {
  return useContext(Ctx);
}
