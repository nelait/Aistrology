import { useCallback, useEffect, useState } from "react";
import { api, Temple } from "../api/client";

function fmtDate(d: string): string {
  try { return new Date(d).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return d; }
}
function StatusBadge({ status }: { status: string }) {
  const color = status === "approved" ? "#22c55e" : status === "pending" ? "#eab308" : "#ef4444";
  return <span className="temple-status" style={{ color, borderColor: color }}>{status}</span>;
}

/**
 * Temple Portal — temples are their own accounts (own credentials), fully
 * separate from astrology users. Register or sign in here, then manage the
 * temple's pooja services and event calendar. No astrology login required.
 */
export default function TempleAffiliationView({
  onExit, initialMode = "login",
}: { onExit: () => void; initialMode?: "login" | "register" }) {
  const [temple, setTemple] = useState<Temple | null | undefined>(undefined); // undefined = loading
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setTemple(await api.templePortal()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to load"); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const logout = async () => {
    await api.templeLogout();
    setTemple(null);
  };

  return (
    <div className="temple-affiliation">
      <button className="link back-link" onClick={onExit}>← Back to home</button>
      <header className="temple-aff-head">
        <span className="section-eyebrow">Temple Affiliation</span>
        <h2>🛕 Temple Portal</h2>
        <p className="muted">
          A dedicated portal for temples — separate from astrology accounts. Register or sign in with
          your temple credentials to list pooja services and maintain an event calendar. Approved
          temples appear to devotees under <strong>Pooja Services</strong>.
        </p>
      </header>

      {error && <p className="error">{error}</p>}
      {temple === undefined ? (
        <p className="muted">Loading…</p>
      ) : temple ? (
        <TempleManagePanel temple={temple} onRefresh={load} onLogout={logout} />
      ) : (
        <TempleAuthPanel initialMode={initialMode} onAuthed={setTemple} />
      )}
    </div>
  );
}

/* -------------------- Register / Login -------------------- */

function TempleAuthPanel({
  initialMode, onAuthed,
}: { initialMode: "login" | "register"; onAuthed: (t: Temple) => void }) {
  const [mode, setMode] = useState<"login" | "register">(initialMode);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Shared credentials
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Registration fields
  const [form, setForm] = useState({
    name: "", deity: "", location: "", description: "",
    contactEmail: "", contactPhone: "", website: "",
  });
  const [imageUrl, setImageUrl] = useState("");

  const onImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setErr("Image must be under 2MB"); return; }
    const reader = new FileReader();
    reader.onload = () => setImageUrl(reader.result as string);
    reader.readAsDataURL(file);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const temple = mode === "login"
        ? await api.templeLogin(email.trim(), password)
        : await api.templeRegister({
            ...form, email: email.trim(), password, imageUrl: imageUrl || undefined,
          });
      onAuthed(temple);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="temple-auth">
      <div className="temple-auth-toggle">
        <button className={mode === "login" ? "on" : ""} onClick={() => { setMode("login"); setErr(null); }}>Temple Login</button>
        <button className={mode === "register" ? "on" : ""} onClick={() => { setMode("register"); setErr(null); }}>Register Your Temple</button>
      </div>

      <form className="temple-form" onSubmit={submit}>
        {mode === "register" && (
          <>
            <label>Temple Name *
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label>Primary Deity *
              <input value={form.deity} onChange={(e) => setForm({ ...form, deity: e.target.value })} placeholder="e.g. Lord Shiva" required />
            </label>
            <label>Location *
              <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="City, State" required />
            </label>
            <label>Description
              <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />
            </label>
            <label>Contact Email
              <input type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
            </label>
            <label>Contact Phone
              <input value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
            </label>
            <label>Website
              <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://…" />
            </label>
            <label>Temple Image
              <input type="file" accept="image/*" onChange={onImage} />
            </label>
            {imageUrl && <img src={imageUrl} alt="Preview" className="temple-img-preview" />}
            <hr className="temple-auth-sep" />
          </>
        )}

        <p className="muted small">{mode === "login" ? "Sign in with your temple credentials." : "Choose login credentials for your temple account."}</p>
        <label>Login Email *
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
        </label>
        <label>Password *
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "register" ? "At least 8 characters" : ""} autoComplete="off" required />
        </label>

        {err && <p className="error small">{err}</p>}
        <button className="temple-save-btn" type="submit"
          disabled={busy || (mode === "register" && (!form.name || !form.deity || !form.location))}>
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Register Temple"}
        </button>
      </form>
    </div>
  );
}

/* -------------------- Manage -------------------- */

