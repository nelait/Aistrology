import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { api, SubscriptionInfo } from "../api/client";

const PLANS = [
  {
    id: "free" as const,
    name: "Free",
    price: "₹0",
    priceUsd: "",
    period: "",
    features: [
      "1 Profile (Birth Chart)",
      "All analysis sections",
      "Dasha, Events, Transit, Forecast",
      "Career, Health, Mental Health",
      "Marriage, Friendship, Partnership Match",
    ],
    limitations: [
      "No Justify (AI explanations)",
      "No Translate",
      "No Export / PDF reports",
    ],
    color: "rgba(255,255,255,0.15)",
  },
  {
    id: "pro" as const,
    name: "Pro",
    price: "₹499",
    priceUsd: "~$6",
    period: "/mo",
    features: [
      "2 Profiles (Birth Charts)",
      "All analysis sections",
      "AI Justify & Translate",
      "Export PDF reports",
      "Priority support",
    ],
    limitations: [],
    color: "rgba(59,130,246,0.25)",
  },
  {
    id: "premium" as const,
    name: "Premium",
    price: "₹999",
    priceUsd: "~$12",
    period: "/mo",
    features: [
      "10 Profiles (Birth Charts)",
      "All analysis sections",
      "AI Justify & Translate",
      "Export PDF reports",
      "Priority support",
      "Ideal for astrologers & professionals",
    ],
    limitations: [],
    color: "rgba(124,92,255,0.25)",
  },
];

const PLAN_RANK: Record<string, number> = { free: 0, pro: 1, premium: 2 };
const PLAN_PROFILE_LIMIT: Record<string, number> = { free: 1, pro: 2, premium: 10 };

