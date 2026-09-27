"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { Badge, Card, EmptyState, PageHeader, QueryState, StatusBadge } from "@/components/ui";

export default function ExperimentsPage() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["experiments"], queryFn: api.training.list, refetchInterval: 10_000 });
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: api.datasets.list });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Experiments"
        description="Model training runs with AutoML, tracked metrics and explainability."
        actions={
          can("models.train") && (
            <Link href="/experiments/new" className="rounded-md bg-brand-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-700">
              Train a model
            </Link>
          )
        }
      />
      <Card bodyClassName="p-0">
        <QueryState query={q} empty={(l) => (l.length ? null : <div className="p-4"><EmptyState title="No experiments yet">{can("models.train") ? "Train your first model from a dataset." : "Data scientists and admins can train models."}</EmptyState></div>)}>
          {(list) => (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Experiments</caption>
                <thead className="bg-[var(--surface-2)] text-xs text-[var(--text-2)]">
                  <tr>
                    <th scope="col" className="px-4 py-2">Name</th>
                    <th scope="col" className="px-4 py-2">Dataset</th>
                    <th scope="col" className="px-4 py-2">Target</th>
                    <th scope="col" className="px-4 py-2">Problem</th>
                    <th scope="col" className="px-4 py-2">Status</th>
                    <th scope="col" className="px-4 py-2">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((e) => (
                    <tr key={e.id} className="border-t border-[var(--border)]">
                      <td className="px-4 py-2">
                        <Link href={`/experiments/${e.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">
                          {e.name}
                        </Link>
                      </td>
                      <td className="px-4 py-2">{datasets.data?.find((d) => d.id === e.dataset_id)?.name ?? e.dataset_id}</td>
                      <td className="px-4 py-2 font-mono text-xs">{e.target}</td>
                      <td className="px-4 py-2">{e.problem_type ? <Badge>{e.problem_type}</Badge> : "—"}</td>
                      <td className="px-4 py-2">{e.status ? <StatusBadge status={e.status} /> : "—"}</td>
                      <td className="px-4 py-2 text-xs">{formatDate(e.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryState>
      </Card>
    </div>
  );
}
