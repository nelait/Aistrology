import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import {
  api,
  AdminUser,
  AdminOffer,
  AdminOverview,
  AdminUsageStats,
  AdminUserUsage,
  LlmSettings,
  LlmProviderId,
  ActiveProvider,
  Temple,
  FeatureFlags,
  FeatureMeta,
  AdminFestival,
  AdminPromoCode,
  AdminContactMessage,
  AdminBillingEvent,
  AdminQuotas,
  PlanLimits,
  CONTACT_CATEGORIES,
} from "../api/client";

export default function AdminView({ onExit }: { onExit: () => void }) {
  const { user, isAdmin } = useAuth();
  if (!isAdmin) return <AdminGate defaultEmail={user?.email ?? ""} onExit={onExit} />;
  return <AdminDashboard onExit={onExit} />;
}

/* -------------------- Admin sign-in gate -------------------- */

function AdminGate({ defaultEmail, onExit }: { defaultEmail: string; onExit: () => void }) {
  const { adminLogin } = useAuth();
  const [email, setEmail] = useState(defaultEmail);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await adminLogin(email.trim(), password, code.trim());
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-gate">
      <div className="admin-gate-card">
        <div className="admin-gate-icon">🛡️</div>
        <h2>Admin sign-in</h2>
        <p className="muted small">
          The admin area requires an extra access code in addition to your password.
        </p>
        <form className="admin-form" onSubmit={submit}>
          <label>
            Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="off" required />
          </label>
          <label>
            Password
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="off" required />
          </label>
          <label>
            Access code
            <input value={code} onChange={(e) => setCode(e.target.value)} type="password" autoComplete="off" required />
          </label>
          {err && <p className="error small">{err}</p>}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Verifying…" : "Enter admin console"}
          </button>
        </form>
        <button className="back-link" onClick={onExit}>← Back to app</button>
      </div>
    </div>
  );
}

/* -------------------- Dashboard shell -------------------- */

type Section = "overview" | "usage" | "limits" | "users" | "approvals" | "temples" | "reminders" | "promos" | "contact" | "billing" | "notify" | "llm" | "features";
const SECTIONS: [Section, string][] = [
  ["overview", "Overview"],
  ["usage", "Usage & Limits"],
  ["limits", "Plan Limits"],
  ["users", "Users"],
  ["approvals", "Approvals"],
  ["temples", "Temples"],
  ["reminders", "Reminders"],
  ["promos", "Promo Codes"],
  ["contact", "Contact"],
  ["billing", "Billing"],
  ["notify", "Notifications"],
  ["llm", "AI / LLM"],
  ["features", "Features"],
];

