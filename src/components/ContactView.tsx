import { useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { api, CONTACT_CATEGORIES } from "../api/client";

export default function ContactView({ onExit }: { onExit: () => void }) {
  const { user } = useAuth();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [category, setCategory] = useState("general");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.sendContactMessage({ name: name.trim(), email: email.trim() || undefined, category, message: message.trim() });
      setSent(true);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not send your message");
    } finally { setBusy(false); }
  };

  return (
    <div className="contact">
      <button className="link back-link" onClick={onExit}>← Back</button>
      <header className="contact-head">
        <span className="section-eyebrow">We're here to help</span>
        <h2>✉️ Contact us</h2>
        <p className="muted">
          Questions about billing, a technical issue, or feedback? Send us a message and we'll get
          back to you.
        </p>
      </header>

      {sent ? (
        <div className="contact-sent">
          <div className="contact-sent-icon">✅</div>
          <h3>Message sent</h3>
          <p className="muted">Thanks, {name || "there"} — we've received your message and will reply soon.</p>
          <button className="primary" onClick={() => { setSent(false); setMessage(""); }}>Send another</button>
        </div>
      ) : (
        <form className="contact-form" onSubmit={submit}>
          <div className="contact-form-grid">
            <label>Name *
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label>Email <span className="muted">(for our reply)</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
          </div>
          <label>Subject
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CONTACT_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          <label>Message *
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={6}
              placeholder="How can we help?" required />
          </label>
          {err && <p className="error small">{err}</p>}
          <button className="primary" type="submit" disabled={busy || !name.trim() || !message.trim()}>
            {busy ? "Sending…" : "Send message"}
          </button>
        </form>
      )}
    </div>
  );
}
