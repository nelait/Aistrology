"use client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import { ThemeProvider } from "@/lib/theme";
import { notify, ToastProvider } from "@/lib/toast";

function report(err: unknown, meta: Record<string, unknown> | undefined) {
  if (meta?.silent) return;
  if (err instanceof ApiError && err.status === 401) return; // handled by the auth layer
  if (err instanceof DOMException && err.name === "AbortError") return;
  const prefix = typeof meta?.errorPrefix === "string" ? `${meta.errorPrefix}: ` : "";
  notify(`${prefix}${err instanceof Error ? err.message : String(err)}`, "error");
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: (err, query) => report(err, query.meta) }),
        mutationCache: new MutationCache({ onError: (err, _v, _c, m) => report(err, m.meta) }),
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
          },
        },
      }),
  );
  return (
    <ThemeProvider>
      <ToastProvider>
        <QueryClientProvider client={qc}>
          <AuthProvider>{children}</AuthProvider>
        </QueryClientProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
