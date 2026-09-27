"use client";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { AppShell } from "@/components/AppShell";
import { Spinner } from "@/components/ui";
import { useAuth } from "@/lib/auth";

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === "anonymous") router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [status, router, pathname]);

  if (status !== "authenticated")
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner label={status === "loading" ? "Restoring session…" : "Redirecting to sign in…"} />
      </div>
    );
  return <AppShell>{children}</AppShell>;
}
