import { useEffect, useRef, useState } from "react";
import { useLlm } from "../llm/LlmProvider";
import { useLanguage } from "../i18n/LanguageProvider";
import { useAuth } from "../auth/AuthProvider";
import { api, Reference } from "../api/client";

interface Props {
  subject: string;
  basePrediction: string;
  facts: string[];
  references: Reference[];
  /** Analytical guidelines the LLM should follow (e.g. D1→varga flow, dasha). */
  guidelines?: string[];
}

// A "Justify with sources" button that appears only when an AI engine is active.
// On click it streams a justification (grounded in the classical references) and
// an enhanced prediction, token-by-token.
export default function Justify({ subject, basePrediction, facts, references, guidelines }: Props) {
  const { enabled } = useLlm();
  const { language } = useLanguage();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [text, setText] = useState("");
  const [meta, setMeta] = useState<{ provider: string; model: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const lastLang = useRef<string>("");
  const runToken = useRef(0);

  // Reset when what we're justifying changes (e.g. a new D-chart is selected),
  // and invalidate any in-flight stream so its late tokens are dropped.
  useEffect(() => {
    runToken.current += 1;
    started.current = false;
    lastLang.current = "";
    setOpen(false);
    setStreaming(false);
    setText("");
    setMeta(null);
    setError(null);
  }, [subject, basePrediction]);

  // Free plan users don't see Justify at all
  const userPlan = user?.plan ?? "free";
  if (userPlan === "free") return null;

  if (!enabled) return null;

  async function run() {
    // Re-generate if the language changed since the last run.
    if (started.current && lastLang.current === language.code) {
      setOpen((o) => !o);
      return;
    }
    started.current = true;
    lastLang.current = language.code;
    const token = ++runToken.current;
    const fresh = () => token === runToken.current; // false once inputs change
    setOpen(true);
    setStreaming(true);
    setText("");
    setError(null);
    try {
      await api.justifyStream(
        {
          subject,
          basePrediction,
          facts,
          references,
          language: language.code === "en" ? undefined : language.english,
          guidelines,
        },
        {
          onMeta: (m) => fresh() && setMeta(m),
          onDelta: (t) => fresh() && setText((prev) => prev + t),
          onDone: () => fresh() && setStreaming(false),
          onError: (m) => {
            if (!fresh()) return;
            setError(m);
            setStreaming(false);
          },
        },
      );
    } catch (e) {
      if (fresh()) setError(e instanceof Error ? e.message : "Justification failed");
    } finally {
      if (fresh()) setStreaming(false);
    }
  }

  const langChanged = started.current && lastLang.current !== language.code;
  const label = streaming
    ? "Consulting the classics…"
    : langChanged
      ? `✦ Justify in ${language.native}`
      : started.current
        ? open
          ? "Hide justification"
          : "Show justification"
        : "✦ Justify with sources";

  const paragraphs = text.split(/\n\n+/).filter(Boolean);

  return (
    <div className="justify">
      <button className="justify-btn" onClick={run} disabled={streaming}>
        {label}
      </button>

      {open && (
        <div className="justify-panel">
          <div className="justify-section">
            <h4>Referenced texts</h4>
            <ul className="refs">
              {references.map((r, i) => (
                <li key={i}>
                  <span className="ref-source">{r.source}</span>
                  <span className="ref-text">{r.text}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="justify-section">
            <h4>Justification &amp; enhanced reading</h4>
            {paragraphs.length === 0 && streaming && <p className="muted">Consulting the classics…</p>}
            {paragraphs.map((p, i) => (
              <p key={i}>
                {p}
                {streaming && i === paragraphs.length - 1 && <span className="stream-cursor">▊</span>}
              </p>
            ))}
          </div>

          {error && <p className="error small">{error}</p>}
          {!streaming && meta && (
            <p className="muted small justify-foot">
              {meta.provider === "demo"
                ? "Composed offline from the classical references above."
                : `Streamed from ${meta.provider} (${meta.model}), grounded in the references above.`}{" "}
              AI-assisted — verify against a qualified astrologer.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
