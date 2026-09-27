"use client";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Analytic } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader, QueryState } from "@/components/ui";

export default function AnalyticsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["analytics"], queryFn: api.analytics.list });
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: api.datasets.list });
  const [del, setDel] = useState<Analytic | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.analytics.remove(id),
    onSuccess: () => {
      toast.success("Analytic deleted");
      setDel(null);
      qc.invalidateQueries({ queryKey: ["analytics"] });
    },
  });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics"
        description="Saved, reusable and parameterized analytics. Build them visually, in SQL, or accept AI suggestions from a dataset."
        actions={
          can("analytics.create") && (
            <Link href="/analytics/new" className="rounded-md bg-brand-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-700">
              New analytic
            </Link>
          )
        }
      />
      <Card bodyClassName="p-0">
        <QueryState query={q} empty={(l) => (l.length ? null : <div className="p-4"><EmptyState title="No saved analytics">Create one with the builder, or accept a suggestion on a dataset&apos;s Suggestions tab.</EmptyState></div>)}>
          {(list) => (
            <ul className="divide-y divide-[var(--border)]">
              {list.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/analytics/${a.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">
                      {a.name}
                    </Link>
                    <p className="text-xs text-[var(--text-2)]">
                      {datasets.data?.find((d) => d.id === a.dataset_id)?.name ?? a.dataset_id}
                      {a.created_at ? ` · ${formatDate(a.created_at)}` : ""}
                    </p>
                  </div>
                  <Badge>{a.chart?.type ?? "table"}</Badge>
                  {a.parameters?.length ? <Badge tone="info">{a.parameters.length} params</Badge> : null}
                  {can("analytics.create") && (
                    <Button size="sm" variant="ghost" onClick={() => setDel(a)} aria-label={`Delete ${a.name}`}>
                      Delete
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Card>
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={() => del && remove.mutate(del.id)} title="Delete analytic?" danger confirmLabel="Delete" loading={remove.isPending}>
        <p>Dashboards widgets that use “{del?.name}” will stop working.</p>
      </ConfirmDialog>
    </div>
  );
}