function TempleManagePanel({
  temple, onRefresh, onLogout,
}: { temple: Temple; onRefresh: () => void; onLogout: () => void }) {
  const [form, setForm] = useState({
    name: temple.name, deity: temple.deity, location: temple.location,
    description: temple.description, contactEmail: temple.contact_email ?? "",
    contactPhone: temple.contact_phone ?? "", website: temple.website ?? "",
  });
  const [imageUrl, setImageUrl] = useState(temple.image_url ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [svc, setSvc] = useState({ name: "", desc: "", deity: "", duration: "", price: "" });
  const [addingSvc, setAddingSvc] = useState(false);
  const [ev, setEv] = useState({ title: "", desc: "", date: "", time: "", recurring: "none" });
  const [addingEv, setAddingEv] = useState(false);

  const onImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setMsg("Image must be under 2MB"); return; }
    const reader = new FileReader();
    reader.onload = () => setImageUrl(reader.result as string);
    reader.readAsDataURL(file);
  };

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      await api.updateMyTemple({ ...form, imageUrl });
      setMsg("✅ Temple updated!");
      onRefresh();
    } catch (e) { setMsg("❌ " + (e instanceof Error ? e.message : "Failed")); }
    finally { setSaving(false); }
  };

  const addService = async () => {
    if (!svc.name) return;
    setAddingSvc(true);
    try {
      await api.addTempleService({
        name: svc.name, description: svc.desc, deity: svc.deity || undefined,
        duration: svc.duration || undefined, priceInr: svc.price ? parseInt(svc.price) : undefined,
      });
      setSvc({ name: "", desc: "", deity: "", duration: "", price: "" });
      onRefresh();
    } catch { setMsg("❌ Failed to add service"); }
    finally { setAddingSvc(false); }
  };
  const removeService = async (sid: string) => { await api.deleteTempleService(sid); onRefresh(); };

  const addEvent = async () => {
    if (!ev.title || !ev.date) return;
    setAddingEv(true);
    try {
      await api.addTempleEvent({
        title: ev.title, description: ev.desc, eventDate: ev.date,
        eventTime: ev.time || undefined, recurring: ev.recurring,
      });
      setEv({ title: "", desc: "", date: "", time: "", recurring: "none" });
      onRefresh();
    } catch { setMsg("❌ Failed to add event"); }
    finally { setAddingEv(false); }
  };
  const removeEvent = async (eid: string) => { await api.deleteTempleEvent(eid); onRefresh(); };

  return (
    <div className="temple-manage">
      <div className="temple-manage-topbar">
        <p className="temple-status-line">
          <strong>{temple.name}</strong> · Status: <StatusBadge status={temple.status} />
        </p>
        <button className="link small" onClick={onLogout}>Sign out</button>
      </div>
      {temple.status === "pending" && (
        <p className="muted small">Your temple is awaiting admin approval — it isn't visible to devotees yet.</p>
      )}

      <div className="temple-form">
        <label>Temple Name *
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>Primary Deity *
          <input value={form.deity} onChange={(e) => setForm({ ...form, deity: e.target.value })} />
        </label>
        <label>Location *
          <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
        </label>
        <label>Description
          <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />
        </label>
        <label>Contact Email
          <input type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
        </label>
        <label>Contact Phone
          <input value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
        </label>
        <label>Website
          <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://…" />
        </label>
        <label>Temple Image
          <input type="file" accept="image/*" onChange={onImage} />
        </label>
        {imageUrl && <img src={imageUrl} alt="Preview" className="temple-img-preview" />}
        <button className="temple-save-btn" onClick={save} disabled={saving || !form.name || !form.deity || !form.location}>
          {saving ? "Saving…" : "Update Temple"}
        </button>
        {msg && <p className="temple-msg">{msg}</p>}
      </div>

      <div className="temple-manage-section">
        <h3>🪔 Pooja Services ({temple.services?.length ?? 0})</h3>
        {(temple.services?.length ?? 0) > 0 && (
          <div className="temple-manage-list">
            {temple.services!.map((s) => (
              <div key={s.id} className="temple-manage-item">
                <span><strong>{s.name}</strong>{s.price_inr != null && ` — ₹${s.price_inr}`}{s.duration && ` · ${s.duration}`}</span>
                <button className="temple-remove-btn" onClick={() => removeService(s.id)}>✕</button>
              </div>
            ))}
          </div>
        )}
        <div className="temple-add-form">
          <input placeholder="Service name *" value={svc.name} onChange={(e) => setSvc({ ...svc, name: e.target.value })} />
          <input placeholder="Description" value={svc.desc} onChange={(e) => setSvc({ ...svc, desc: e.target.value })} />
          <input placeholder="Deity" value={svc.deity} onChange={(e) => setSvc({ ...svc, deity: e.target.value })} />
          <input placeholder="Duration" value={svc.duration} onChange={(e) => setSvc({ ...svc, duration: e.target.value })} />
          <input placeholder="Price (₹)" type="number" value={svc.price} onChange={(e) => setSvc({ ...svc, price: e.target.value })} />
          <button onClick={addService} disabled={addingSvc || !svc.name}>{addingSvc ? "Adding…" : "Add Service"}</button>
        </div>
      </div>

      <div className="temple-manage-section">
        <h3>📅 Event Calendar ({temple.events?.length ?? 0})</h3>
        {(temple.events?.length ?? 0) > 0 && (
          <div className="temple-manage-list">
            {temple.events!.map((e) => (
              <div key={e.id} className="temple-manage-item">
                <span><strong>{e.title}</strong> — {fmtDate(e.event_date)}{e.recurring !== "none" && ` (${e.recurring})`}</span>
                <button className="temple-remove-btn" onClick={() => removeEvent(e.id)}>✕</button>
              </div>
            ))}
          </div>
        )}
        <div className="temple-add-form">
          <input placeholder="Event title *" value={ev.title} onChange={(e) => setEv({ ...ev, title: e.target.value })} />
          <input placeholder="Description" value={ev.desc} onChange={(e) => setEv({ ...ev, desc: e.target.value })} />
          <input type="date" value={ev.date} onChange={(e) => setEv({ ...ev, date: e.target.value })} />
          <input type="time" value={ev.time} onChange={(e) => setEv({ ...ev, time: e.target.value })} />
          <select value={ev.recurring} onChange={(e) => setEv({ ...ev, recurring: e.target.value })}>
            <option value="none">One-time</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="annual">Annual</option>
          </select>
          <button onClick={addEvent} disabled={addingEv || !ev.title || !ev.date}>{addingEv ? "Adding…" : "Add Event"}</button>
        </div>
      </div>
    </div>
  );
}
