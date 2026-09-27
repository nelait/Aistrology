"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, client, localTokenStorage, type LoginRequest, type Me } from "./api";
import { can } from "./rbac";
import type { PermissionName } from "./types";

type Status = "loading" | "authenticated" | "anonymous";

interface AuthCtx {
  status: Status;
  me: Me | null;
  login: (body: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
  reloadMe: () => Promise<void>;
  can: (p: PermissionName) => boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const qc = useQueryClient();

  const reloadMe = useCallback(async () => {
    const m = await api.auth.me();
    setMe(m);
    setStatus("authenticated");
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (client.isAuthenticated || (client.hasRefreshToken && (await client.refresh()))) {
          const m = await api.auth.me();
          if (!cancelled) {
            setMe(m);
            setStatus("authenticated");
          }
          return;
        }
      } catch {
        /* fall through to anonymous */
      }
      if (!cancelled) setStatus("anonymous");
    })();
    const off = client.onAuthChange((ok) => {
      if (!ok) {
        setMe(null);
        setStatus("anonymous");
        qc.clear();
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [qc]);

  const login = useCallback(
    async (body: LoginRequest) => {
      const pair = await api.auth.login(body);
      client.setTokens(pair);
      await reloadMe();
    },
    [reloadMe],
  );

  const logout = useCallback(async () => {
    const rt = localTokenStorage.get();
    try {
      if (rt) await api.auth.logout(rt);
    } catch {
      /* the session is dropped locally regardless */
    }
    client.clearTokens();
    setMe(null);
    setStatus("anonymous");
    qc.clear();
  }, [qc]);

  const value = useMemo<AuthCtx>(
    () => ({ status, me, login, logout, reloadMe, can: (p) => can(me?.role, p) }),
    [status, me, login, logout, reloadMe],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}
