import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api, AuthUser, Providers, FeatureFlags, DEFAULT_FEATURES } from "../api/client";

interface AuthState {
  user: AuthUser | null;
  providers: Providers | null;
  loading: boolean;
  backendUp: boolean; // false when the API server isn't reachable
  isAdmin: boolean; // true only for an admin-elevated session
  features: FeatureFlags; // admin-toggleable feature flags
  authError: string | null;
  verificationToken: string | null; // set after registration, cleared on verify
  login: (provider: "google" | "github") => void;
  emailLogin: (email: string, password: string) => Promise<void>;
  emailRegister: (email: string, password: string, name: string) => Promise<void>;
  devLogin: (name: string) => Promise<void>;
  adminLogin: (email: string, password: string, accessCode: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  clearError: () => void;
  verifyEmail: (token: string) => Promise<void>;
  resendVerification: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [loading, setLoading] = useState(true);
  const [backendUp, setBackendUp] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [features, setFeatures] = useState<FeatureFlags>(DEFAULT_FEATURES);
  const [authError, setAuthError] = useState<string | null>(null);
  const [verificationToken, setVerificationToken] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [me, p] = await Promise.all([api.me(), api.providers()]);
      setUser(me.user);
      setIsAdmin(me.admin);
      setFeatures(me.features);
      setProviders(p);
      setBackendUp(true);
    } catch {
      setBackendUp(false); // server not running — the app still works offline
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("auth_error");
    const emailVerified = params.get("email_verified");
    const emailVerifyErr = params.get("email_verify_error");
    if (err) {
      setAuthError(err);
      params.delete("auth_error");
    }
    if (emailVerified) {
      // User just clicked verification link — refresh to get updated state
      params.delete("email_verified");
    }
    if (emailVerifyErr) {
      setAuthError(emailVerifyErr);
      params.delete("email_verify_error");
    }
    if (err || emailVerified || emailVerifyErr) {
      const qs = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
    }
    refresh();
  }, [refresh]);

  const login = (provider: "google" | "github") => {
    window.location.href = api.loginUrl(provider);
  };

  const emailLogin = async (email: string, password: string) => {
    setUser(await api.login(email, password));
  };

  const emailRegister = async (email: string, password: string, name: string) => {
    const result = await api.register(email, password, name);
    setUser(result.user);
    if (result.verificationToken) setVerificationToken(result.verificationToken);
  };

  const devLogin = async (name: string) => {
    setUser(await api.devLogin(name));
  };

  const adminLogin = async (email: string, password: string, accessCode: string) => {
    const u = await api.adminLogin(email, password, accessCode);
    setUser(u);
    setIsAdmin(true);
  };

  const logout = async () => {
    await api.logout();
    setUser(null);
    setIsAdmin(false);
    setVerificationToken(null);
  };

  const verifyEmail = async (token: string) => {
    await api.verifyEmail(token);
    setVerificationToken(null);
    await refresh(); // re-fetch user with emailVerified=true
  };

  const resendVerification = async () => {
    const result = await api.resendVerification();
    if (result.verificationToken) setVerificationToken(result.verificationToken);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        providers,
        loading,
        backendUp,
        isAdmin,
        features,
        authError,
        verificationToken,
        login,
        emailLogin,
        emailRegister,
        devLogin,
        adminLogin,
        logout,
        refresh,
        clearError: () => setAuthError(null),
        verifyEmail,
        resendVerification,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
