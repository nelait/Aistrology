"use client";
/**
 * Tenant users and chat destinations for pickers (recipients, @mentions). Listing users and destinations is
 * admin-only in the API, so other roles get just themselves and must type other user ids.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ChatDestination, type TenantUser } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export function useTenantUsers(): { users: TenantUser[]; complete: boolean; names: Map<string, string>; loading: boolean } {
  const { me, can } = useAuth();
  const admin = can("tenant.manage");
  const q = useQuery({ queryKey: ["tenant-users"], queryFn: api.tenant.users, enabled: admin, staleTime: 60_000, meta: { silent: true } });
  return useMemo(() => {
    const self: TenantUser[] = me ? [{ id: me.id, email: me.email ?? me.id, name: me.name ?? null, role: me.role, mfa_enabled: !!me.mfa_enabled, disabled: false }] : [];
    const users = admin && q.data ? q.data : self;
    const names = new Map(users.map((u) => [u.id, u.name || u.email]));
    return { users, complete: admin && !!q.data, names, loading: admin && q.isLoading };
  }, [admin, q.data, q.isLoading, me]);
}

export function useChatDestinations(): { destinations: ChatDestination[]; available: boolean } {
  const { can } = useAuth();
  const admin = can("tenant.manage");
  const q = useQuery({ queryKey: ["chat-destinations"], queryFn: api.access.chatDestinations, enabled: admin, staleTime: 60_000, meta: { silent: true } });
  return { destinations: q.data ?? [], available: admin };
}
