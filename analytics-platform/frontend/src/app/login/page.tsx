"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
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
