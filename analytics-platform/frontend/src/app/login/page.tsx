"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AuthCard } from "@/components/AuthCard";
import { Button, TextField } from "@/components/ui";

const MESSAGES: Record<string, string> = {
  invalid_credentials: "Incorrect email or password.",
  locked: "This account is temporarily locked after too many failed attempts. Try again later.",
  mfa_invalid: "That code is not valid. Check your authenticator app and try again.",
  mfa_enrollment_required: "Your organization requires two-factor authentication. Ask an admin to help you enroll, then sign in again.",
  disabled: "This account has been disabled. Contact your organization admin.",
};

const PROVIDER_LABELS: Record<string, string> = { google: "Google", microsoft: "Microsoft", azure: "Microsoft", okta: "Okta" };

function SsoButtons({ next }: { next: string }) {
  const [providers, setProviders] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.auth.oidcProviders().then((r) => setProviders(r.providers), () => setProviders([]));
  }, []);
  if (!providers.length) return null;
  const start = async (provider: string) => {
    setBusy(provider);
    setError(null);
    try {
      const redirect = `${window.location.origin}/auth/callback`;
      const { authorization_url, state } = await api.auth.oidcAuthorize(provider, redirect);
      sessionStorage.setItem("ap.oidc", JSON.stringify({ provider, state, next }));
      window.location.assign(authorization_url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "SSO is unavailable");
      setBusy(null);
    }
  };
  return (
    <div className="mt-6 space-y-2">
      <p className="text-center text-xs text-[var(--text-2)]">or continue with</p>
      {providers.map((p) => (
        <Button key={p} className="w-full" onClick={() => start(p)} loading={busy === p}>
          {PROVIDER_LABELS[p] ?? p}
        </Button>
      ))}
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/datasets";
}

function LoginForm() {
  const { login, status } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [step, setStep] = useState<"password" | "totp">("password");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === "authenticated") router.replace(next);
  }, [status, router, next]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login({ email, password, totp: step === "totp" ? totp.replace(/\s/g, "") : undefined });
      router.replace(next);
    } catch (err) {
      if (err instanceof ApiError && err.code === "mfa_required") {
        setStep("totp");
        setError(null);
      } else if (err instanceof ApiError && err.code && MESSAGES[err.code]) {
        setError(MESSAGES[err.code]);
      } else {
        setError(err instanceof Error ? err.message : "Sign in failed");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={step === "password" ? "Sign in" : "Two-factor authentication"}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {step === "password" ? (
          <>
            <TextField label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </>
        ) : (
          <TextField
            label="Authentication code"
            hint="Enter the 6-digit code from your authenticator app."
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]*"
            maxLength={10}
            required
            autoFocus
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
          />
        )}
        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          {step === "password" ? "Sign in" : "Verify"}
        </Button>
        {step === "totp" && (
          <Button variant="ghost" className="w-full" onClick={() => { setStep("password"); setTotp(""); }}>
            Back
          </Button>
        )}
      </form>
      <SsoButtons next={next} />
      <p className="mt-6 text-center text-sm text-[var(--text-2)]">
        New to the platform?{" "}
        <Link href="/signup" className="font-medium text-brand-600 underline dark:text-brand-300">
          Create an organization
        </Link>
      </p>
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
