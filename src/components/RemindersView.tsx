import { useCallback, useEffect, useState } from "react";
import { api, Reminder, ReminderFestival } from "../api/client";

function fmt(iso: string, recurring: boolean): string {
  const d = new Date(iso + "T00:00:00Z");
  const base = d.toLocaleDateString("en-GB", { day: "numeric", month: "long", ...(recurring ? {} : { year: "numeric" }) });
  return recurring ? `${base} (every year)` : base;
}

export default function RemindersView({ onExit }: { onExit: () => void }) {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [festivals, setFestivals] = useState<ReminderFestival[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.getReminders();
      setReminders(d.reminders);
      setFestivals(d.festivals);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load reminders");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="reminders">
      <button className="link back-link" onClick={onExit}>← Back</button>
      <header className="reminders-head">
        <span className="section-eyebrow">Never forget</span>
        <h2>⏰ Reminders</h2>
        <p className="muted">
          Add the dates that matter — annual rituals, anniversaries, special days — and we'll remind
          you ahead of time by email and in-app. Opt in to festival reminders too.
        </p>
      </header>

      {error && <p className="error">{error}</p>}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <MyReminders reminders={reminders} onChange={load} />
          <Festivals festivals={festivals} onChange={load} />
        </>
      )}
    </div>
  );
}

/* -------------------- Personal reminders -------------------- */

function MyReminders({ reminders, onChange }: { reminders: Reminder[]; onChange: () => void }) {
  const [showForm, setShowForm] = useState(false);

  const toggle = async (r: Reminder) => {
    await api.updateReminder(r.id, { enabled: !r.enabled });
    onChange();
  };
  const remove = async (id: string) => {
    await api.deleteReminder(id);
    onChange();
  };

  return (
    <section className="reminders-section">
      <div className="reminders-section-head">
        <h3>My reminders</h3>
        <button className="primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Close" : "+ Add reminder"}
        </button>
      </div>

      {showForm && <ReminderForm onDone={() => { setShowForm(false); onChange(); }} />}

      {reminders.length === 0 ? (
        <p className="muted small">No reminders yet. Add your first important date above.</p>
      ) : (
        <ul className="reminder-list">
          {reminders.map((r) => (
            <li key={r.id} className={`reminder-item${r.enabled ? "" : " off"}`}>
              <div className="reminder-main">
                <strong>{r.title}</strong>
                <span className="reminder-date">{fmt(r.eventDate, r.recurrence === "annual")}</span>
                {r.notes && <p className="muted small">{r.notes}</p>}
                <span className="muted small">Reminds {r.leadDays} day{r.leadDays === 1 ? "" : "s"} before</span>
              </div>
              <div className="reminder-actions">
                <label className="switch" title={r.enabled ? "On" : "Off"}>
                  <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} />
                  <span className="switch-slider" />
                </label>
                <button className="temple-remove-btn" title="Delete" onClick={() => remove(r.id)}>✕</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReminderForm({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [recurrence, setRecurrence] = useState("annual");
  const [leadDays, setLeadDays] = useState("7");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.createReminder({
        title, eventDate, recurrence,
        leadDays: parseInt(leadDays) || 0, notes,
      });
      onDone();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not save");
    } finally { setBusy(false); }
  };

  return (
    <form className="reminder-form" onSubmit={submit}>
      <div className="reminder-form-grid">
        <label>Title *
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Father's Shraddha" required />
        </label>
        <label>Date *
          <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} required />
        </label>
        <label>Repeats
          <select value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
            <option value="annual">Every year</option>
            <option value="once">One-time</option>
          </select>
        </label>
        <label>Remind me
          <select value={leadDays} onChange={(e) => setLeadDays(e.target.value)}>
            <option value="0">On the day</option>
            <option value="1">1 day before</option>
            <option value="3">3 days before</option>
            <option value="7">1 week before</option>
            <option value="15">15 days before</option>
            <option value="30">1 month before</option>
          </select>
        </label>
      </div>
      <label>Notes
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Anything to remember (rituals, people to inform…)" />
      </label>
      {err && <p className="error small">{err}</p>}
      <button className="primary" type="submit" disabled={busy || !title || !eventDate}>
        {busy ? "Saving…" : "Save reminder"}
      </button>
    </form>
  );
}

/* -------------------- Festivals (opt-in) -------------------- */

function Festivals({ festivals, onChange }: { festivals: ReminderFestival[]; onChange: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const toggleSub = async (f: ReminderFestival) => {
    setBusyId(f.id);
    try {
      if (f.subscribed) await api.unsubscribeFestival(f.id);
      else await api.subscribeFestival(f.id, 3);
      onChange();
    } finally { setBusyId(null); }
  };
  const setLead = async (f: ReminderFestival, leadDays: number) => {
    setBusyId(f.id);
    try { await api.subscribeFestival(f.id, leadDays); onChange(); }
    finally { setBusyId(null); }
  };

  return (
    <section className="reminders-section">
      <div className="reminders-section-head">
        <h3>Festivals &amp; special dates</h3>
      </div>
      <p className="muted small">Opt in to the festivals you'd like a heads-up about.</p>
      {festivals.length === 0 ? (
        <p className="muted small">No festivals published yet.</p>
      ) : (
        <ul className="reminder-list">
          {festivals.map((f) => (
            <li key={f.id} className="reminder-item">
              <div className="reminder-main">
                <strong>{f.name}</strong>
                <span className="reminder-date">{fmt(f.eventDate, f.recurring)}</span>
                {f.description && <p className="muted small">{f.description}</p>}
                {f.subscribed && (
                  <label className="festival-lead muted small">
                    Remind me
                    <select value={f.leadDays} disabled={busyId === f.id} onChange={(e) => setLead(f, parseInt(e.target.value))}>
                      <option value="0">on the day</option>
                      <option value="1">1 day before</option>
                      <option value="3">3 days before</option>
                      <option value="7">1 week before</option>
                    </select>
                  </label>
                )}
              </div>
              <div className="reminder-actions">
                <button
                  className={f.subscribed ? "mini-btn ok" : "book-btn"}
                  disabled={busyId === f.id}
                  onClick={() => toggleSub(f)}
                >
                  {f.subscribed ? "✓ Subscribed" : "Remind me"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
