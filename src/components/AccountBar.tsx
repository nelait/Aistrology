import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { api } from "../api/client";

interface Props {
  /** Optionally control the menu's open state (e.g. from a hero CTA). */
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
}

export default function AccountBar({
  menuOpen,
  onMenuOpenChange,
}: Props) {
  const { user, providers, loading, backendUp, login, emailLogin, emailRegister, devLogin, logout } =
    useAuth();
  const [openState, setOpenState] = useState(false);
  // Controlled when `menuOpen` is provided, otherwise internal.
  const open = menuOpen ?? openState;
  const setOpen = (next: boolean | ((o: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(open) : next;
    setOpenState(value);
    onMenuOpenChange?.(value);
  };
  const [devName, setDevName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Email/password form state.
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authName, setAuthName] = useState("");
  const [showDev, setShowDev] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close the menu on an outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  if (loading || !backendUp) return null; // accounts unavailable — app still works

  // --- Signed out ---
  if (!user) {
    return (
      <div className="account" ref={ref}>
        <button className="account-btn" onClick={() => setOpen((o) => !o)}>
          Sign in
        </button>
        {open && (
          <div className="account-menu">
            <p className="menu-title">
              {authMode === "login" ? "Sign in to save charts" : "Create an account"}
            </p>

            {(providers?.google || providers?.github) && (
              <>
                {providers?.google && (
                  <a className="oauth-btn google" href={api.loginUrl("google")}>
                    Continue with Google
                  </a>
                )}
                {providers?.github && (
                  <a className="oauth-btn github" href={api.loginUrl("github")}>
                    Continue with GitHub
                  </a>
                )}
                <div className="or-divider"><span>or</span></div>
              </>
            )}

            <form
              className="email-auth"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError(null);
                try {
                  if (authMode === "register") {
                    await emailRegister(email.trim(), password, authName.trim());
                  } else {
                    await emailLogin(email.trim(), password);
                  }
                  setOpen(false);
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Sign-in failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {authMode === "register" && (
                <input
                  value={authName}
                  onChange={(e) => setAuthName(e.target.value)}
                  placeholder="Name"
                  autoComplete="name"
                />
              )}
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                autoComplete="email"
                required
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={authMode === "register" ? "Password (8+ characters)" : "Password"}
                autoComplete={authMode === "register" ? "new-password" : "current-password"}
                required
              />
              {error && <p className="error small">{error}</p>}
              <button type="submit" className="submit-auth" disabled={busy}>
                {authMode === "login" ? "Sign in" : "Create account"}
              </button>
            </form>

            <p className="muted small switch-mode">
              {authMode === "login" ? "New here? " : "Have an account? "}
              <button
                className="link"
                type="button"
                onClick={() => {
                  setAuthMode((m) => (m === "login" ? "register" : "login"));
                  setError(null);
                }}
              >
                {authMode === "login" ? "Create an account" : "Sign in"}
              </button>
            </p>

            {providers?.devLogin && (
              <div className="dev-login">
                {!showDev ? (
                  <button className="link small" type="button" onClick={() => setShowDev(true)}>
                    Use a local dev profile instead
                  </button>
                ) : (
                  <div className="dev-login-row">
                    <input
                      value={devName}
                      onChange={(e) => setDevName(e.target.value)}
                      placeholder="Your name"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await devLogin(devName.trim() || "Dev User");
                          setOpen(false);
                        } finally {
                          setBusy(false);
                        }
                      }}
                      disabled={busy}
                    >
                      Continue
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // --- Signed in ---
  const initials = (user.name ?? "?")
    .split(/\s+/)
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="account" ref={ref}>
      <button className="account-btn user" onClick={() => setOpen((o) => !o)}>
        {user.avatarUrl ? (
          <img className="avatar" src={user.avatarUrl} alt="" />
        ) : (
          <span className="avatar initials">{initials}</span>
        )}
        <span className="account-name">{user.name ?? "Account"}</span>
        <span className="chevron">▾</span>
      </button>
      {open && (
        <div className="account-menu wide">
          <div className="menu-head">
            <strong>{user.name}</strong>
            {user.email && <span className="muted small">{user.email}</span>}
          </div>

          <p className="muted small account-hint">Manage the charts you're viewing from the profile switcher.</p>

          <button className="logout" onClick={() => { logout(); setOpen(false); }}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