export default function BillingView() {
  const { user, refresh } = useAuth();
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [promo, setPromo] = useState("");
  const [promoBusy, setPromoBusy] = useState(false);
  const [promoMsg, setPromoMsg] = useState<string | null>(null);
  const [promoErr, setPromoErr] = useState<string | null>(null);
  const [sub, setSub] = useState<SubscriptionInfo | null>(null);

  // On open, pull live status from Stripe. This reconciles the stored plan with
  // Stripe (covers missed webhooks) and surfaces the subscription's status/date.
  useEffect(() => {
    let alive = true;
    api.billingStatus()
      .then((s) => {
        if (alive) setSub(s.subscription);
        // Global auth update — fire even if this component already unmounted
        // (e.g. React StrictMode's double effect in dev).
        if (s.reconciled) refresh();
      })
      .catch(() => { /* offline / Stripe unset — keep DB plan */ });
    return () => { alive = false; };
  }, [refresh]);

  const fmtDate = (ms: number | null) =>
    ms == null ? "" : new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  const redeemPromo = async (e: React.FormEvent) => {
    e.preventDefault();
    setPromoBusy(true); setPromoErr(null); setPromoMsg(null);
    try {
      const { plan } = await api.redeemPromo(promo.trim());
      setPromoMsg(`Success! You're now on the ${plan.charAt(0).toUpperCase() + plan.slice(1)} plan.`);
      setPromo("");
      await refresh(); // reflect the new plan everywhere
    } catch (err) {
      setPromoErr(err instanceof Error ? err.message : "Could not redeem code");
    } finally {
      setPromoBusy(false);
    }
  };

  const currentPlan = user?.plan ?? "free";
  const profileLimit = PLAN_PROFILE_LIMIT[currentPlan] ?? 1;

  const handleUpgrade = async (plan: "pro" | "premium") => {
    setLoading(plan);
    setError(null);
    try {
      const { url } = await api.createCheckout(plan);
      if (url) window.location.href = url;
      else setError("Could not create checkout session");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(null);
    }
  };

  const handleManage = async () => {
    setLoading("portal");
    setError(null);
    try {
      const { url } = await api.openPortal();
      if (url) window.location.href = url;
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(null);
    }
  };

  if (!user) {
    return (
      <div className="match-empty">
        <div className="match-empty-icon">💳</div>
        <h2>Plans & Billing</h2>
        <p>Sign in to manage your subscription and upgrade your plan.</p>
      </div>
    );
  }

  return (
    <div className="billing-container">
      {/* Current Plan Badge */}
      <div className="billing-current">
        <div className="billing-current-badge">
          <span className="billing-plan-dot" data-plan={currentPlan} />
          <span>
            Current Plan: <strong>{currentPlan.charAt(0).toUpperCase() + currentPlan.slice(1)}</strong>
            {" · "}{profileLimit} profile{profileLimit > 1 ? "s" : ""}
            {user.planExpiresAt && (
              <span className="plan-expiry-note">
                {" · "}promo until {new Date(user.planExpiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}, then Basic
              </span>
            )}
          </span>
        </div>
        {currentPlan !== "free" && (
          <button className="btn-manage" onClick={handleManage} disabled={loading === "portal"}>
            {loading === "portal" ? "Loading…" : "Manage Subscription"}
          </button>
        )}
      </div>

      {/* Live subscription status (from Stripe) */}
      {sub && !user.planExpiresAt && (
        <div className={`sub-status sub-${sub.status}`}>
          {sub.status === "past_due" || sub.status === "unpaid" ? (
            <>⚠ Payment issue — your last payment didn't go through. Update your card via <strong>Manage Subscription</strong> to keep your plan.</>
          ) : sub.cancelAtPeriodEnd && sub.currentPeriodEnd ? (
            <>Your subscription is set to cancel — access continues until <strong>{fmtDate(sub.currentPeriodEnd)}</strong>, then reverts to Basic.</>
          ) : (sub.status === "active" || sub.status === "trialing") && sub.currentPeriodEnd ? (
            <>{sub.status === "trialing" ? "Trial" : "Active"} — renews on <strong>{fmtDate(sub.currentPeriodEnd)}</strong>.</>
          ) : sub.status === "canceled" ? (
            <>Your subscription has ended — you're on the Basic (Free) plan.</>
          ) : (
            <>Subscription status: <strong>{sub.status}</strong>.</>
          )}
        </div>
      )}

      {/* Promo code */}
      <form className="promo-redeem" onSubmit={redeemPromo}>
        <label className="promo-redeem-label">Have a promo code?</label>
        <div className="promo-redeem-row">
          <input
            value={promo}
            onChange={(e) => { setPromo(e.target.value); setPromoErr(null); setPromoMsg(null); }}
            placeholder="Enter code"
            autoCapitalize="characters"
          />
          <button className="btn-plan-upgrade" type="submit" disabled={promoBusy || !promo.trim()}>
            {promoBusy ? "Applying…" : "Apply"}
          </button>
        </div>
        {promoErr && <p className="error small">{promoErr}</p>}
        {promoMsg && <p className="promo-ok small">{promoMsg}</p>}
      </form>

      {/* Plan Cards */}
      <div className="billing-plans">
        {PLANS.map((plan) => {
          const isCurrent = currentPlan === plan.id;
          const isUpgrade = (PLAN_RANK[plan.id] ?? 0) > (PLAN_RANK[currentPlan] ?? 0);
          const isDowngrade = (PLAN_RANK[plan.id] ?? 0) < (PLAN_RANK[currentPlan] ?? 0);

          return (
            <div
              className={`billing-plan-card${isCurrent ? " current" : ""}${plan.id === "premium" ? " highlight" : ""}`}
              key={plan.id}
              style={{ borderColor: isCurrent ? plan.color : undefined }}
            >
              {isCurrent && <div className="billing-badge">Current</div>}
              {plan.id === "premium" && !isCurrent && <div className="billing-badge popular">Best Value</div>}

              <h3>{plan.name}</h3>
              <div className="billing-price">
                <span className="billing-price-num">{plan.price}</span>
                <span className="billing-price-period">{plan.period}</span>
                {plan.priceUsd && <span className="billing-price-usd"> · {plan.priceUsd}{plan.period}</span>}
              </div>

              <ul className="billing-features">
                {plan.features.map((f) => (
                  <li key={f}>
                    <span className="billing-check">✓</span>
                    {f}
                  </li>
                ))}
                {plan.limitations.map((f) => (
                  <li key={f} className="billing-limitation">
                    <span className="billing-cross">✗</span>
                    {f}
                  </li>
                ))}
              </ul>

              <div className="billing-card-action">
                {isCurrent ? (
                  <button className="btn-plan-current" disabled>
                    Current Plan
                  </button>
                ) : isUpgrade ? (
                  <button
                    className={`btn-plan-upgrade${plan.id === "premium" ? " premium" : ""}`}
                    disabled={loading !== null}
                    onClick={() => handleUpgrade(plan.id as "pro" | "premium")}
                  >
                    {loading === plan.id ? "Loading…" : `Upgrade to ${plan.name}`}
                  </button>
                ) : isDowngrade && currentPlan !== "free" ? (
                  <button className="btn-manage" onClick={handleManage} disabled={loading !== null}>
                    Manage Subscription
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {error && <p className="error" style={{ marginTop: 16 }}>{error}</p>}

      {/* FAQ */}
      <div className="billing-faq">
        <h3>Frequently Asked Questions</h3>
        <div className="billing-faq-item">
          <strong>What's different between Pro and Premium?</strong>
          <p>Both include all features (Justify, Translate, Export). The difference is the number of profiles:
            Pro allows 2, Premium allows 10 — ideal for professional astrologers managing multiple clients.</p>
        </div>
        <div className="billing-faq-item">
          <strong>Can I cancel anytime?</strong>
          <p>Yes — click "Manage Subscription" to cancel. Your plan stays active until the end of the billing period.</p>
        </div>
        <div className="billing-faq-item">
          <strong>What payment methods are accepted?</strong>
          <p>Credit/debit cards, UPI, net banking, Google Pay, and Apple Pay.</p>
        </div>
        <div className="billing-faq-item">
          <strong>Can I switch plans?</strong>
          <p>Yes — upgrade or downgrade anytime. Changes take effect immediately with prorated billing.</p>
        </div>
      </div>
    </div>
  );
}