function AdminDashboard({ onExit }: { onExit: () => void }) {
  const [section, setSection] = useState<Section>("overview");
  return (
    <div className="admin">
      <div className="admin-head">
        <div>
          <h2>🛡️ Admin console</h2>
          <p className="muted small">Manage users, approvals, notifications and the shared AI configuration.</p>
        </div>
        <button className="back-link" onClick={onExit}>← Back to app</button>
      </div>
      <nav className="admin-nav">
        {SECTIONS.map(([id, label]) => (
          <button key={id} className={section === id ? "on" : ""} onClick={() => setSection(id)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="admin-body">
        {section === "overview" && <OverviewSection />}
        {section === "usage" && <UsageSection />}
        {section === "limits" && <LimitsSection />}
        {section === "users" && <UsersSection />}
        {section === "approvals" && <ApprovalsSection />}
        {section === "temples" && <TemplesSection />}
        {section === "reminders" && <RemindersAdminSection />}
        {section === "promos" && <PromosSection />}
        {section === "contact" && <ContactAdminSection />}
        {section === "billing" && <BillingEventsSection />}
        {section === "notify" && <NotifySection />}
        {section === "llm" && <LlmSection />}
        {section === "features" && <FeaturesSection />}
      </div>
    </div>
  );
}

/* -------------------- Overview -------------------- */

function OverviewSection() {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.getAdminOverview().then(setData).catch((e) => setErr(e.message));
  }, []);
  if (err) return <p className="error">{err}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const cards = [
    { label: "Total users", value: data.users, icon: "👥" },
    { label: "Admins", value: data.admins, icon: "🛡️" },
    { label: "Provider offers", value: data.offers, icon: "🗂" },
    { label: "Pending approval", value: data.pendingOffers, icon: "⏳" },
  ];
  return (
    <div className="admin-stats">
      {cards.map((c) => (
        <div className="admin-stat" key={c.label}>
          <span className="admin-stat-icon">{c.icon}</span>
          <span className="admin-stat-num">{c.value}</span>
          <span className="admin-stat-label">{c.label}</span>
        </div>
      ))}
    </div>
  );
}

/* -------------------- Usage & Limits -------------------- */

function UsageSection() {
  const [data, setData] = useState<AdminUsageStats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [drillUserId, setDrillUserId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.getAdminUsage()
      .then(setData)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  if (err) return <p className="error">{err}</p>;
  if (!data || loading) return <p className="muted">Loading usage data…</p>;

  const plans = ["free", "pro", "premium"];
  const totalUsers = plans.reduce((s, p) => s + (data.planDistribution[p] ?? 0), 0);

  return (
    <div className="admin-usage">
      <div className="admin-usage-header">
        <h3>Usage & Rate Limits</h3>
        <button className="link small" onClick={load}>↻ Refresh</button>
      </div>

      {/* Plan Distribution */}
      <div className="usage-group">
        <h4>📊 Plan Distribution</h4>
        <div className="usage-bar-chart">
          {plans.map((p) => {
            const count = data.planDistribution[p] ?? 0;
            const pct = totalUsers > 0 ? Math.round((count / totalUsers) * 100) : 0;
            return (
              <div key={p} className="usage-bar-row">
                <span className="usage-bar-label">{p.charAt(0).toUpperCase() + p.slice(1)}</span>
                <div className="usage-bar-track">
                  <div className={`usage-bar-fill plan-${p}`} style={{ width: `${Math.max(pct, 2)}%` }} />
                </div>
                <span className="usage-bar-value">{count} ({pct}%)</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Quick Stats */}
      <div className="usage-group">
        <h4>📈 Quick Stats</h4>
        <div className="admin-stats">
          <div className="admin-stat">
            <span className="admin-stat-icon">📋</span>
            <span className="admin-stat-num">{data.charts.activeTotal}</span>
            <span className="admin-stat-label">Active charts</span>
          </div>
          <div className="admin-stat">
            <span className="admin-stat-icon">♻️</span>
            <span className="admin-stat-num">{data.charts.lifetimeTotal}</span>
            <span className="admin-stat-label">Lifetime created</span>
          </div>
          <div className="admin-stat">
            <span className="admin-stat-icon">🆕</span>
            <span className="admin-stat-num">{data.signups.last7d}</span>
            <span className="admin-stat-label">Signups (7d)</span>
          </div>
          <div className="admin-stat">
            <span className="admin-stat-icon">📅</span>
            <span className="admin-stat-num">{data.signups.last30d}</span>
            <span className="admin-stat-label">Signups (30d)</span>
          </div>
        </div>
      </div>

      {/* Charts per Plan */}
      <div className="usage-group">
        <h4>📂 Active Charts by Plan</h4>
        <table className="admin-table">
          <thead><tr><th>Plan</th><th>Active Charts</th></tr></thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p}>
                <td>{p.charAt(0).toUpperCase() + p.slice(1)}</td>
                <td>{data.charts.byPlan[p] ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Rate Limit State */}
      <div className="usage-group">
        <h4>⚡ Rate Limiter (in-memory)</h4>
        <div className="admin-stats">
          <div className="admin-stat">
            <span className="admin-stat-icon">🪣</span>
            <span className="admin-stat-num">{data.rateLimit.rateBuckets}</span>
            <span className="admin-stat-label">Active buckets</span>
          </div>
          <div className="admin-stat">
            <span className="admin-stat-icon">📊</span>
            <span className="admin-stat-num">{data.rateLimit.dailyCounters}</span>
            <span className="admin-stat-label">Daily counters</span>
          </div>
          <div className="admin-stat">
            <span className="admin-stat-icon">💾</span>
            <span className="admin-stat-num">{data.rateLimit.llmCacheEntries} / {data.rateLimit.llmCacheMaxEntries}</span>
            <span className="admin-stat-label">LLM cache</span>
          </div>
        </div>
      </div>

      {/* Top Daily Users */}
      {data.rateLimit.topDailyUsers.length > 0 && (
        <div className="usage-group">
          <h4>🔥 Top Usage Today</h4>
          <table className="admin-table">
            <thead><tr><th>User</th><th>Feature</th><th>Count</th><th></th></tr></thead>
            <tbody>
              {data.rateLimit.topDailyUsers.map((u, i) => (
                <tr key={i}>
                  <td>
                    <strong>{u.userName}</strong>
                    <span className="muted small block">{u.userId.slice(0, 12)}…</span>
                  </td>
                  <td>{u.feature}</td>
                  <td>{u.count}</td>
                  <td>
                    <button className="link small" onClick={() => setDrillUserId(u.userId)}>
                      Details →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-user drill-down panel */}
      {drillUserId && (
        <UserUsageDrillDown userId={drillUserId} onClose={() => setDrillUserId(null)} />
      )}
    </div>
  );
}

/* ---- Editable per-plan daily quotas ---- */

function LimitsSection() {
  const [meta, setMeta] = useState<AdminQuotas | null>(null);
  const [draft, setDraft] = useState<PlanLimits>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = () => api.getAdminQuotas()
    .then((q) => { setMeta(q); setDraft(structuredClone(q.limits)); })
    .catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <p className="error">{err}</p>;
  if (!meta) return <p className="muted">Loading limits…</p>;

  const setCell = (plan: string, feature: string, value: string) => {
    setSaved(false);
    const n = Math.max(0, Math.floor(Number(value) || 0));
    setDraft((d) => ({ ...d, [plan]: { ...d[plan], [feature]: n } }));
  };

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const limits = await api.setAdminQuotas(draft);
      setDraft(structuredClone(limits));
      setMeta({ ...meta, limits });
      setSaved(true);
    } catch (e) { setErr(e instanceof Error ? e.message : "Save failed"); }
    finally { setBusy(false); }
  };

  const reset = async () => {
    setBusy(true); setErr(null);
    try {
      const limits = await api.resetAdminQuotas();
      setDraft(structuredClone(limits));
      setMeta({ ...meta, limits });
      setSaved(true);
    } catch (e) { setErr(e instanceof Error ? e.message : "Reset failed"); }
    finally { setBusy(false); }
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(meta.limits);

  return (
    <div className="admin-section">
      <div className="admin-usage-header">
        <h3>Plan Limits — daily quotas</h3>
      </div>
      <p className="muted small">
        Maximum uses per user per day for each AI/action feature, by plan. Resets at
        UTC midnight. <strong>0 = blocked</strong> for that plan. Changes take effect
        immediately (no restart). See <em>Usage &amp; Limits</em> for live usage.
      </p>

      <div className="table-scroll">
        <table className="admin-table limits-table">
          <thead>
            <tr>
              <th>Feature</th>
              {meta.plans.map((p) => <th key={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</th>)}
            </tr>
          </thead>
          <tbody>
            {meta.features.map((f) => (
              <tr key={f.key}>
                <td>{f.label} <span className="muted small">({f.key})</span></td>
                {meta.plans.map((p) => (
                  <td key={p}>
                    <input
                      type="number" min={0} className="limit-input"
                      value={draft[p]?.[f.key] ?? 0}
                      onChange={(e) => setCell(p, f.key, e.target.value)}
                    />
                    {draft[p]?.[f.key] !== meta.defaults[p]?.[f.key] && (
                      <span className="muted small" title="Code default"> (def {meta.defaults[p]?.[f.key]})</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="request-btns">
        <button className="primary" onClick={save} disabled={busy || !dirty}>
          {busy ? "Saving…" : "Save limits"}
        </button>
        <button className="mini-btn" onClick={reset} disabled={busy}>Reset to defaults</button>
        {saved && !dirty && <span className="muted small">✓ Saved</span>}
      </div>
    </div>
  );
}

/* ---- Per-user usage drill-down component ---- */

function UserUsageDrillDown({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [data, setData] = useState<AdminUserUsage | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setErr(null);
    api.getUserUsage(userId).then(setData).catch((e) => setErr(e.message));
  }, [userId]);

  return (
    <div className="usage-group usage-drilldown">
      <div className="admin-usage-header">
        <h4>👤 User Details</h4>
        <button className="link small" onClick={onClose}>✕ Close</button>
      </div>
      {err && <p className="error small">{err}</p>}
      {!data && !err && <p className="muted">Loading…</p>}
      {data && (
        <>
          {/* Identity */}
          <div className="drilldown-identity">
            <div><strong>{data.name ?? "—"}</strong></div>
            <div className="muted small">{data.email ?? "No email"}</div>
            <div className="drilldown-badges">
              <span className={`badge plan-${data.plan}`}>{data.plan}</span>
              {data.emailVerified
                ? <span className="badge badge-ok">✓ Verified</span>
                : <span className="badge badge-warn">✗ Unverified</span>
              }
            </div>
          </div>

          {/* Usage stats */}
          <div className="admin-stats" style={{ marginTop: 12 }}>
            <div className="admin-stat">
              <span className="admin-stat-icon">📋</span>
              <span className="admin-stat-num">{data.activeCharts}</span>
              <span className="admin-stat-label">Active charts</span>
            </div>
            <div className="admin-stat">
              <span className="admin-stat-icon">♻️</span>
              <span className="admin-stat-num">{data.totalChartsCreated}</span>
              <span className="admin-stat-label">Lifetime created</span>
            </div>
          </div>

          {/* Daily usage breakdown */}
          {Object.keys(data.dailyUsage).length > 0 && (
            <div style={{ marginTop: 14 }}>
              <h5 style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 700 }}>Today's API Usage</h5>
              <table className="admin-table">
                <thead><tr><th>Feature</th><th>Calls</th></tr></thead>
                <tbody>
                  {Object.entries(data.dailyUsage).map(([feat, count]) => (
                    <tr key={feat}><td>{feat}</td><td>{count}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Charts list */}
          {data.charts.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <h5 style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 700 }}>
                Saved Charts ({data.charts.length})
              </h5>
              <table className="admin-table">
                <thead><tr><th>Label</th><th>Created</th><th>Updated</th></tr></thead>
                <tbody>
                  {data.charts.map((c) => (
                    <tr key={c.id}>
                      <td>{c.label}</td>
                      <td className="muted small">{new Date(c.createdAt).toLocaleDateString()}</td>
                      <td className="muted small">{new Date(c.updatedAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function UsersSection() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = () => api.getAdminUsers().then(setUsers).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const patch = async (id: string, p: { plan?: string; role?: string; suspended?: boolean }) => {
    setBusyId(id);
    setErr(null);
    try {
      const updated = await api.updateAdminUser(id, p);
      setUsers((us) => us.map((u) => (u.id === id ? updated : u)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="admin-section">
      <CreateUserForm onCreated={load} />
      {err && <p className="error small">{err}</p>}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Plan</th>
              <th>Charts</th>
              <th>Verified</th>
              <th>Role</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.suspended ? "row-suspended" : ""}>
                <td>
                  <strong>{u.name ?? "—"}</strong>
                  <span className="muted small block">{u.email ?? u.provider}</span>
                </td>
                <td>
                  <select value={u.plan} disabled={busyId === u.id} onChange={(e) => patch(u.id, { plan: e.target.value })}>
                    <option value="free">Free</option>
                    <option value="pro">Pro</option>
                    <option value="premium">Premium</option>
                  </select>
                  {u.plan !== "free" && u.planSource && (
                    <span className={`plan-source-tag src-${u.planSource}`}>
                      {u.planSource === "manual" ? "comp" : u.planSource}
                    </span>
                  )}
                </td>
                <td>
                  <span title={`Active: ${u.activeCharts} / Lifetime: ${u.totalChartsCreated}`}>
                    {u.activeCharts} / {u.totalChartsCreated}
                  </span>
                  <span className="muted small block">active / total</span>
                </td>
                <td>
                  {u.emailVerified
                    ? <span className="badge badge-ok small">✓</span>
                    : <span className="badge badge-warn small">✗</span>
                  }
                </td>
                <td>
                  <select
                    value={u.role}
                    disabled={busyId === u.id || u.id === me?.id}
                    title={u.id === me?.id ? "You can't change your own role" : ""}
                    onChange={(e) => patch(u.id, { role: e.target.value })}
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </td>
                <td>
                  {u.id === me?.id ? (
                    <span className="muted small">You</span>
                  ) : (
                    <button
                      className={`mini-btn ${u.suspended ? "ok" : "no"}`}
                      disabled={busyId === u.id}
                      onClick={() => patch(u.id, { suspended: !u.suspended })}
                    >
                      {u.suspended ? "Reactivate" : "Suspend"}
                    </button>
                  )}
                </td>
                <td>
                  <button
                    className="link small"
                    onClick={() => setExpandedId(expandedId === u.id ? null : u.id)}
                  >
                    {expandedId === u.id ? "Hide" : "Usage →"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Inline drill-down below the table */}
      {expandedId && (
        <UserUsageDrillDown userId={expandedId} onClose={() => setExpandedId(null)} />
      )}
    </div>
  );
}

function CreateUserForm({ onCreated }: { onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [plan, setPlan] = useState("free");
  const [role, setRole] = useState("user");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null); setOk(null);
    try {
      const u = await api.createAdminUser({ email, name, password, plan, role });
      setOk(`Created ${u.email}`);
      setEmail(""); setName(""); setPassword(""); setPlan("free"); setRole("user");
      onCreated();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not create user");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="admin-create" onSubmit={submit}>
      <h4>Create a user</h4>
      <div className="admin-create-grid">
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="Email" required />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" />
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password (8+ chars)" required />
        <select value={plan} onChange={(e) => setPlan(e.target.value)}>
          <option value="free">Free</option>
          <option value="pro">Pro</option>
          <option value="premium">Premium</option>
        </select>
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
        <button className="primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
      </div>
      {err && <p className="error small">{err}</p>}
      {ok && <p className="consult-ok small">{ok}</p>}
    </form>
  );
}

/* -------------------- Approvals -------------------- */

function ApprovalsSection() {
  const [offers, setOffers] = useState<AdminOffer[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => api.getAdminOffers().then(setOffers).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const decide = async (id: string, status: string) => {
    setBusyId(id);
    try {
      const updated = await api.setAdminOfferStatus(id, status);
      setOffers((os) => os.map((o) => (o.id === id ? updated : o)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusyId(null);
    }
  };

  if (err) return <p className="error">{err}</p>;
  return (
    <div className="admin-section">
      <p className="muted small">Provider profiles submitted by Premium users. Approve to list them in the consultation directory.</p>
      {offers.length === 0 ? (
        <p className="muted small">No provider offers yet.</p>
      ) : (
        <div className="admin-offers">
          {offers.map((o) => (
            <div className="admin-offer" key={o.id}>
              <div className="admin-offer-main">
                <div className="admin-offer-head">
                  <strong>{o.displayName}</strong>
                  <span className={`consult-status s-${o.status}`}>{o.status}</span>
                </div>
                <p className="provider-headline">{o.headline}</p>
                <p className="muted small">{o.bio}</p>
                <p className="muted small">
                  {o.ownerEmail} · {o.rateInr != null ? `₹${o.rateInr}/session` : "rate on request"}
                  {o.specialties ? ` · ${o.specialties}` : ""}
                </p>
              </div>
              <div className="admin-offer-actions">
                {o.status !== "approved" && (
                  <button className="mini-btn ok" disabled={busyId === o.id} onClick={() => decide(o.id, "approved")}>Approve</button>
                )}
                {o.status !== "rejected" && (
                  <button className="mini-btn no" disabled={busyId === o.id} onClick={() => decide(o.id, "rejected")}>Reject</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------- Notifications -------------------- */

function NotifySection() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [target, setTarget] = useState<"all" | "users">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [level, setLevel] = useState("info");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => { api.getAdminUsers().then(setUsers).catch(() => {}); }, []);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null); setOk(null);
    try {
      const res = await api.sendNotification({
        target,
        userIds: target === "users" ? [...selected] : undefined,
        title, body, level,
      });
      setOk(`Sent to ${res.sent} user${res.sent === 1 ? "" : "s"}.`);
      setTitle(""); setBody(""); setSelected(new Set());
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not send");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-section">
      <form className="admin-form wide" onSubmit={submit}>
        <div className="admin-target">
          <label className="radio">
            <input type="radio" checked={target === "all"} onChange={() => setTarget("all")} /> All users
          </label>
          <label className="radio">
            <input type="radio" checked={target === "users"} onChange={() => setTarget("users")} /> Specific users
          </label>
        </div>
        {target === "users" && (
          <div className="admin-user-picker">
            {users.map((u) => (
              <label key={u.id} className="admin-pick">
                <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggle(u.id)} />
                {u.name ?? u.email ?? u.id}
              </label>
            ))}
          </div>
        )}
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Scheduled maintenance" required />
        </label>
        <label>
          Message
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="What do you want to tell them?" required />
        </label>
        <label>
          Level
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="info">Info</option>
            <option value="success">Success</option>
            <option value="warning">Warning</option>
          </select>
        </label>
        {err && <p className="error small">{err}</p>}
        {ok && <p className="consult-ok small">{ok}</p>}
        <button className="primary" type="submit" disabled={busy}>{busy ? "Sending…" : "Send notification"}</button>
      </form>
    </div>
  );
}

/* -------------------- Global LLM config -------------------- */

const LLM_PROVIDERS: { id: LlmProviderId; name: string; placeholder: string; url: string }[] = [
  { id: "openai", name: "OpenAI", placeholder: "sk-…", url: "https://platform.openai.com/api-keys" },
  { id: "anthropic", name: "Claude (Anthropic)", placeholder: "sk-ant-…", url: "https://console.anthropic.com/settings/keys" },
  { id: "gemini", name: "Gemini (Google)", placeholder: "AIza…", url: "https://aistudio.google.com/app/apikey" },
];

function LlmSection() {
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [modelInputs, setModelInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.getAdminLlm().then((s) => {
      setSettings(s);
      const m: Record<string, string> = {};
      LLM_PROVIDERS.forEach((p) => (m[p.id] = s.providers[p.id].model));
      setModelInputs(m);
    }).catch((e) => setErr(e.message));
  }, []);

  const active = settings?.activeProvider ?? null;

  const saveKey = async (id: LlmProviderId) => {
    setBusy(id); setErr(null);
    try {
      const next = await api.setAdminLlmKey(id, {
        apiKey: keyInputs[id]?.trim() || undefined,
        model: modelInputs[id]?.trim() || undefined,
      });
      setSettings(next);
      setKeyInputs((k) => ({ ...k, [id]: "" }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally { setBusy(null); }
  };
  const removeKey = async (id: LlmProviderId) => {
    setBusy(id); setErr(null);
    try { setSettings(await api.removeAdminLlmProvider(id)); }
    catch (e) { setErr(e instanceof Error ? e.message : "Remove failed"); }
    finally { setBusy(null); }
  };
  const setActive = async (p: ActiveProvider) => {
    setErr(null);
    try { setSettings(await api.setAdminLlmActive(p)); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
  };

  if (!settings) return <p className="muted">Loading…</p>;

  return (
    <div className="admin-section">
      <p className="muted small">
        This configuration is <strong>global</strong>: all users' AI features (Justify &amp; Translate)
        run on the key you set here. Regular users can't configure their own keys.
      </p>
      <div className="active-picker">
        <span className="muted small">Active engine:</span>
        <button className={active === null ? "on" : ""} onClick={() => setActive(null)}>Off</button>
        <button className={active === "demo" ? "on" : ""} onClick={() => setActive("demo")}>Demo (offline)</button>
        {LLM_PROVIDERS.map((p) => (
          <button
            key={p.id}
            className={active === p.id ? "on" : ""}
            disabled={!settings.providers[p.id].configured}
            title={settings.providers[p.id].configured ? "" : "Add a key first"}
            onClick={() => setActive(p.id)}
          >
            {p.name.split(" ")[0]}
          </button>
        ))}
      </div>
      <div className="provider-list">
        {LLM_PROVIDERS.map((p) => {
          const cfg = settings.providers[p.id];
          return (
            <div className="provider-row" key={p.id}>
              <div className="provider-head">
                <strong>{p.name}</strong>
                {cfg.configured ? (
                  <span className="key-hint">key •••• {cfg.hint}</span>
                ) : (
                  <a className="link small" href={p.url} target="_blank" rel="noreferrer">get a key ↗</a>
                )}
              </div>
              <div className="provider-fields">
                <input
                  type="password"
                  placeholder={cfg.configured ? "Replace key…" : p.placeholder}
                  value={keyInputs[p.id] ?? ""}
                  onChange={(e) => setKeyInputs((k) => ({ ...k, [p.id]: e.target.value }))}
                  autoComplete="off"
                />
                <input
                  className="model-input"
                  placeholder="model"
                  value={modelInputs[p.id] ?? ""}
                  onChange={(e) => setModelInputs((m) => ({ ...m, [p.id]: e.target.value }))}
                />
                <button onClick={() => saveKey(p.id)} disabled={busy === p.id}>Save</button>
                {cfg.configured && (
                  <button className="del" onClick={() => removeKey(p.id)} disabled={busy === p.id}>Remove</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {err && <p className="error small">{err}</p>}
    </div>
  );
}

/* -------------------- Temples -------------------- */

function TemplesSection() {
  const [temples, setTemples] = useState<Temple[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try { setTemples(await api.adminListTemples()); } catch { /* ignore */ }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const setStatus = async (id: string, status: string) => {
    await api.adminSetTempleStatus(id, status);
    load();
  };

  if (loading) return <p className="muted">Loading temples…</p>;
  if (temples.length === 0) return <p className="muted">No temple registrations yet.</p>;

  return (
    <div>
      <h3>Temple Registrations</h3>
      <table className="admin-table">
        <thead>
          <tr><th>Temple</th><th>Deity</th><th>Location</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {temples.map((t) => (
            <tr key={t.id}>
              <td><strong>{t.name}</strong></td>
              <td>{t.deity}</td>
              <td>{t.location}</td>
              <td>
                <span className={`consult-status s-${t.status}`}>{t.status}</span>
              </td>
              <td>
                {t.status !== "approved" && (
                  <button className="admin-action approve" onClick={() => setStatus(t.id, "approved")}>Approve</button>
                )}
                {t.status !== "rejected" && (
                  <button className="admin-action reject" onClick={() => setStatus(t.id, "rejected")}>Reject</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------- Feature flags -------------------- */

function FeaturesSection() {
  const { refresh } = useAuth();
  const [flags, setFlags] = useState<FeatureFlags | null>(null);
  const [meta, setMeta] = useState<Record<string, FeatureMeta>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.getAdminFeatures()
      .then(({ features, meta }) => { setFlags(features); setMeta(meta); })
      .catch((e) => setErr(e.message));
  }, []);

  const toggle = async (key: string, enabled: boolean) => {
    setBusy(key); setErr(null);
    try {
      const next = await api.setAdminFeatures({ [key]: enabled });
      setFlags(next);
      refresh(); // reflect the change in the live app immediately
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally { setBusy(null); }
  };

  if (err) return <p className="error">{err}</p>;
  if (!flags) return <p className="muted">Loading…</p>;

  return (
    <div className="admin-section">
      <p className="muted small">
        Turn features on or off across the whole app. Disabled features are hidden for every user and
        their APIs are blocked.
      </p>
      <div className="feature-toggles">
        {Object.keys(meta).map((key) => (
          <div className="feature-toggle" key={key}>
            <div className="feature-toggle-info">
              <strong>{meta[key].label}</strong>
              <p className="muted small">{meta[key].description}</p>
            </div>
            <label className="switch" title={flags[key] ? "Enabled" : "Disabled"}>
              <input
                type="checkbox"
                checked={!!flags[key]}
                disabled={busy === key}
                onChange={(e) => toggle(key, e.target.checked)}
              />
              <span className="switch-slider" />
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------- Reminders (festivals + run) -------------------- */

function RemindersAdminSection() {
  const [festivals, setFestivals] = useState<AdminFestival[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // New festival form
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [date, setDate] = useState("");
  const [recurring, setRecurring] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = () => api.getAdminFestivals().then(setFestivals).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.createFestival({ name, description: desc, eventDate: date, recurring });
      setName(""); setDesc(""); setDate(""); setRecurring(true);
      load();
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : "Failed"); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => { await api.deleteFestival(id); load(); };
  const runNow = async () => {
    setRunning(true); setRunMsg(null);
    try {
      const { sent, downgraded } = await api.runReminders();
      setRunMsg(`Done — ${sent} reminder${sent === 1 ? "" : "s"} sent, ${downgraded} promo plan${downgraded === 1 ? "" : "s"} expired.`);
    } catch (e) { setRunMsg(e instanceof Error ? e.message : "Failed"); }
    finally { setRunning(false); }
  };

  return (
    <div className="admin-section">
      <p className="muted small">
        Curate the festivals users can subscribe to, and trigger the reminder dispatcher on demand
        (it also runs automatically every few hours).
      </p>

      <div className="admin-run-row">
        <button className="primary" onClick={runNow} disabled={running}>
          {running ? "Running…" : "▶ Run reminder check now"}
        </button>
        {runMsg && <span className="consult-ok small">{runMsg}</span>}
      </div>

      <form className="admin-create" onSubmit={add}>
        <h4>Add a festival</h4>
        <div className="admin-create-grid">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Festival name" required />
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (optional)" />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          <label className="admin-pick">
            <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} /> Annual
          </label>
          <button className="primary" type="submit" disabled={busy}>{busy ? "Adding…" : "Add"}</button>
        </div>
      </form>

      {err && <p className="error small">{err}</p>}

      {festivals.length === 0 ? (
        <p className="muted small">No festivals yet.</p>
      ) : (
        <ul className="booking-list">
          {festivals.map((f) => (
            <li key={f.id} className="booking-item">
              <div>
                <strong>{f.name}</strong>
                <span className="muted small"> · {new Date(f.eventDate + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC", ...(f.recurring ? {} : { year: "numeric" }) })}{f.recurring ? " (annual)" : ""}</span>
                {f.description && <p className="muted small">{f.description}</p>}
              </div>
              <button className="mini-btn no" onClick={() => remove(f.id)}>Delete</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------- Promo codes -------------------- */

function PromosSection() {
  const [promos, setPromos] = useState<AdminPromoCode[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // New promo form
  const [code, setCode] = useState("");
  const [plan, setPlan] = useState("pro");
  const [expiry, setExpiry] = useState(""); // YYYY-MM-DD (code valid until)
  const [maxRed, setMaxRed] = useState(""); // blank = unlimited
  const [duration, setDuration] = useState("30"); // days
  const [busy, setBusy] = useState(false);

  const load = () => api.getAdminPromos().then(setPromos).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const durationLabel = (d: number) =>
    d === 7 ? "1 week" : d === 14 ? "2 weeks" : d === 30 ? "1 month" : d === 365 ? "1 year" : `${d} days`;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const expiresAt = expiry ? new Date(expiry + "T23:59:59").getTime() : null;
      await api.createPromo({
        code, plan, expiresAt,
        maxRedemptions: maxRed.trim() ? parseInt(maxRed) : null,
        durationDays: parseInt(duration),
      });
      setCode(""); setPlan("pro"); setExpiry(""); setMaxRed(""); setDuration("30");
      load();
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : "Failed"); }
    finally { setBusy(false); }
  };
  const toggle = async (p: AdminPromoCode) => {
    setBusyId(p.id);
    try { const u = await api.updatePromo(p.id, { enabled: !p.enabled }); setPromos((ps) => ps.map((x) => x.id === p.id ? u : x)); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
    finally { setBusyId(null); }
  };
  const remove = async (id: string) => { await api.deletePromo(id); load(); };

  const fmtExp = (ms: number | null) =>
    ms == null ? "No expiry" : new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const expired = (ms: number | null) => ms != null && Date.now() > ms;

  return (
    <div className="admin-section">
      <p className="muted small">
        Redeeming a promo code grants the chosen plan for the set duration, then the user reverts to
        Basic (Free). Bypasses Stripe. Each code can be used once per user.
      </p>
      <form className="admin-create" onSubmit={add}>
        <h4>Create a promo code</h4>
        <div className="promo-create-grid">
          <label>Code
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. DIWALI50" required />
          </label>
          <label>Grants
            <select value={plan} onChange={(e) => setPlan(e.target.value)}>
              <option value="pro">Pro</option>
              <option value="premium">Premium</option>
            </select>
          </label>
          <label>Duration
            <select value={duration} onChange={(e) => setDuration(e.target.value)}>
              <option value="7">1 week</option>
              <option value="14">2 weeks</option>
              <option value="30">1 month</option>
              <option value="365">1 year</option>
            </select>
          </label>
          <label>Max redemptions
            <input value={maxRed} onChange={(e) => setMaxRed(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="Unlimited" />
          </label>
          <label>Code valid until
            <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
          </label>
          <button className="primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
        </div>
      </form>
      {err && <p className="error small">{err}</p>}

      {promos.length === 0 ? (
        <p className="muted small">No promo codes yet.</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr><th>Code</th><th>Grants</th><th>Duration</th><th>Redeemed</th><th>Valid until</th><th>Status</th></tr>
            </thead>
            <tbody>
              {promos.map((p) => (
                <tr key={p.id} className={!p.enabled || expired(p.expiresAt) ? "row-suspended" : ""}>
                  <td><strong>{p.code}</strong></td>
                  <td><span className={`consult-status s-${p.plan === "premium" ? "completed" : "confirmed"}`}>{p.plan}</span></td>
                  <td>{durationLabel(p.durationDays)}</td>
                  <td>{p.redemptions}{p.maxRedemptions != null ? ` / ${p.maxRedemptions}` : ""}</td>
                  <td>{fmtExp(p.expiresAt)}{expired(p.expiresAt) ? " (expired)" : ""}</td>
                  <td>
                    <div className="request-btns">
                      <button className={`mini-btn ${p.enabled ? "no" : "ok"}`} disabled={busyId === p.id} onClick={() => toggle(p)}>
                        {p.enabled ? "Disable" : "Enable"}
                      </button>
                      <button className="mini-btn no" onClick={() => remove(p.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* -------------------- Contact messages -------------------- */

const CONTACT_LABEL: Record<string, string> = Object.fromEntries(CONTACT_CATEGORIES.map((c) => [c.value, c.label]));

function ContactAdminSection() {
  const [messages, setMessages] = useState<AdminContactMessage[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");

  const load = () => api.getAdminContact().then(setMessages).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const setStatus = async (id: string, status: string) => {
    setBusyId(id);
    try {
      const updated = await api.setContactStatus(id, status);
      setMessages((ms) => ms.map((m) => (m.id === id ? updated : m)));
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
    finally { setBusyId(null); }
  };

  const shown = messages.filter((m) => filter === "all" || m.status === filter);
  const newCount = messages.filter((m) => m.status === "new").length;

  if (err) return <p className="error">{err}</p>;

  return (
    <div className="admin-section">
      <div className="contact-admin-head">
        <p className="muted small">Messages sent through the Contact us form. {newCount} new.</p>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className="contact-filter">
          <option value="all">All</option>
          <option value="new">New</option>
          <option value="read">Read</option>
          <option value="resolved">Resolved</option>
        </select>
      </div>

      {shown.length === 0 ? (
        <p className="muted small">No messages.</p>
      ) : (
        <div className="contact-list">
          {shown.map((m) => (
            <div key={m.id} className={`contact-msg status-${m.status}`}>
              <div className="contact-msg-head">
                <div>
                  <strong>{m.name}</strong>
                  {m.email && <a className="link small" href={`mailto:${m.email}`}> · {m.email}</a>}
                  {!m.fromAccount && <span className="muted small"> · (guest)</span>}
                </div>
                <div className="contact-msg-meta">
                  <span className="contact-cat">{CONTACT_LABEL[m.category] ?? m.category}</span>
                  <span className={`consult-status s-${m.status === "new" ? "requested" : m.status === "resolved" ? "completed" : "confirmed"}`}>{m.status}</span>
                </div>
              </div>
              <p className="contact-msg-body">{m.message}</p>
              <div className="contact-msg-foot">
                <span className="muted small">{new Date(m.createdAt).toLocaleString()}</span>
                <div className="request-btns">
                  {m.status !== "read" && <button className="mini-btn" disabled={busyId === m.id} onClick={() => setStatus(m.id, "read")}>Mark read</button>}
                  {m.status !== "resolved" && <button className="mini-btn ok" disabled={busyId === m.id} onClick={() => setStatus(m.id, "resolved")}>Resolve</button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const BILLING_KIND: Record<string, { label: string; cls: string }> = {
  refund: { label: "Refund", cls: "confirmed" },
  dispute_opened: { label: "Dispute opened", cls: "requested" },
  dispute_closed: { label: "Dispute closed", cls: "completed" },
};

function fmtAmount(amount: number | null, currency: string | null): string {
  if (amount == null) return "—";
  return `${currency ? currency + " " : ""}${(amount / 100).toFixed(2)}`;
}

function BillingEventsSection() {
  const [events, setEvents] = useState<AdminBillingEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getAdminBillingEvents()
      .then(setEvents)
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed"))
      .finally(() => setLoading(false));
  }, []);

  if (err) return <p className="error">{err}</p>;

  return (
    <div className="admin-section">
      <p className="muted small">
        Refunds and disputes reported by Stripe. The app never issues refunds — refunds are
        processed by an operator in the Stripe Dashboard; this is a read-only audit trail.
        Disputes (chargebacks) automatically revoke the user's paid plan.
      </p>

      {loading ? (
        <p className="muted small">Loading…</p>
      ) : events.length === 0 ? (
        <p className="muted small">No refunds or disputes recorded yet.</p>
      ) : (
        <div className="contact-list">
          {events.map((ev) => {
            const k = BILLING_KIND[ev.kind] ?? { label: ev.kind, cls: "confirmed" };
            return (
              <div key={ev.id} className="contact-msg">
                <div className="contact-msg-head">
                  <div>
                    <span className={`consult-status s-${k.cls}`}>{k.label}</span>
                    {ev.email && <a className="link small" href={`mailto:${ev.email}`}> · {ev.email}</a>}
                  </div>
                  <div className="contact-msg-meta">
                    <strong>{fmtAmount(ev.amount, ev.currency)}</strong>
                  </div>
                </div>
                <p className="contact-msg-body">{ev.detail}</p>
                <div className="contact-msg-foot">
                  <span className="muted small">{new Date(ev.createdAt).toLocaleString()}</span>
                  {ev.action && <span className="contact-cat">{ev.action}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
