import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLlm } from "../llm/LlmProvider";
import { useAuth } from "../auth/AuthProvider";

// Lightweight shared state so any module can open Astro Chat pre-seeded with a
// question (e.g. a Doshas card's "Ask AI about this"), and can publish its
// computed findings so free-typed questions on that tab are grounded too.
// ChatPanel is the single consumer that renders the panel.

interface AstroChatSeed { prompt: string; nonce: number; }

interface AstroChatState {
  open: boolean;
  setOpen: (b: boolean) => void;
  seed: AstroChatSeed | null;
  /** Open the panel and start a fresh conversation with this question. */
  ask: (prompt: string) => void;
  /** Findings published by the currently-visible module (or null). */
  moduleContext: string[] | null;
  setModuleContext: (findings: string[] | null) => void;
}

const Ctx = createContext<AstroChatState | null>(null);

export function useAstroChat(): AstroChatState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAstroChat must be used within <AstroChatProvider>");
  return ctx;
}

export function AstroChatProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<AstroChatSeed | null>(null);
  const [moduleContext, setModuleContext] = useState<string[] | null>(null);

  const value = useMemo<AstroChatState>(() => ({
    open,
    setOpen,
    seed,
    ask: (prompt: string) => {
      setSeed({ prompt, nonce: Date.now() });
      setOpen(true);
    },
    moduleContext,
    setModuleContext,
  }), [open, seed, moduleContext]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** A module calls this to publish its computed findings to the chat while mounted.
 * Clears them on unmount (tab switch), so the chat only ever sees the active tab. */
export function usePublishChatContext(findings: string[] | null | undefined): void {
  const { setModuleContext } = useAstroChat();
  const key = findings && findings.length ? JSON.stringify(findings) : "";
  useEffect(() => {
    setModuleContext(key ? (JSON.parse(key) as string[]) : null);
    return () => setModuleContext(null);
  }, [key, setModuleContext]);
}

/** A small "✦ Ask AI" button modules drop next to a finding. Hidden unless chat
 * is usable (signed in, feature on, an engine active) — same gate as ChatPanel. */
export function AskAiButton({ prompt, label = "✦ Ask AI" }: { prompt: string; label?: string }) {
  const { ask } = useAstroChat();
  const { enabled } = useLlm();
  const { user, features } = useAuth();
  if (!user || features?.chat === false || !enabled) return null;
  return (
    <button type="button" className="ask-ai-btn" onClick={() => ask(prompt)}>
      {label}
    </button>
  );
}
