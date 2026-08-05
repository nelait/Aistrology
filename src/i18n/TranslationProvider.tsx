import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../api/client";
import { useLanguage } from "./LanguageProvider";
import { useLlm } from "../llm/LlmProvider";

// App-wide, on-demand translation of reading text via the LLM. Any view calls
// `ensure(strings)` for the text it shows; requests are de-duplicated and
// batched into a single translate call. `t(text)` returns the translation once
// available (or the original until then / when translation is off).

interface TranslationState {
  active: boolean; // translation mode is on
  available: boolean; // language ≠ English AND an AI engine is configured
  translating: boolean;
  demoBlocked: boolean; // last request hit the demo engine (can't translate)
  error: string | null;
  t: (text: string) => string;
  ensure: (items: string[]) => void;
  toggle: () => void;
}

const TranslationContext = createContext<TranslationState | null>(null);

export function useTranslation(): TranslationState {
  const ctx = useContext(TranslationContext);
  if (!ctx) throw new Error("useTranslation must be used within <TranslationProvider>");
  return ctx;
}

export function TranslationProvider({ children }: { children: ReactNode }) {
  const { language } = useLanguage();
  const { enabled: llmEnabled } = useLlm();

  const [active, setActive] = useState(false);
  const [cache, setCache] = useState<Map<string, string>>(new Map());
  const [translating, setTranslating] = useState(false);
  const [demoBlocked, setDemoBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cacheRef = useRef(cache);
  const pending = useRef<Set<string>>(new Set());
  const inflight = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const available = language.code !== "en" && llmEnabled;

  // Reset everything when the language changes.
  useEffect(() => {
    cacheRef.current = new Map();
    setCache(new Map());
    pending.current.clear();
    inflight.current.clear();
    setDemoBlocked(false);
    setError(null);
  }, [language.code]);

  // Turn translation off if it stops being available.
  useEffect(() => {
    if (!available) setActive(false);
  }, [available]);

  const flush = useCallback(async () => {
    const items = [...pending.current];
    pending.current.clear();
    if (!items.length) return;
    items.forEach((i) => inflight.current.add(i));
    setTranslating(true);
    setError(null);
    try {
      const res = await api.translate(items, language.english);
      setDemoBlocked(!res.translated);
      setCache((prev) => {
        const m = new Map(prev);
        items.forEach((it, i) => m.set(it, res.translations[i] ?? it));
        cacheRef.current = m;
        return m;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Translation failed");
      // Cache failed items with original text to prevent infinite retry loops.
      setCache((prev) => {
        const m = new Map(prev);
        items.forEach((it) => m.set(it, it));
        cacheRef.current = m;
        return m;
      });
    } finally {
      items.forEach((i) => inflight.current.delete(i));
      setTranslating(false);
    }
  }, [language.english]);

  const ensure = useCallback(
    (items: string[]) => {
      if (!active || language.code === "en") return;
      let added = false;
      for (const it of items) {
        if (it && !cacheRef.current.has(it) && !inflight.current.has(it) && !pending.current.has(it)) {
          pending.current.add(it);
          added = true;
        }
      }
      if (added) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, 60);
      }
    },
    [active, language.code, flush],
  );

  const t = useCallback(
    (text: string) => (active && language.code !== "en" ? cache.get(text) ?? text : text),
    [active, language.code, cache],
  );

  const toggle = useCallback(() => {
    setActive((a) => {
      if (!a) {
        // Re-activating: clear error and cache so failed items are retried.
        setError(null);
        setDemoBlocked(false);
        cacheRef.current = new Map();
        setCache(new Map());
        pending.current.clear();
        inflight.current.clear();
      }
      return !a;
    });
  }, []);

  return (
    <TranslationContext.Provider
      value={{ active, available, translating, demoBlocked, error, t, ensure, toggle }}
    >
      {children}
    </TranslationContext.Provider>
  );
}
