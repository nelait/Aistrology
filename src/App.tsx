import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./auth/AuthProvider";
import { api } from "./api/client";
import BirthForm from "./components/BirthForm";
import ChatPanel from "./components/ChatPanel";
import { FeatureFeedback } from "./components/FeatureFeedback";
import ProfileSwitcher from "./components/ProfileSwitcher";
import LessonsDrawer from "./components/LessonsDrawer";
import NorthChart, { SignLegend } from "./components/NorthChart";
import SouthChart from "./components/SouthChart";
import PlanetTable from "./components/PlanetTable";
import Predictions from "./components/Predictions";
import DashaView from "./components/DashaView";
import TransitView from "./components/TransitView";
import ForecastView from "./components/ForecastView";
import RemediesView from "./components/RemediesView";
import DoshasView from "./components/DoshasView";
import AccountBar from "./components/AccountBar";
import NotificationBell from "./components/NotificationBell";
import VargaHelp from "./components/VargaHelp";
import VargaReadingPanel from "./components/VargaReadingPanel";
import { DISPLAYED_VARGAS, VARGA_BY_CODE, Varga } from "./astro/varga";
import { AYANAMSAS, Ayanamsa } from "./astro/ayanamsa";
import { useLanguage } from "./i18n/LanguageProvider";
import { LANGUAGES } from "./i18n/languages";
import { useTranslation } from "./i18n/TranslationProvider";
import { useLlm } from "./llm/LlmProvider";
import { computeChart } from "./astro/engine";
import { BirthData, NodeType } from "./astro/types";
import { formatTz } from "./utils/format";

// The admin console is ~61KB of source behind a role check and its own page
// state — a handful of accounts will ever render it, so it should not be in the
// bundle every phone downloads. Same reasoning as the lessons drawer.
const AdminView = lazy(() => import("./components/AdminView"));

// Every destination that isn't the chart you land on. Each carries its own
// engine module — matchmaking, vastu, mentalHealth — and none of it is needed
// to render a kundli, which is what the overwhelming majority of visits do.
// One <Suspense> wraps the tab area rather than one per view, so switching tab
// shows a single line of text at worst.
const EventsTab = lazy(() => import("./components/EventsTab"));
const MatchView = lazy(() => import("./components/MatchView"));
const FriendshipView = lazy(() => import("./components/FriendshipView"));
const PartnershipView = lazy(() => import("./components/PartnershipView"));
const CareerView = lazy(() => import("./components/CareerView"));
const HealthView = lazy(() => import("./components/HealthView"));
const MentalHealthView = lazy(() => import("./components/MentalHealthView"));
const VastuView = lazy(() => import("./components/VastuView"));
const MuhurtaView = lazy(() => import("./components/MuhurtaView"));
const PoojaServicesView = lazy(() => import("./components/PoojaServicesView"));
const BillingView = lazy(() => import("./components/BillingView"));
const NotesView = lazy(() => import("./components/NotesView"));
const LearnView = lazy(() => import("./components/LearnView"));
const ConsultationView = lazy(() => import("./components/ConsultationView"));
const TempleAffiliationView = lazy(() => import("./components/TempleAffiliationView"));
const RemindersView = lazy(() => import("./components/RemindersView"));
const ContactView = lazy(() => import("./components/ContactView"));
const ExportReport = lazy(() => import("./components/ExportReport"));

type Page = "main" | "consult" | "admin" | "temple" | "reminders" | "contact";

type Tab =
  | "chart"
  | "predictions"
  | "dasha"
  | "events"
  | "transit"
  | "forecast"
  | "doshas"
  | "muhurta"
  | "remedies"
  | "match"
  | "friends"
  | "partners"
  | "career"
  | "health"
  | "mental"
  | "vastu"
  | "pooja"
  | "notes"
  | "billing"
  | "learn";

const TABS: { id: Tab; label: string; sub: string }[] = [
  { id: "chart", label: "Kundli", sub: "Chart & planets" },
  { id: "predictions", label: "Predictions", sub: "Grahas, bhavas, yogas" },
  { id: "dasha", label: "Dasha", sub: "Timing of events" },
  { id: "events", label: "Events", sub: "Milestones & your own" },
  { id: "transit", label: "Transit", sub: "Gochara & Sade Sati" },
  { id: "forecast", label: "Forecast", sub: "Daily & weekly" },
  { id: "doshas", label: "Doshas", sub: "Chart afflictions" },
  { id: "muhurta", label: "Muhurta", sub: "Auspicious days" },
  { id: "remedies", label: "Remedies", sub: "Upaya & justifications" },
  { id: "match", label: "Marriage Match", sub: "Ashtakoot compatibility" },
  { id: "friends", label: "Friendship Match", sub: "Mental & social rapport" },
  { id: "partners", label: "Partnership Match", sub: "Joint venture synergy" },
  { id: "career", label: "Career", sub: "Vocational guidance" },
  { id: "health", label: "Health", sub: "Wellness & remedies" },
  { id: "mental", label: "Mental Health", sub: "Mind & emotions" },
  { id: "vastu", label: "Vastu", sub: "Property suitability" },
  { id: "pooja", label: "Pooja Services", sub: "Temple rituals & events" },
  { id: "notes", label: "Notes", sub: "Private profile notes" },
  { id: "billing", label: "Plans & Billing", sub: "Manage subscription" },
  { id: "learn", label: "Learn", sub: "The theory" },
];

