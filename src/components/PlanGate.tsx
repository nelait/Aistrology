import { type ReactNode, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { api } from "../api/client";

const PLAN_LABEL: Record<string, string> = { pro: "Pro", premium: "Premium" };
const PLAN_PROFILE_LIMIT: Record<string, number> = { free: 1, pro: 2, premium: 10 };

interface Props {
  /** The minimum plan needed. Used when gating features (e.g. "pro" for Justify). */
  requiredPlan: "pro" | "premium";
  featureName: string;
  children: ReactNode;
}

/**
 * Wraps content that requires a paid plan. Shows an upgrade prompt if
 * the user's plan doesn't meet the requirement.
 */
export default function PlanGate({ requiredPlan, featureName, children }: Props) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const userPlan = user?.plan ?? "free";
  const PLAN_RANK: Record<string, number> = { free: 0, pro: 1, premium: 2 };
  const hasAccess = (PLAN_RANK[userPlan] ?? 0) >= (PLAN_RANK[requiredPlan] ?? 0);

  if (hasAccess) return <>{children}</>;

  const handleUpgrade = async (plan: "pro" | "premium") => {
    setLoading(true);
    setError(null);
    try {
      const { url } = await api.createCheckout(plan);
      if (url) window.location.href = url;
      else setError("Could not create checkout session");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="plan-gate">
      <div className="plan-gate-icon">🔒</div>
      <h2 className="plan-gate-title">{featureName}</h2>
      <p className="plan-gate-text">
        Upgrade to a <strong>{PLAN_LABEL[requiredPlan]}</strong> plan or higher to access{" "}
        {featureName.toLowerCase()}.
      </p>

      <div className="plan-gate-cards">
        <div className="plan-gate-card">
          <h4>Pro</h4>
          <p className="plan-gate-price">₹499<span>/mo · ~$6/mo</span></p>
          <ul>
            <li>2 Profiles</li>
            <li>Justify, Translate, Export</li>
            <li>All analysis sections</li>
          </ul>
          <button
            className="btn-plan-upgrade"
            disabled={loading || userPlan === "pro"}
            onClick={() => handleUpgrade("pro")}
          >
            {userPlan === "pro" ? "Current Plan" : loading ? "Loading…" : "Upgrade to Pro"}
          </button>
        </div>
        <div className="plan-gate-card recommended">
          <h4>Premium</h4>
          <p className="plan-gate-price">₹999<span>/mo · ~$12/mo</span></p>
          <ul>
            <li>10 Profiles</li>
            <li>Justify, Translate, Export</li>
            <li>All analysis sections</li>
            <li>Ideal for professionals</li>
          </ul>
          <button
            className="btn-plan-upgrade premium"
            disabled={loading || userPlan === "premium"}
            onClick={() => handleUpgrade("premium")}
          >
            {userPlan === "premium" ? "Current Plan" : loading ? "Loading…" : "Upgrade to Premium"}
          </button>
        </div>
      </div>

      {error && <p className="error" style={{ marginTop: 12 }}>{error}</p>}
    </div>
  );
}
