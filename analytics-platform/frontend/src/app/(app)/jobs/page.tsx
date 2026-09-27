"use client";
import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Job } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatDuration } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { Button, Card, Checkbox, CodeBlock, EmptyState, PageHeader, ProgressBar, QueryState, SelectField, StatusBadge } from "@/components/ui";

function duration(j: Job): string {
  if (!j.started_at) return "—";
  const end = j.finished_at ? new Date(j.finished_at) : new Date();
  return formatDuration((end.getTime() - new Date(j.started_at).getTime()) / 1000);
}

/** Job dashboard (MT-004): status, progress, logs, cancel. */
export default function JobsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState("");
  const [auto, setAuto] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["jobs", status], queryFn: () => api.jobs.list(status || undefined), refetchInterval: auto ? 3000 : false });
  const cancel = useMutation({
    mutationFn: (id: string) => api.jobs.cancel(id),
    onSuccess: () => {
      toast.success("Cancellation requested");
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  return (
    <div className="space-y-5">
      <PageHeader title="Jobs" description="Background work: training, profiling, large generation, pipeline applies, batch predictions and exports." />
      <Card
        bodyClassName="p-0"
        title={
          <span className="flex flex-wrap items-end gap-4">
            <SelectField
              label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              options={["queued", "running", "succeeded", "failed", "cancelled"].map((s) => ({ value: s, label: s }))}
              placeholder="All"
            />
            <Checkbox label="Auto-refresh (3 s)" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          </span>
        }
      >
        <QueryState query={q} empty={(l) => (l.length ? null : <div className="p-4"><EmptyState title="No jobs" /></div>)}>
          {(jobs) => (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Jobs</caption>
                <thead className="bg-[var(--surface-2)] text-xs text-[var(--text-2)]">
                  <tr>
                    <th scope="col" className="px-3 py-2">Type</th>
                    <th scope="col" className="px-3 py-2">Status</th>
                    <th scope="col" className="w-48 px-3 py-2">Progress</th>
                    <th scope="col" className="px-3 py-2">Message</th>
                    <th scope="col" className="px-3 py-2">Attempts</th>
                    <th scope="col" className="px-3 py-2">Created</th>
                    <th scope="col" className="px-3 py-2">Duration</th>
                    <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <Fragment key={j.id}>
                      <tr className="border-t border-[var(--border)]">
                        <td className="px-3 py-2">
                          <span className="font-mono text-xs">{j.type}</span>
                          <span className="block font-mono text-[10px] text-[var(--text-2)]">{j.id.slice(0, 12)}</span>
                        </td>
                        <td className="px-3 py-2">
                          <StatusBadge status={j.status} />
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <ProgressBar value={j.status === "succeeded" ? 1 : j.progress} label={`${j.type} progress`} />
                            <span className="text-xs tabular-nums">{Math.round((j.status === "succeeded" ? 1 : j.progress) * 100)}%</span>
                          </div>
                        </td>
                        <td className="max-w-xs truncate px-3 py-2 text-xs" title={j.error ?? j.message ?? ""}>
                          {j.error ? <span className="text-red-700 dark:text-red-400">{j.error}</span> : j.message}
                        </td>
                        <td className="px-3 py-2 text-xs">{j.attempts}</td>
                        <td className="px-3 py-2 text-xs">{formatDate(j.created_at)}</td>
                        <td className="px-3 py-2 text-xs">{duration(j)}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right">
                          <Button size="sm" variant="ghost" aria-expanded={open === j.id} onClick={() => setOpen(open === j.id ? null : j.id)}>
                            Details
                          </Button>
                          {(j.status === "queued" || j.status === "running") && can("data.write") && (
                            <Button size="sm" variant="ghost" onClick={() => cancel.mutate(j.id)} loading={cancel.isPending && cancel.variables === j.id}>
                              Cancel
                            </Button>
                          )}
                        </td>
                      </tr>
                      {open === j.id && (
                        <tr>
                          <td colSpan={8} className="bg-[var(--surface-2)] px-3 py-3">
                            <div className="grid gap-3 md:grid-cols-2">
                              <div>
                                <p className="mb-1 text-xs font-semibold">Parameters</p>
                                <CodeBlock code={JSON.stringify(j.params, null, 2)} />
                              </div>
                              <div>
                                <p className="mb-1 text-xs font-semibold">{j.error ? "Error" : "Result"}</p>
                                <CodeBlock code={j.error ?? JSON.stringify(j.result, null, 2) ?? "—"} />
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
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
