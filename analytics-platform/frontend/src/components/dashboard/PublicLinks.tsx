"use client";
/** Public view-only links (SHR-001a): create with an expiry, copy once, revoke. */
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { Badge, Button, CopyButton, SelectField } from "../ui";

const TTL_OPTIONS = [
  { value: "1", label: "1 hour" },
  { value: "24", label: "1 day" },
  { value: "168", label: "7 days" },
  { value: "720", label: "30 days" },
  { value: "2160", label: "90 days" },
  { value: "8760", label: "1 year" },
];

const STATUS_TONE: Record<string, "good" | "neutral" | "critical"> = { active: "good", expired: "neutral", revoked: "critical" };

export function publicUrl(token: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/public/${encodeURIComponent(token)}`;
}

export function PublicLinks({ dashboardId }: { dashboardId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [ttl, setTtl] = useState("168");
  const [created, setCreated] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["public-links", dashboardId], queryFn: () => api.dashboards.publicLinks(dashboardId), meta: { silent: true } });
  const create = useMutation({
    mutationFn: () => api.dashboards.createPublicLink(dashboardId, Number(ttl)),
    meta: { errorPrefix: "Public link not created" },
    onSuccess: (l) => {
      setCreated(publicUrl(l.token));
      qc.invalidateQueries({ queryKey: ["public-links", dashboardId] });
    },
  });
  const revoke = useMutation({
    mutationFn: (linkId: string) => api.dashboards.revokePublicLink(dashboardId, linkId),
    onSuccess: () => {
      toast.success("Public link revoked");
      qc.invalidateQueries({ queryKey: ["public-links", dashboardId] });
    },
  });
  const disabled = list.error instanceof ApiError && list.error.status === 403;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Public link (anyone with the link)</p>
      {disabled ? (
        <p className="text-xs text-[var(--text-2)]">
          Public links are turned off for this organization.{" "}
          {can("tenant.manage") && (
            <Link href="/admin?tab=sharing" className="underline">
              Change in Admin → Sharing
            </Link>
          )}
        </p>
      ) : (
        <>
          <p className="text-xs text-amber-800 dark:text-amber-300">⚠ No sign-in needed: anyone with the link can view this dashboard and its data until it expires or is revoked.</p>
          <div className="flex flex-wrap items-end gap-2">
            <SelectField label="Expires after" value={ttl} onChange={(e) => setTtl(e.target.value)} options={TTL_OPTIONS} />
            <Button size="sm" onClick={() => create.mutate()} loading={create.isPending}>
              Create public link
            </Button>
          </div>
          {created && (
            <div className="rounded-md border border-[var(--border)] p-2" aria-live="polite">
              <p className="mb-1 text-xs text-amber-900 dark:text-amber-200">Copy the link now; it is shown only once.</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-[var(--surface-2)] p-2 font-mono text-[10px]">{created}</code>
                <CopyButton text={created} />
              </div>
            </div>
          )}
          {list.data?.length ? (
            <ul className="divide-y divide-[var(--border)] text-xs" aria-label="Public links">
              {list.data.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-2 py-1.5">
                  <Badge tone={STATUS_TONE[l.status] ?? "neutral"}>{l.status}</Badge>
                  <span className="flex-1 text-[var(--text-2)]">
                    created {formatDate(l.created_at)} · {l.status === "revoked" && l.revoked_at ? `revoked ${formatDate(l.revoked_at)}` : `expires ${formatDate(l.expires_at)}`}
                  </span>
                  {l.status === "active" && (
                    <Button size="sm" variant="ghost" onClick={() => revoke.mutate(l.id)} loading={revoke.isPending && revoke.variables === l.id}>
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}
