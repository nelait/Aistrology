"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AuthCard } from "@/components/AuthCard";
import { Spinner } from "@/components/ui";

interface OidcSaved {
  provider: string;
  state: string;
  next: string;
}

function readSaved(): OidcSaved | null {
  try {
    const v = JSON.parse(sessionStorage.getItem("ap.oidc") ?? "null") as OidcSaved | null;
    sessionStorage.removeItem("ap.oidc");
    return v;
  } catch {
    return null;
  }
}

function Callback() {
  const params = useSearchParams();
  const router = useRouter();
  const { loginWithTokens } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = params.get("code");
    const state = params.get("state");
    const idpError = params.get("error_description") ?? params.get("error");
    const saved = readSaved();
    if (idpError) return setError(idpError);
    if (!code || !state || !saved) return setError("The sign-in response is incomplete. Start again from the sign-in page.");
    if (saved.state !== state) return setError("The sign-in response doesn't match this browser session (state mismatch).");
    const next = saved.next.startsWith("/") && !saved.next.startsWith("//") ? saved.next : "/datasets";
    api.auth
      .oidcCallback(saved.provider, code, state)
      .then(loginWithTokens)
      .then(() => router.replace(next))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Sign-in failed"));
  }, [params, loginWithTokens, router]);

  return (
    <AuthCard title="Signing you in">
      {error ? (
        <div className="space-y-3">
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
            {error}
          </p>
          <Link href="/login" className="text-sm text-brand-600 underline dark:text-brand-300">
            Back to sign in
          </Link>
        </div>
      ) : (
        <Spinner label="Completing single sign-on…" />
      )}
    </AuthCard>
  );
}

export default function CallbackPage() {
  return (
    <Suspense>
      <Callback />
    </Suspense>
  );
}
