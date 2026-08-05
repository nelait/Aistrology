import { useEffect, useState, useCallback } from "react";
import { api, Temple } from "../api/client";

type View = "browse" | "detail";

function fmtDate(d: string): string {
  try { return new Date(d).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return d; }
}

// Browse-only view for regular users: discover temples and their pooja services
// and events. Temple officials register/manage their temple under the separate
// "Temple Affiliation" page (linked from the home page).
export default function PoojaServicesView() {
  const [view, setView] = useState<View>("browse");
  const [temples, setTemples] = useState<Temple[]>([]);
  const [selectedTemple, setSelectedTemple] = useState<Temple | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // ── Load temples ──
  const loadAll = useCallback(async () => {
    try {
      setLoading(true);
      setTemples(await api.listTemples());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load temples");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const filtered = temples.filter((t) => {
    const q = search.toLowerCase();
    return !q || t.name.toLowerCase().includes(q) || t.deity.toLowerCase().includes(q) || t.location.toLowerCase().includes(q);
  });

  if (loading) return <div className="pooja"><p className="muted">Loading temples…</p></div>;
  if (error) return <div className="pooja"><p className="error">{error}</p></div>;

  // ── Temple detail view ──
  if (view === "detail" && selectedTemple) {
    return (
      <div className="pooja">
        <button className="link back-link" onClick={() => { setView("browse"); setSelectedTemple(null); }}>← Back to temples</button>
        <div className="temple-detail">
          <div className="temple-detail-header">
            {selectedTemple.image_url && (
              <img src={selectedTemple.image_url} alt={selectedTemple.name} className="temple-detail-img" />
            )}
            <div>
              <h2>{selectedTemple.name}</h2>
              <p className="temple-deity">🙏 {selectedTemple.deity}</p>
              <p className="muted">📍 {selectedTemple.location}</p>
              {selectedTemple.description && <p className="temple-desc">{selectedTemple.description}</p>}
              <div className="temple-contact">
                {selectedTemple.contact_email && <span>✉ {selectedTemple.contact_email}</span>}
                {selectedTemple.contact_phone && <span>📞 {selectedTemple.contact_phone}</span>}
                {selectedTemple.website && <a href={selectedTemple.website} target="_blank" rel="noreferrer">🌐 Website</a>}
              </div>
            </div>
          </div>

          {/* Services */}
          <h3>🪔 Pooja Services</h3>
          {(selectedTemple.services?.length ?? 0) === 0 ? (
            <p className="muted">No services listed yet.</p>
          ) : (
            <div className="temple-services-grid">
              {selectedTemple.services!.filter((s) => s.available).map((s) => (
                <div key={s.id} className="temple-service-card">
                  <h4>{s.name}</h4>
                  {s.deity && <p className="service-deity">{s.deity}</p>}
                  {s.description && <p className="service-desc">{s.description}</p>}
                  <div className="service-meta">
                    {s.duration && <span>⏱ {s.duration}</span>}
                    {s.price_inr != null && <span className="service-price">₹{s.price_inr}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Events */}
          <h3>📅 Upcoming Events</h3>
          {(selectedTemple.events?.length ?? 0) === 0 ? (
            <p className="muted">No events scheduled.</p>
          ) : (
            <div className="temple-events-list">
              {selectedTemple.events!.map((ev) => (
                <div key={ev.id} className="temple-event-card">
                  <div className="event-date-badge">{fmtDate(ev.event_date)}</div>
                  <div>
                    <h4>{ev.title}</h4>
                    {ev.event_time && <span className="muted">{ev.event_time}</span>}
                    {ev.description && <p className="event-desc">{ev.description}</p>}
                    {ev.recurring !== "none" && <span className="event-recurring">🔁 {ev.recurring}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Browse view ──
  return (
    <div className="pooja">
      <header className="pooja-head">
        <h2>🛕 Pooja Services</h2>
        <p className="muted">Discover temples, their pooja services, and upcoming events.</p>
      </header>

      <div className="pooja-actions">
        <input
          type="text" placeholder="Search by name, deity, or location…"
          value={search} onChange={(e) => setSearch(e.target.value)}
          className="pooja-search"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="muted" style={{ textAlign: "center", marginTop: 32 }}>No temples listed yet. Check back soon.</p>
      ) : (
        <div className="temple-grid">
          {filtered.map((t) => (
            <div key={t.id} className="temple-card" onClick={() => { setSelectedTemple(t); setView("detail"); }}>
              {t.image_url ? (
                <img src={t.image_url} alt={t.name} className="temple-card-img" />
              ) : (
                <div className="temple-card-img temple-card-placeholder">🛕</div>
              )}
              <div className="temple-card-body">
                <h3>{t.name}</h3>
                <p className="temple-deity">🙏 {t.deity}</p>
                <p className="muted small">📍 {t.location}</p>
                <div className="temple-card-stats">
                  <span>{t.services?.length ?? 0} services</span>
                  <span>{t.events?.length ?? 0} events</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
