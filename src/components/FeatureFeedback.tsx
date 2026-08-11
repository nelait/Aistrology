import { useEffect, useState } from "react";
import { api } from "../api/client";

/**
 * "Was this helpful?" strip rendered at the foot of every feature tab.
 *
 * One instance is mounted in App.tsx with the active tab as `feature`, so every
 * module is covered without touching each view. Submissions land in the
 * `feedback` table and are read back in Admin → Feedback.
 */
export function FeatureFeedback({ feature, label }: { feature: string; label?: string }) {
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [comment, setComment] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Switching module resets the widget — feedback is always about what's on screen.
  useEffect(() => {
    setRating(null);
    setComment("");
    setSent(false);
    setError(null);
  }, [feature]);

  async function submit(r: "up" | "down", text: string) {
    setBusy(true);
    setError(null);
    try {
      await api.sendFeedback({ feature, rating: r, comment: text });
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send feedback.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <section className="feature-feedback sent" aria-label="Feature feedback">
        <p className="ff-thanks">✅ Thanks — your feedback helps us improve {label ?? feature}.</p>
      </section>
    );
  }

  return (
    <section className="feature-feedback" aria-label="Feature feedback">
      <div className="ff-row">
        <span className="ff-q">Was {label ?? "this"} helpful?</span>
        <div className="ff-buttons" role="group" aria-label="Rate this feature">
          <button
            type="button"
            className={rating === "up" ? "ff-btn up active" : "ff-btn up"}
            aria-pressed={rating === "up"}
            disabled={busy}
            onClick={() => setRating("up")}
          >
            👍 Yes
          </button>
          <button
            type="button"
            className={rating === "down" ? "ff-btn down active" : "ff-btn down"}
            aria-pressed={rating === "down"}
            disabled={busy}
            onClick={() => setRating("down")}
          >
            👎 No
          </button>
        </div>
      </div>

      {rating && (
        <div className="ff-detail">
          <label className="ff-label" htmlFor={`ff-comment-${feature}`}>
            {rating === "up"
              ? "What worked well? (optional)"
              : "What was missing or wrong? (optional)"}
          </label>
          <textarea
            id={`ff-comment-${feature}`}
            className="ff-textarea"
            rows={3}
            maxLength={2000}
            value={comment}
            placeholder={rating === "up" ? "Anything you'd like more of…" : "Tell us what to fix…"}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="ff-actions">
            <button type="button" className="mini-btn ok" disabled={busy} onClick={() => submit(rating, comment)}>
              {busy ? "Sending…" : "Send feedback"}
            </button>
            <button type="button" className="mini-btn" disabled={busy} onClick={() => { setRating(null); setComment(""); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="ff-error">{error}</p>}
    </section>
  );
}
