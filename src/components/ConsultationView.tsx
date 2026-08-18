import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import {
  api,
  ConsultationData,
  ConsultationProvider,
  ConsultationBooking,
  ProviderType,
  PROVIDER_TYPE_LABEL,
} from "../api/client";

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`consult-status s-${status}`}>{status}</span>;
}

export default function ConsultationView() {
  const { user } = useAuth();
  const [data, setData] = useState<ConsultationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bookingProvider, setBookingProvider] = useState<ConsultationProvider | null>(null);
  const [typeFilter, setTypeFilter] = useState<ProviderType | "all">("all");

  const load = async () => {
    try {
      setData(await api.getConsultation());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load consultations");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <div className="consult"><p className="muted">Loading consultations…</p></div>;
  if (error) return <div className="consult"><p className="error">{error}</p></div>;
  if (!data) return null;

  const ownOfferId = data.offer?.id;
  const allBookable = data.providers.filter((p) => p.id !== ownOfferId);
  // "both" providers show under either filter.
  const bookableProviders = typeFilter === "all"
    ? allBookable
    : allBookable.filter((p) => p.providerType === typeFilter || p.providerType === "both");
  const typeCount = (t: ProviderType) =>
    allBookable.filter((p) => p.providerType === t || p.providerType === "both").length;

  return (
    <div className="consult">
      <header className="consult-head">
        <h2>Consultations</h2>
        <p className="muted">
          Connect with real Vedic astrologers and priests. Book a one-on-one session for a reading,
          a ritual or a remedy — or, on the Premium plan, publish your own profile and take booking
          requests.
        </p>
      </header>

      {/* Provider zone: Premium can offer; others see an upsell */}
      {data.canOffer ? (
        <ProviderPanel data={data} onChange={load} />
      ) : (
        <div className="consult-upsell">
          <div className="consult-upsell-icon">💼</div>
          <div>
            <h3>Are you an astrologer or a priest?</h3>
            <p className="muted">
              Upgrade to <strong>Premium</strong> to publish a provider profile — list your
              specialities, whether that's chart readings, poojas or remedies — and receive booking
              requests from seekers across Shastri.
            </p>
          </div>
          <button
            className="btn-plan-upgrade premium consult-upsell-btn"
            onClick={async () => {
              try {
                const { url } = await api.createCheckout("premium");
                if (url) window.location.href = url;
              } catch { /* ignore */ }
            }}
          >
            Go Premium
          </button>
        </div>
      )}

      {/* Directory */}
      <section className="consult-section">
        <div className="consult-dir-head">
          <h3 className="consult-h3">Find an astrologer or priest</h3>
          {allBookable.length > 0 && (
            <div className="ptype-filter" role="group" aria-label="Filter by provider type">
              <button className={typeFilter === "all" ? "on" : ""} onClick={() => setTypeFilter("all")}>
                All <span className="ptype-count">{allBookable.length}</span>
              </button>
              <button className={typeFilter === "astrologer" ? "on" : ""} onClick={() => setTypeFilter("astrologer")}>
                Astrologers <span className="ptype-count">{typeCount("astrologer")}</span>
              </button>
              <button className={typeFilter === "priest" ? "on" : ""} onClick={() => setTypeFilter("priest")}>
                Priests <span className="ptype-count">{typeCount("priest")}</span>
              </button>
            </div>
          )}
        </div>
        {allBookable.length === 0 ? (
          <p className="muted small">
            No providers are available just yet. Premium astrologers and priests who publish a
            profile will appear here.
          </p>
        ) : bookableProviders.length === 0 ? (
          <p className="muted small">
            No {typeFilter === "priest" ? "priests" : "astrologers"} are listed yet —{" "}
            <button className="link" onClick={() => setTypeFilter("all")}>show all providers</button>.
          </p>
        ) : (
          <div className="consult-grid">
            {bookableProviders.map((p) => (
              <div className="provider-card" key={p.id}>
                <div className="provider-card-head">
                  <h4>{p.displayName}</h4>
                  <span className={`ptype-badge t-${p.providerType}`}>
                    {p.providerType === "priest" ? "🪔" : p.providerType === "both" ? "🔱" : "🪐"}{" "}
                    {PROVIDER_TYPE_LABEL[p.providerType] ?? "Astrologer"}
                  </span>
                </div>
                <p className="provider-headline">{p.headline}</p>
                <p className="provider-bio">{p.bio}</p>
                {(p.specialties || p.languages) && (
                  <div className="provider-tags">
                    {p.specialties?.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (
                      <span className="provider-tag" key={s}>{s}</span>
                    ))}
                    {p.languages && <span className="provider-tag lang">🗣 {p.languages}</span>}
                  </div>
                )}
                <div className="provider-foot">
                  <span className="provider-rate">
                    {p.rateInr != null ? `₹${p.rateInr}/session` : "Rate on request"}
                  </span>
                  <button className="book-btn" onClick={() => setBookingProvider(p)}>
                    Request consultation
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* My bookings */}
      <section className="consult-section">
        <h3 className="consult-h3">My booking requests</h3>
        {data.bookings.length === 0 ? (
          <p className="muted small">You haven't requested any consultations yet.</p>
        ) : (
          <ul className="booking-list">
            {data.bookings.map((b) => (
              <li className="booking-item" key={b.id}>
                <div>
                  <strong>{b.providerName}</strong>
                  <span className="muted small"> · {fmtDate(b.createdAt)}</span>
                  <p className="booking-topic">{b.topic}</p>
                  {b.preferredTime && <p className="muted small">Preferred: {b.preferredTime}</p>}
                </div>
                <StatusBadge status={b.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {bookingProvider && (
        <BookingModal
          provider={bookingProvider}
          defaultEmail={user?.email ?? ""}
          onClose={() => setBookingProvider(null)}
          onBooked={() => { setBookingProvider(null); load(); }}
        />
      )}
    </div>
  );
}

/* -------------------- Provider panel (Premium) -------------------- */

function ProviderPanel({ data, onChange }: { data: ConsultationData; onChange: () => void }) {
  const offer = data.offer;
  const [displayName, setDisplayName] = useState(offer?.displayName ?? "");
  const [headline, setHeadline] = useState(offer?.headline ?? "");
  const [bio, setBio] = useState(offer?.bio ?? "");
  const [providerType, setProviderType] = useState<ProviderType>(offer?.providerType ?? "astrologer");
  const [specialties, setSpecialties] = useState(offer?.specialties ?? "");
  const [languages, setLanguages] = useState(offer?.languages ?? "");
  const [rate, setRate] = useState(offer?.rateInr != null ? String(offer.rateInr) : "");
  const [contactEmail, setContactEmail] = useState(offer?.contactEmail ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null); setMsg(null);
    try {
      await api.saveOffer({
        displayName, headline, bio, providerType,
        specialties: specialties || undefined,
        languages: languages || undefined,
        rateInr: rate.trim() === "" ? null : Number(rate),
        contactEmail: contactEmail || undefined,
      });
      setMsg(offer ? "Profile updated — it's live in the directory." : "Profile published to the directory.");
      onChange();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not save profile");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="consult-section provider-panel">
      <h3 className="consult-h3">
        Your provider profile
        {offer && <StatusBadge status={offer.status} />}
      </h3>
      <p className="muted small">
        Publish the services you offer. Approved profiles appear in the directory, and seekers can
        send you booking requests.
      </p>

      <form className="consult-form" onSubmit={submit}>
        <div className="cform-grid">
          <label>
            Display name
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Pandit R. Sharma" required />
          </label>
          <label>
            Rate per session <span className="muted">(₹, optional)</span>
            <input value={rate} onChange={(e) => setRate(e.target.value)}
              inputMode="numeric" placeholder="e.g. 1500" />
          </label>
        </div>
        <label>
          I offer
          <div className="ptype-choice">
            {(Object.keys(PROVIDER_TYPE_LABEL) as ProviderType[]).map((t) => (
              <button
                key={t}
                type="button"
                className={providerType === t ? "on" : ""}
                onClick={() => setProviderType(t)}
              >
                {PROVIDER_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </label>
        <label>
          Headline
          <input value={headline} onChange={(e) => setHeadline(e.target.value)}
            placeholder="One line — e.g. 20 yrs in Vedic & KP astrology" required />
        </label>
        <label>
          About your services
          <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={4}
            placeholder="Describe what you offer, your approach and experience." required />
        </label>
        <div className="cform-grid">
          <label>
            Specialties <span className="muted">(comma-separated)</span>
            <input value={specialties} onChange={(e) => setSpecialties(e.target.value)}
              placeholder="Marriage, Career, Remedies" />
          </label>
          <label>
            Languages
            <input value={languages} onChange={(e) => setLanguages(e.target.value)}
              placeholder="Hindi, English, Telugu" />
          </label>
        </div>
        <label>
          Contact email <span className="muted">(shared with confirmed seekers)</span>
          <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)}
            type="email" placeholder="you@example.com" />
        </label>

        {err && <p className="error small">{err}</p>}
        {msg && <p className="consult-ok small">{msg}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : offer ? "Update profile" : "Publish profile"}
        </button>
      </form>

      {/* Incoming requests */}
      <h3 className="consult-h3" style={{ marginTop: 26 }}>Incoming requests</h3>
      {data.requests.length === 0 ? (
        <p className="muted small">No booking requests yet.</p>
      ) : (
        <ul className="booking-list">
          {data.requests.map((r) => (
            <RequestItem key={r.id} req={r} onChange={onChange} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RequestItem({ req, onChange }: { req: ConsultationBooking; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (status: string) => {
    setBusy(true);
    try {
      await api.updateRequestStatus(req.id, status);
      onChange();
    } catch { /* ignore */ } finally { setBusy(false); }
  };
  return (
    <li className="booking-item">
      <div>
        <strong>{req.seekerName ?? "Seeker"}</strong>
        <span className="muted small"> · {fmtDate(req.createdAt)}</span>
        <p className="booking-topic">{req.topic}</p>
        {req.preferredTime && <p className="muted small">Preferred: {req.preferredTime}</p>}
        {req.message && <p className="muted small">“{req.message}”</p>}
        {req.status === "confirmed" && req.contactEmail && (
          <p className="muted small">Contact: {req.contactEmail}</p>
        )}
      </div>
      <div className="request-actions">
        <StatusBadge status={req.status} />
        {req.status === "requested" && (
          <div className="request-btns">
            <button className="mini-btn ok" disabled={busy} onClick={() => act("confirmed")}>Confirm</button>
            <button className="mini-btn no" disabled={busy} onClick={() => act("declined")}>Decline</button>
          </div>
        )}
        {req.status === "confirmed" && (
          <button className="mini-btn" disabled={busy} onClick={() => act("completed")}>Mark done</button>
        )}
      </div>
    </li>
  );
}

/* -------------------- Booking modal -------------------- */

function BookingModal({
  provider, defaultEmail, onClose, onBooked,
}: {
  provider: ConsultationProvider;
  defaultEmail: string;
  onClose: () => void;
  onBooked: () => void;
}) {
  const [topic, setTopic] = useState("");
  const [preferredTime, setPreferredTime] = useState("");
  const [message, setMessage] = useState("");
  const [contactEmail, setContactEmail] = useState(defaultEmail);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const rateLabel = useMemo(
    () => (provider.rateInr != null ? `₹${provider.rateInr}/session` : "Rate on request"),
    [provider.rateInr],
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.createBooking({
        offerId: provider.id, topic,
        preferredTime: preferredTime || undefined,
        message: message || undefined,
        contactEmail: contactEmail || undefined,
      });
      onBooked();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not send request");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="consult-modal-overlay" onClick={onClose}>
      <div className="consult-modal" onClick={(e) => e.stopPropagation()}>
        <div className="consult-modal-head">
          <div>
            <h3>Request a consultation</h3>
            <p className="muted small">
              with <strong>{provider.displayName}</strong> · {rateLabel}
            </p>
          </div>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <form className="consult-form" onSubmit={submit}>
          <label>
            What would you like to discuss?
            <input value={topic} onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. Career direction & timing" required />
          </label>
          <label>
            Preferred time <span className="muted">(optional)</span>
            <input value={preferredTime} onChange={(e) => setPreferredTime(e.target.value)}
              placeholder="e.g. Weekend evenings IST" />
          </label>
          <label>
            Message <span className="muted">(optional)</span>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3}
              placeholder="Anything the astrologer should know beforehand." />
          </label>
          <label>
            Your contact email
            <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)}
              type="email" placeholder="you@example.com" />
          </label>
          {err && <p className="error small">{err}</p>}
          <div className="consult-modal-actions">
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send request"}
            </button>
            <button className="ghost" type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
