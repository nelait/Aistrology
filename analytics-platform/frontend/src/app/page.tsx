"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { Spinner } from "@/components/ui";

export default function Home() {
  const { status } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === "authenticated") router.replace("/datasets");
    else if (status === "anonymous") router.replace("/login");
  }, [status, router]);
  return (
    <main className="grid min-h-screen place-items-center">
      <Spinner label="Loading" />
    </main>
  );
}
