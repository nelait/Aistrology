"use client";
import { useAuth } from "@/lib/auth";
import type { PermissionName } from "@/lib/types";
import { EmptyState } from "./ui";

export function RequirePermission({ perm, children }: { perm: PermissionName; children: React.ReactNode }) {
  const { can } = useAuth();
  if (!can(perm)) return <EmptyState title="You don't have access to this page">Ask a tenant admin for a role with the “{perm}” permission.</EmptyState>;
  return <>{children}</>;
}