export default function App() {
  const [birth, setBirth] = useState<BirthData | null>(null);
  const [activeChartId, setActiveChartId] = useState<string | null>(null);
  const [tab, setTabNow] = useState<Tab>("chart");
  const [style, setStyle] = useState<"north" | "south">("north");
  const [mode, setMode] = useState<Varga>("D1");
  const [ayanamsa, setAyanamsa] = useState<Ayanamsa>("Lahiri");
  const [nodeType, setNodeType] = useState<NodeType>("mean");
  const [showExport, setShowExport] = useState(false);
  const [showVargaHelp, setShowVargaHelp] = useState(false);
  const { language, setLanguageCode } = useLanguage();
  const { enabled: llmEnabled } = useLlm();
  const translation = useTranslation();
  const { user, features, verificationToken, resendVerification } = useAuth();
  const isFree = (user?.plan ?? "free") === "free";
  const needsVerification = user && user.provider === "password" && !user.emailVerified;
  const [limitError, setLimitError] = useState<string | null>(null);
  const [resendMsg, setResendMsg] = useState<string | null>(null);
  const [limitPlan, setLimitPlan] = useState<string | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  // Chart settings are collapsed on phones (see .calc-settings-toggle); the
  // fields are always rendered, so this does nothing above 720px.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const tabsRef = useRef<HTMLElement | null>(null);
  // Top-level pages. These are chart-independent, reachable from the header
  // and/or the home page.
  const [page, setPageNow] = useState<Page>("main");
  // Initial mode for the (astrology-independent) temple portal.
  const [templeMode, setTempleMode] = useState<"login" | "register">("login");

  // Most destinations are lazy chunks (see the imports above). Switching to one
  // straight out of a click handler makes React suspend *synchronously*, which
  // it warns about and answers by tearing the whole boundary down to the
  // fallback — a visible flash of "Loading…" even when the chunk is cached.
  // Marking the navigation as a transition lets React keep the current view on
  // screen until the new one is ready.
  const setTab = useCallback((v: Tab | ((p: Tab) => Tab)) => {
    startTransition(() => setTabNow(v));
  }, []);
  const setPage = useCallback((v: Page | ((p: Page) => Page)) => {
    startTransition(() => setPageNow(v));
  }, []);

  const chart = useMemo(
    () => (birth ? computeChart(birth, { ayanamsa, nodeType }) : null),
    [birth, ayanamsa, nodeType],
  );

  // Tabs hidden by admin feature flags (Vastu, Pooja Services).
  const visibleTabs = useMemo(
    () => TABS.filter((t) => {
      if (t.id === "vastu") return features.vastu;
      if (t.id === "pooja") return features.temples;
      // Notes is a Pro/Premium feature — hidden for free users.
      if (t.id === "notes") return (features.notes ?? true) && !isFree;
      return true;
    }),
    [features, isFree],
  );

  // If the current tab gets disabled by a feature flag, fall back to Kundli.
  useEffect(() => {
    if (!visibleTabs.some((t) => t.id === tab)) setTab("chart");
  }, [visibleTabs, tab]);

  // On phones the tab row is a horizontal scroller, so a tab set from anywhere
  // other than a tap on it — loading a profile, a feature flag falling back to
  // Kundli, a lesson's "see this in your chart" link — can land off-screen.
  // Scrolls the strip only: scrollIntoView() would also move the page
  // vertically, fighting the sticky strip. No-op when nothing overflows.
  useEffect(() => {
    const nav = tabsRef.current;
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    const active = nav.querySelector<HTMLElement>(".tab.active");
    if (!active) return;
    const centred = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
    // Instant, not smooth: the strip is a scroll-snap container, and a snap
    // container cancels a smooth programmatic scroll and springs back to where
    // it was (measured — `behavior: "smooth"` left scrollLeft untouched while
    // the default landed and snapped correctly).
    nav.scrollTo({ left: Math.max(0, centred) });
  }, [tab]);

  // When the user signs out, drop the loaded chart so we return to the home
  // (landing) screen instead of staying on the tabbed reading view.
  useEffect(() => {
    if (!user) {
      setBirth(null);
      setActiveChartId(null);
      setTab("chart");
      setPage("main");
    }
  }, [user]);

  /** Check profile limit before casting a new chart. */
  const handleCastChart = useCallback(async (d: BirthData) => {
    setLimitError(null);
    setLimitPlan(null);
    try {
      const { charts, chartLimit, plan } = await api.listChartsWithLimit();
      if (charts.length >= chartLimit) {
        const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
        setLimitError(
          `Your ${planLabel} plan allows ${chartLimit} profile${chartLimit > 1 ? "s" : ""}. ` +
          `Upgrade to add more.`
        );
        setLimitPlan(plan === "free" ? "pro" : "premium");
        return;
      }
    } catch {
      // If the check fails (e.g. network), allow casting anyway
    }
    setBirth(d);
    setTab("chart");
  }, []);

  return (
    <div className="app" data-plan={user?.plan ?? "free"}>
      {/* Email verification banner */}
      {needsVerification && (
        <div className="verify-banner">
          <span>📧 Please verify your email to unlock all features.</span>
          {verificationToken && (
            <button className="link small" onClick={() => {
              const url = `${window.location.origin}/auth/verify-email?token=${verificationToken}`;
              navigator.clipboard.writeText(url);
              setResendMsg("Verification link copied!");
              setTimeout(() => setResendMsg(null), 3000);
            }}>Copy verification link</button>
          )}
          <button className="link small" onClick={async () => {
            try {
              await resendVerification();
              setResendMsg("New verification link generated!");
              setTimeout(() => setResendMsg(null), 3000);
            } catch (e: any) {
              setResendMsg(e.message ?? "Failed to resend");
              setTimeout(() => setResendMsg(null), 5000);
            }
          }}>Resend verification</button>
          {resendMsg && <span className="verify-msg">{resendMsg}</span>}
        </div>
      )}
      <header className="app-header">
        <div className="brand">
          <span className="logo">☸</span>
          <div>
            <h1>Aistrology</h1>
            <p className="tagline">Understand the sky. Align your space. Honour the ritual.</p>
          </div>
        </div>
        <div className="header-identity">
          {user && (
            <div className="id-block">
              <span className="id-label">Viewing profile</span>
              <ProfileSwitcher
                currentBirth={birth}
                activeChartId={activeChartId}
                onLoadChart={(b, id) => { setBirth(b); setActiveChartId(id); setTab("chart"); setPage("main"); }}
                onNewChart={() => { setBirth(null); setActiveChartId(null); setTab("chart"); setPage("main"); }}
                onProfileDeleted={(id) => { if (id === activeChartId) setActiveChartId(null); }}
              />
              {chart && (
                <div className="native-summary">
                  <span className="muted">
                    {String(chart.birth.day).padStart(2, "0")}/{String(chart.birth.month).padStart(2, "0")}/
                    {chart.birth.year} · {String(chart.birth.hour).padStart(2, "0")}:
                    {String(chart.birth.minute).padStart(2, "0")} · {chart.birth.placeLabel}
                    {" "}({formatTz(chart.birth.tzOffsetHours)})
                  </span>
                  <button className="link" onClick={() => setBirth(null)}>Edit ✎</button>
                </div>
              )}
            </div>
          )}
          <div className="id-block id-account">
            <span className="id-label">{user ? "Signed in as" : "Account"}</span>
            <div className="id-account-row">
              {user && <NotificationBell />}
              <AccountBar
                menuOpen={signInOpen}
                onMenuOpenChange={setSignInOpen}
              />
            </div>
          </div>
        </div>
        <div className="header-nav">
          {chart && (
            <button
              className="export-btn"
              onClick={() => setShowExport(true)}
              title={isFree ? "Preview export — upgrade to unlock the PDF" : "Export chart & predictions as PDF"}
            >
              ⬇ Export{isFree ? " 🔒" : ""}
            </button>
          )}
          {user && features.reminders && (
            <button
              className={`nav-consult-btn${page === "reminders" ? " active" : ""}`}
              onClick={() => setPage((p) => (p === "reminders" ? "main" : "reminders"))}
              title="Your reminders — rituals, anniversaries, festivals"
            >
              ⏰ Reminders
            </button>
          )}
          {user && features.consultation && (
            <button
              className={`nav-consult-btn${page === "consult" ? " active" : ""}`}
              onClick={() => setPage((p) => (p === "consult" ? "main" : "consult"))}
              title="Book a consultation, or offer your services"
            >
              🗓 Consultation
            </button>
          )}
          {/* The temple portal is reached from the "Temple Affiliation" section
              on the landing page, so it needs no header button. */}
          {user?.role === "admin" && (
            <button
              className={`nav-admin-btn${page === "admin" ? " active" : ""}`}
              onClick={() => setPage((p) => (p === "admin" ? "main" : "admin"))}
              title="Admin console"
            >
              🛡️ Admin
            </button>
          )}
        </div>
      </header>

      {page === "admin" && user?.role === "admin" ? (
        <main className="content admin-page">
          <Suspense fallback={<p className="muted">Loading the admin console…</p>}>
            <AdminView onExit={() => setPage("main")} />
          </Suspense>
        </main>
      ) : page === "consult" && features.consultation ? (
        <main className="content consult-page">
          <button className="link back-link" onClick={() => setPage("main")}>
            ← Back to {chart ? "chart" : "home"}
          </button>
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <ConsultationView />
          </Suspense>
        </main>
      ) : page === "temple" && features.temples ? (
        <main className="content temple-page">
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <TempleAffiliationView initialMode={templeMode} onExit={() => setPage("main")} />
          </Suspense>
        </main>
      ) : page === "reminders" && user && features.reminders ? (
        <main className="content reminders-page">
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <RemindersView onExit={() => setPage("main")} />
          </Suspense>
        </main>
      ) : page === "contact" ? (
        <main className="content contact-page">
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <ContactView onExit={() => setPage("main")} />
          </Suspense>
        </main>
      ) : !chart ? (
        <main className="landing">
          <section className="intro">
            <span className="intro-eyebrow">✦ Jyotisha · Vastu · Consultations · Temples · Learning</span>
            <h2>Cast your Janma Kundali</h2>
            <p>
              It starts with a birth date, time and place. Aistrology computes a precise sidereal
              (Nirayana) chart using the Lahiri ayanamsa and explains what it means — then keeps
              going: ask questions about your own chart, book a session with an astrologer or
              priest, check a home with Vastu, find auspicious days, keep your rituals and
              festivals on time, and reach temples for pooja services. Every reading shows its
              reasoning, and built-in lessons teach the theory as you go.
            </p>
            <ul className="feature-bullets">
              <li><span className="bullet-icon">🪐</span><span>Precise sidereal charts — North &amp; South Indian styles, D1–D12 vargas</span></li>
              <li><span className="bullet-icon">🗓️</span><span>Dasha timeline, doshas, yogas and Muhurta — auspicious days for what matters</span></li>
              <li><span className="bullet-icon">🏠</span><span>Vastu — check a home or plot against classical rules, matched to your chart</span></li>
              <li><span className="bullet-icon">💬</span><span>Astro Chat — ask about your own chart, answered from its real placements</span></li>
              <li><span className="bullet-icon">🧑‍🏫</span><span>Consultations — one-on-one sessions with approved astrologers and priests</span></li>
              <li><span className="bullet-icon">🛕</span><span>Temples &amp; pooja services, plus reminders for your rituals and festivals</span></li>
              <li><span className="bullet-icon">📖</span><span>Built-in lessons — astrology and Vastu, with step-by-step worked examples</span></li>
            </ul>
          </section>
          <section className="form-panel">
            <svg className="hero-decor" viewBox="0 0 400 400" aria-hidden="true" focusable="false">
              <g className="hd-rings">
                <circle cx="200" cy="200" r="192" />
                <circle cx="200" cy="200" r="152" />
                <circle cx="200" cy="200" r="110" />
                <circle cx="200" cy="200" r="64" />
              </g>
              <g className="hd-spokes">
                {Array.from({ length: 12 }).map((_, i) => (
                  <g key={i} transform={`rotate(${i * 30} 200 200)`}>
                    <line x1="200" y1="8" x2="200" y2="64" />
                    <circle cx="200" cy="8" r="3.5" />
                  </g>
                ))}
              </g>
              <g className="hd-core">
                <rect x="130" y="130" width="140" height="140" transform="rotate(45 200 200)" />
                <circle cx="200" cy="200" r="28" />
              </g>
            </svg>
            {user ? (
              <>
                <h2>Birth details</h2>
                <BirthForm onSubmit={handleCastChart} />
                {limitError && (
                  <div className="limit-error">
                    <p className="error">{limitError}</p>
                    {limitPlan && (
                      <button
                        className={`btn-plan-upgrade${limitPlan === "premium" ? " premium" : ""}`}
                        style={{ marginTop: 8, maxWidth: 260 }}
                        onClick={async () => {
                          try {
                            const { url } = await api.createCheckout(limitPlan as "pro" | "premium");
                            if (url) window.location.href = url;
                          } catch {}
                        }}
                      >
                        Upgrade to {limitPlan.charAt(0).toUpperCase() + limitPlan.slice(1)}
                      </button>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="sign-in-prompt">
                <div className="sign-in-prompt-icon">🔐</div>
                <h2>Sign in to get started</h2>
                <p>Create a free account to cast your chart, check a home with Vastu, find auspicious days, and follow the lessons.</p>
                <button className="sign-in-cta" onClick={() => setSignInOpen(true)}>
                  Sign in — it's free
                </button>
                <p className="muted small">No credit card needed. A local dev profile works too.</p>
              </div>
            )}
          </section>

          {/* Marketing sections — pricing, temple affiliation and the long-form
              article are for first-time visitors. Once signed in they're noise:
              plans live in the Plans & Billing tab and the temple portal is
              reachable from there, so we hide them for authenticated users. */}
          {!user && (
          <>
          {/* Pricing Plans */}
          <section className="landing-pricing">
            <span className="section-eyebrow">Simple pricing</span>
            <h2>Plans</h2>
            <p className="landing-pricing-sub">All features included on every plan. Plans differ by number of profiles and access to AI tools.</p>
            <div className="billing-plans">
              <div className="billing-plan-card">
                <h3>Free</h3>
                <div className="billing-price">
                  <span className="billing-price-num">₹0</span>
                </div>
                <ul className="billing-features">
                  <li><span className="billing-check">✓</span>1 Profile</li>
                  <li><span className="billing-check">✓</span>All analysis sections</li>
                  <li className="billing-limitation"><span className="billing-cross">✗</span>No Justify / Translate / Export</li>
                </ul>
              </div>
              <div className="billing-plan-card">
                <h3>Pro</h3>
                <div className="billing-price">
                  <span className="billing-price-num">₹499</span>
                  <span className="billing-price-period">/mo</span>
                  <span className="billing-price-usd"> · ~$6/mo</span>
                </div>
                <ul className="billing-features">
                  <li><span className="billing-check">✓</span>2 Profiles</li>
                  <li><span className="billing-check">✓</span>All analysis sections</li>
                  <li><span className="billing-check">✓</span>AI Justify & Translate</li>
                  <li><span className="billing-check">✓</span>Export PDF reports</li>
                </ul>
              </div>
              <div className="billing-plan-card highlight">
                <div className="billing-badge popular">Best Value</div>
                <h3>Premium</h3>
                <div className="billing-price">
                  <span className="billing-price-num">₹999</span>
                  <span className="billing-price-period">/mo</span>
                  <span className="billing-price-usd"> · ~$12/mo</span>
                </div>
                <ul className="billing-features">
                  <li><span className="billing-check">✓</span>10 Profiles</li>
                  <li><span className="billing-check">✓</span>All analysis sections</li>
                  <li><span className="billing-check">✓</span>AI Justify & Translate</li>
                  <li><span className="billing-check">✓</span>Export PDF reports</li>
                  <li><span className="billing-check">✓</span>Ideal for professionals</li>
                </ul>
              </div>
            </div>
          </section>

          {/* Temple Affiliation */}
          {features.temples && (
          <section className="landing-temple">
            <span className="section-eyebrow">Temple Affiliation</span>
            <h2>🛕 Register Your Temple</h2>
            <p className="landing-temple-sub">
              Are you a temple official? Register your temple on Aistrology to reach devotees.
              List your pooja services, maintain an event calendar, and connect with your community.
            </p>
            <div className="landing-temple-features">
              <div className="landing-temple-feat">
                <span className="landing-temple-icon">🪔</span>
                <h4>Pooja Services</h4>
                <p>List archanas, abhishekams, homams, and other rituals with pricing.</p>
              </div>
              <div className="landing-temple-feat">
                <span className="landing-temple-icon">📅</span>
                <h4>Event Calendar</h4>
                <p>Publish festivals, special poojas, and recurring events.</p>
              </div>
              <div className="landing-temple-feat">
                <span className="landing-temple-icon">🙏</span>
                <h4>Reach Devotees</h4>
                <p>Users browse your temple profile, services, and upcoming events.</p>
              </div>
            </div>
            <div className="landing-temple-cta">
              <button
                className="temple-cta-btn"
                onClick={() => { setTempleMode("register"); setPage("temple"); }}
              >
                🛕 Register Your Temple
              </button>
              <button
                className="temple-cta-btn ghost"
                onClick={() => { setTempleMode("login"); setPage("temple"); }}
              >
                Temple Login
              </button>
            </div>
            <p className="muted small landing-temple-note">
              Temples use their own credentials — no astrology account needed.
            </p>
          </section>
          )}

          {/* Long-form article: the app's philosophy on astrology */}
          <article className="landing-article">
            <p className="article-eyebrow">Our perspective</p>
            <h2 className="article-title">Decoding the Patterns: Rethinking Our Relationship with Astrology</h2>

            <section className="article-section">
              <h3><span className="article-num">1</span>Nature's Sacred Rhythm: Patterns and Cycles</h3>
              <p>
                Look closely at the world around you, and you'll notice that nature rarely moves in
                straight lines. Everything operates in cycles. Oceans rise and fall with the moon;
                trees shed their leaves in autumn only to bloom in spring; seasons shift with
                predictable precision, and day seamlessly yields to night. From the microscopic
                spiral of a seashell to the rotation of distant galaxies, nature is fundamentally
                built on geometry, rhythms, and repeating patterns.
              </p>
              <p>
                Humans have always sought to make sense of these rhythms to bring order to a complex
                world. We track time, predict weather, and map seasons precisely because we
                recognize that nature repeats itself.
              </p>
              <div className="article-flow" aria-label="From nature's cycles to self-reflection">
                <div className="flow-node">🪐 Planetary Motions &amp; Seasons</div>
                <div className="flow-arrow" aria-hidden="true">↓</div>
                <div className="flow-node">🔭 Observation &amp; Ancient Literature</div>
                <div className="flow-arrow" aria-hidden="true">↓</div>
                <div className="flow-node">📜 Astrological Frameworks</div>
                <div className="flow-arrow" aria-hidden="true">↓</div>
                <div className="flow-node">🧭 Self-Reflection &amp; Navigation</div>
              </div>
            </section>

            <section className="article-section">
              <h3><span className="article-num">2</span>Astrology as Ancient Pattern Recognition</h3>
              <p>
                Long before modern instruments existed, ancient observers looked up at the night sky
                and noticed a direct correlation between celestial movements and terrestrial events.
                Over thousands of years, civilizations across the globe compiled meticulous
                observations into what we now recognize as astrological literature.
              </p>
              <p>
                At its core, astrology is not magic; it is an ancient system of pattern recognition.
                It was humanity's early attempt to map macro-cosmic movements to micro-cosmic human
                experiences, using the stars as a clockface for the subtle energies running through
                nature.
              </p>
            </section>

            <section className="article-section">
              <h3><span className="article-num">3</span>The Interplay: Destiny vs. Free Will</h3>
              <p>
                One of the oldest philosophical debates centers on whether our path is predetermined
                or shaped by choice. In reality, human life operates at the intersection of destiny
                and free will. Think of life like playing a hand of cards:
              </p>
              <div className="article-cards">
                <div className="article-card">
                  <span className="article-card-tag">🂠 Destiny — the deck</span>
                  <p>
                    The circumstances of your birth, your raw innate tendencies, and the broader
                    external cycles you encounter — the cards you are dealt.
                  </p>
                </div>
                <div className="article-card">
                  <span className="article-card-tag">🎴 Free will — how you play</span>
                  <p>
                    Your choices, self-awareness, character, and actions — how you choose to play
                    that hand.
                  </p>
                </div>
              </div>
              <p>
                Astrology offers a lens to view the timing and nature of the weather outside, but you
                choose whether to build a shelter, jump in the rain, or wait for the storm to pass.
              </p>
            </section>

            <section className="article-section">
              <h3><span className="article-num">4</span>The Pitfall: Overprioritizing Astrological Predictions</h3>
              <p>
                Across the globe, it is common for people to swing to an extreme — overprioritizing
                astrology in their everyday decision-making. When people rely blindly on horoscopes
                to choose partners, make financial investments, or avoid taking personal initiative,
                astrology ceases to be a tool for self-discovery and becomes an anchor of anxiety.
              </p>
              <p>
                Surrendering personal agency to any predictive system — astrological or otherwise —
                can lead to decision paralysis and a loss of personal responsibility.
              </p>
            </section>

            <section className="article-section">
              <h3><span className="article-num">5</span>A Healthier Approach: Embracing Pattern over Determinism</h3>
              <p>
                The true utility of reading astrology lies in recognizing patterns and making peace
                with ambiguity, rather than overthinking fixed outcomes or obsessing over destiny.
              </p>
              <blockquote className="article-quote">
                Instead of asking, "What will happen to me today?" a healthier perspective asks,
                "What kind of environment am I navigating, and how can I best cultivate my awareness?"
              </blockquote>
              <p>
                When approached with curiosity rather than fear, studying these ancient frameworks
                helps us embrace life's inherent uncertainty with grace and balance.
              </p>
            </section>

            <section className="article-section">
              <h3><span className="article-num">6</span>A Misunderstood Legacy: Ancient Wisdom in Modern Times</h3>
              <p>
                Much of modern popular astrology has been reduced to surface-level daily horoscopes,
                sensationalized predictions, and rigid dogmatism. In truth, astrology is largely a
                wrongly understood, frequently misinterpreted, and heavily opinionated body of
                ancient knowledge.
              </p>
              <p>
                When stripped of commercialized hype, opinionated clutter, and dogmatic fearmongering,
                astrological literature can be appreciated for what it originally was: an intriguing
                historical attempt to decode nature's grand design.
              </p>
            </section>

            <aside className="article-disclaimer">
              <strong>Disclaimer</strong>
              <p>
                <em>Educational &amp; curiosity-based learning only.</em> The content provided on this
                site is intended solely for educational, historical, and curiosity-based exploration
                of natural patterns and ancient frameworks. It is not professional, financial,
                medical, psychological, or legal advice.
              </p>
              <p>
                We do not encourage or endorse making personal, life, or financial decisions based on
                astrological readings. Users are fully responsible for their own actions and choices.
                This platform assumes no legal responsibility or liability for any interpretations,
                actions, or decisions made based on this material. All content is shared purely for
                experimental research and general learning.
              </p>
            </aside>
          </article>
          </>
          )}
        </main>
      ) : (
        <>
          <nav className="tabs" ref={tabsRef}>
            {visibleTabs.map((t) => (
              <button
                key={t.id}
                className={tab === t.id ? "tab active" : "tab"}
                onClick={() => setTab(t.id)}
              >
                <span className="tab-label">{t.label}</span>
                <span className="tab-sub">{t.sub}</span>
              </button>
            ))}
          </nav>

          <div className={`calc-settings${settingsOpen ? " open" : ""}`}>
            {/* Phone-only (CSS hides it above 720px) — the fields below are
                always rendered, so nothing here changes on desktop. */}
            <button
              type="button"
              className="calc-settings-toggle"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((v) => !v)}
            >
              <span>⚙ Chart settings</span>
              <span className="cst-values muted">
                {AYANAMSAS.find((a) => a.code === ayanamsa)?.name ?? ayanamsa}
                {" · "}{nodeType === "mean" ? "Mean node" : "True node"}
                {" · "}{language.native}
              </span>
              <span className="cst-caret muted">▾</span>
            </button>
            <label>
              <span className="muted">Ayanamsa</span>
              <select
                value={ayanamsa}
                onChange={(e) => setAyanamsa(e.target.value as Ayanamsa)}
              >
                {AYANAMSAS.map((a) => (
                  <option key={a.code} value={a.code} title={a.note}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="muted">Lunar node</span>
              <select
                value={nodeType}
                onChange={(e) => setNodeType(e.target.value as NodeType)}
              >
                <option value="mean">Mean (Rahu/Ketu)</option>
                <option value="true">True (osculating)</option>
              </select>
            </label>
            <label>
              <span className="muted">Language</span>
              <select
                value={language.code}
                onChange={(e) => setLanguageCode(e.target.value)}
                title="AI justifications and translations render in this language"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.native}
                    {l.code !== "en" ? ` · ${l.english}` : ""}
                  </option>
                ))}
              </select>
            </label>
            {translation.available && !isFree && (
              <button className="translate-btn" onClick={translation.toggle} disabled={translation.translating}>
                {translation.translating
                  ? "Translating…"
                  : translation.active
                    ? "Show English"
                    : `🌐 Translate to ${language.native}`}
              </button>
            )}
            <span className="calc-note muted small">
              {translation.error
                ? <span style={{ color: "#ef4444" }}>Translation error: {translation.error}. Try re-entering your API key in AI settings.</span>
                : translation.active && translation.demoBlocked
                ? "The demo engine can't translate — add an OpenAI/Claude/Gemini key in AI settings."
                : language.code !== "en" && !llmEnabled
                  ? "Set an AI engine (AI settings) to translate into " + language.native + "."
                  : "Applies to every tab — positions, dasha and transits recompute."}
            </span>
          </div>

          <main className="content">
            <Suspense fallback={<p className="muted">Loading…</p>}>
            {tab === "chart" && (
              <div className="chart-tab">
                <div className="chart-controls">
                  <div className="toggle">
                    <button className={style === "north" ? "on" : ""} onClick={() => setStyle("north")}>North Indian</button>
                    <button className={style === "south" ? "on" : ""} onClick={() => setStyle("south")}>South Indian</button>
                  </div>
                  <div className="toggle varga-toggle">
                    {DISPLAYED_VARGAS.map((v) => (
                      <button
                        key={v.code}
                        className={mode === v.code ? "on" : ""}
                        onClick={() => setMode(v.code)}
                        title={v.signifies}
                      >
                        {v.code}
                      </button>
                    ))}
                  </div>
                  <button
                    className={`help-toggle ${showVargaHelp ? "on" : ""}`}
                    onClick={() => setShowVargaHelp((s) => !s)}
                    title="What do the D-charts mean?"
                  >
                    {showVargaHelp ? "Hide help" : "ⓘ What are D1–D12?"}
                  </button>
                </div>
                {showVargaHelp && <VargaHelp current={mode} onPick={setMode} />}
                <div className="chart-layout">
                  <div className="chart-holder">
                    {style === "north" ? (
                      <NorthChart chart={chart} mode={mode} />
                    ) : (
                      <SouthChart chart={chart} mode={mode} />
                    )}
                    {style === "north" && <SignLegend />}
                    <p className="chart-caption muted">
                      <strong>{VARGA_BY_CODE[mode].label}</strong> —{" "}
                      {VARGA_BY_CODE[mode].signifies}.
                      {" "}Numbers are signs (1 = Aries … 12 = Pisces). ↺ marks retrograde.
                    </p>
                  </div>
                  <div className="table-holder">
                    <PlanetTable chart={chart} />
                  </div>
                </div>
                <VargaReadingPanel chart={chart} varga={mode} />
              </div>
            )}
            {tab === "predictions" && (
              <Predictions
                chart={chart}
                onOpenVarga={(v) => { setMode(v); setTab("chart"); }}
              />
            )}
            {tab === "dasha" && <DashaView chart={chart} />}
            {tab === "events" && <EventsTab chart={chart} chartId={activeChartId} />}
            {tab === "transit" && <TransitView chart={chart} />}
            {tab === "forecast" && <ForecastView chart={chart} />}
            {tab === "doshas" && <DoshasView chart={chart} />}
            {tab === "muhurta" && <MuhurtaView />}
            {tab === "remedies" && <RemediesView chart={chart} />}
            {tab === "match" && (
              <MatchView
                currentChart={chart}
                chartOptions={{ ayanamsa, nodeType }}
                style={style}
              />
            )}
            {tab === "friends" && (
              <FriendshipView
                currentChart={chart}
                chartOptions={{ ayanamsa, nodeType }}
                style={style}
              />
            )}
            {tab === "partners" && (
              <PartnershipView
                currentChart={chart}
                chartOptions={{ ayanamsa, nodeType }}
                style={style}
              />
            )}
            {tab === "career" && (
              <CareerView
                currentChart={chart}
                chartOptions={{ ayanamsa, nodeType }}
                style={style}
              />
            )}
            {tab === "health" && (
              <HealthView
                currentChart={chart}
                chartOptions={{ ayanamsa, nodeType }}
                style={style}
              />
            )}
            {tab === "mental" && (
              <MentalHealthView
                currentChart={chart}
                chartOptions={{ ayanamsa, nodeType }}
                style={style}
              />
            )}
            {tab === "vastu" && features.vastu && (
              <VastuView
                currentChart={chart}
                chartOptions={{ ayanamsa, nodeType }}
                style={style}
                chartId={activeChartId}
              />
            )}
            {tab === "billing" && <BillingView />}
            {tab === "pooja" && features.temples && <PoojaServicesView />}
            {tab === "notes" && <NotesView chart={chart} chartId={activeChartId} />}
            {tab === "learn" && <LearnView />}

            {/* One widget covers every module — the active tab is the feature key.
                Signed-in only: the endpoint requires auth, so a guest would just
                hit a 401 after taking the trouble to write a comment. */}
            </Suspense>

            {user && <FeatureFeedback feature={tab} label={TABS.find((t) => t.id === tab)?.label} />}
          </main>
        </>
      )}

      <footer className="app-footer">
        <p className="muted">
          Aistrology computes sidereal positions with the Lahiri ayanamsa and whole-sign houses.
          Interpretations follow classical Jyotisha and are offered for learning and reflection —
          not as medical, legal, financial or psychological advice.
        </p>
        <p className="app-footer-links">
          <button className="link" onClick={() => setPage("contact")}>✉️ Contact us</button>
        </p>
      </footer>

      {/* Mounted only while open — it renders null when closed anyway, and
          gating the mount is what keeps its chunk off the critical path. */}
      {chart && showExport && (
        <Suspense fallback={null}>
          <ExportReport
            chart={chart}
            open={showExport}
            onClose={() => setShowExport(false)}
            style={style}
            mode={mode}
            locked={isFree}
          />
        </Suspense>
      )}

      {page === "main" && (
        <ChatPanel chart={chart} chartId={activeChartId} moduleLabel={TABS.find((t) => t.id === tab)?.label} />
      )}

      {page === "main" && (
        <LessonsDrawer
          hasChart={!!chart}
          onGoToTab={(t) => { setTab(t as Tab); setPage("main"); }}
        />
      )}
    </div>
  );
}
