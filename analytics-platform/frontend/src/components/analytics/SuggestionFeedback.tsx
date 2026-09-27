"use client";
/** LLM-009: accept / reject feedback on suggestion cards and the tenant's learned preferences. */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PreferenceCounts, type Suggestion } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatPercent } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { Badge, Button, Card, ConfirmDialog, EmptyState, QueryState } from "../ui";

export type Verdict = "accepted" | "rejected";

/** Send feedback for a suggestion (silently: feedback must never block the user's action). */
export function useSuggestionFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ datasetId, suggestion, accepted }: { datasetId: string; suggestion: Pick<Suggestion, "title" | "chart_type" | "category">; accepted: boolean }) =>
      api.suggestions.feedback(datasetId, { accepted, suggestion: { title: suggestion.title?.slice(0, 200), chart_type: suggestion.chart_type, category: suggestion.category } }),
    meta: { silent: true },
    onSuccess: (prefs) => qc.setQueryData(["suggestion-preferences"], prefs),
  });
}

/** Accept / reject buttons that record feedback. `onAccept` / `onReject` run the card's own action. */
export function FeedbackButtons({
  datasetId,
  suggestion,
  verdict,
  onVerdict,
  onAccept,
  acceptLabel = "Accept",
  acceptDisabled,
}: {
  datasetId: string;
  suggestion: Suggestion;
  verdict?: Verdict | null;
  onVerdict: (v: Verdict) => void;
  onAccept?: () => void;
  acceptLabel?: string;
  acceptDisabled?: boolean;
}) {
  const fb = useSuggestionFeedback();
  const send = (accepted: boolean) => {
    onVerdict(accepted ? "accepted" : "rejected");
    fb.mutate({ datasetId, suggestion, accepted });
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="primary"
        size="sm"
        disabled={acceptDisabled}
        aria-pressed={verdict === "accepted"}
        onClick={() => {
          if (verdict !== "accepted") send(true);
          onAccept?.();
        }}
      >
        ✓ {acceptLabel}
      </Button>
      <Button size="sm" variant="ghost" aria-pressed={verdict === "rejected"} disabled={verdict === "rejected"} onClick={() => send(false)}>
        ✕ Reject
      </Button>
      {verdict && (
        <span className="text-xs text-[var(--text-2)]" aria-live="polite">
          {fb.isError ? "Feedback not recorded" : verdict === "accepted" ? "Thanks, noted as useful" : "Noted; similar suggestions rank lower"}
        </span>
      )}
    </span>
  );
}

function PrefTable({ title, counts }: { title: string; counts: PreferenceCounts | undefined }) {
  const rows = Object.entries(counts ?? {}).sort((a, b) => b[1].accepted + b[1].rejected - (a[1].accepted + a[1].rejected));
  if (!rows.length) return null;
  return (
    <table className="w-full text-left text-sm">
      <caption className="mb-1 text-left text-xs font-semibold">{title}</caption>
      <thead className="text-xs text-[var(--text-2)]">
        <tr>
          <th scope="col" className="py-1">Value</th>
          <th scope="col" className="py-1">Accepted</th>
          <th scope="col" className="py-1">Rejected</th>
          <th scope="col" className="py-1">Acceptance</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} className="border-t border-[var(--border)]">
            <td className="py-1 font-mono text-xs">{k}</td>
            <td className="py-1 tabular-nums">{v.accepted}</td>
            <td className="py-1 tabular-nums">{v.rejected}</td>
            <td className="py-1 tabular-nums">{formatPercent(v.accepted / Math.max(1, v.accepted + v.rejected), 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Learned preferences of the organization (read for analytics.create; reset for admins). */
export function PreferencesCard() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const q = useQuery({ queryKey: ["suggestion-preferences"], queryFn: api.suggestions.preferences, enabled: can("analytics.create") });
  const reset = useMutation({
    mutationFn: api.suggestions.resetPreferences,
    meta: { errorPrefix: "Reset failed" },
    onSuccess: () => {
      toast.success("Suggestion preferences reset");
      setConfirm(false);
      qc.invalidateQueries({ queryKey: ["suggestion-preferences"] });
    },
  });
  if (!can("analytics.create")) return null;
  return (
    <Card
      title="Learned suggestion preferences"
      actions={
        can("tenant.manage") && (
          <Button size="sm" variant="danger" onClick={() => setConfirm(true)}>
            Reset
          </Button>
        )
      }
    >
      <QueryState query={q}>
        {(p) => {
          const empty = !Object.keys(p.preferences.chart_type ?? {}).length && !Object.keys(p.preferences.category ?? {}).length;
          return empty ? (
            <EmptyState title="Nothing learned yet">Accept or reject suggestion cards; after 3 decisions the assistant starts favouring what your organization finds useful.</EmptyState>
          ) : (
            <div className="space-y-3">
              <p className="text-sm">
                {p.summary ? (
                  <>
                    <Badge tone="info">Sent to the assistant</Badge> {p.summary}
                  </>
                ) : (
                  <span className="text-[var(--text-2)]">Not used in prompts yet (needs at least 3 feedback events). Suggestions are still re-ranked by acceptance rate.</span>
                )}
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                <PrefTable title="Chart types" counts={p.preferences.chart_type} />
                <PrefTable title="Categories" counts={p.preferences.category} />
              </div>
              <p className="text-xs text-[var(--text-2)]">Only chart types and categories are learned, per organization. No titles, data or user names are used.</p>
            </div>
          );
        }}
      </QueryState>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => reset.mutate()} title="Reset learned preferences?" danger confirmLabel="Reset" loading={reset.isPending}>
        <p>Suggestions go back to the default ranking for everyone in the organization.</p>
      </ConfirmDialog>
    </Card>
  );
}
