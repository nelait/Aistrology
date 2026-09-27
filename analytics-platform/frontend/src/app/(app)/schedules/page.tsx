"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Schedule } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { describeCron } from "@/lib/cron";
import { formatDate } from "@/lib/format";
import { jobTypeLabel, lastStatusTone } from "@/lib/schedules";
import { useToast } from "@/lib/toast";
import { RequirePermission } from "@/components/RequirePermission";
import { ScheduleForm } from "@/components/schedules/ScheduleForm";
import { LastResult, UpcomingRuns } from "@/components/schedules/UpcomingRuns";
import { Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader, QueryState, SelectField, Spinner } from "@/components/ui";

export default function SchedulesPage() {
  return (
    <RequirePermission perm="view">
      <Schedules />
    </RequirePermission>
  );
}

function Schedules() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const params = useSearchParams();
  const [filter, setFilter] = useState(params.get("job_type") ?? "");
  const types = useQuery({ queryKey: ["schedule-types"], queryFn: api.schedules.types, staleTime: 5 * 60_000 });
  const list = useQuery({ queryKey: ["schedules", filter], queryFn: () => api.schedules.list(filter || undefined), refetchInterval: 30_000 });
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [creating, setCreating] = useState<string | null>(params.get("new"));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Schedule | null>(null);
  const anyAllowed = types.data?.some((t) => t.allowed) ?? false;

  const refresh = () => qc.invalidateQueries({ queryKey: ["schedules"] });
  const toggle = useMutation({
    mutationFn: (s: Schedule) => api.schedules.update(s.id, { enabled: !s.enabled }),
    meta: { errorPrefix: "Schedule not updated" },
    onSuccess: (s) => {
      toast.success(`${s.name} ${s.enabled ? "enabled" : "disabled"}`);
      refresh();
    },
  });
  const runNow = useMutation({
    mutationFn: (s: Schedule) => api.schedules.run(s.id),
    meta: { errorPrefix: "Run refused" },
    onSuccess: (r) => {
      toast.success(`Submitted job ${r.job_id.slice(0, 12)}…`);
      refresh();
      qc.invalidateQueries({ queryKey: ["schedule", r.schedule_id] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.schedules.remove(id),
    onSuccess: () => {
      toast.success("Schedule deleted");
      setToDelete(null);
      refresh();
    },
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Schedules"
        description={
          can("tenant.manage")
            ? "Every schedule in your organization. Jobs run as the schedule's owner, who must still hold the permission at each run."
            : "Your schedules. Jobs run as you, with the permissions you hold at each run."
        }
        actions={
          anyAllowed && (
            <Button variant="primary" onClick={() => setCreating("")}>
              New schedule
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <SelectField
          label="Job type"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          options={(types.data ?? []).map((t) => ({ value: t.job_type, label: jobTypeLabel(t.job_type) }))}
          placeholder="All job types"
          className="w-60"
        />
      </div>
      <Card bodyClassName="p-0">
        <QueryState
          query={list}
          loadingLabel="Loading schedules…"
          empty={(l) =>
            l.length ? null : (
              <div className="p-4">
                <EmptyState
                  title={filter ? "No schedules of this type" : "No schedules yet"}
                  action={
                    anyAllowed && (
                      <Button onClick={() => setCreating(filter)} variant="primary">
                        New schedule
                      </Button>
                    )
                  }
                >
                  {anyAllowed
                    ? "Deliver analytics and dashboards by email or chat, re-profile datasets, compact streams, re-apply pipelines, check drift or advance canary rollouts on a cron timetable."
                    : "Your role can't schedule any job type. Ask an admin for a role with analytics, dashboard, data or deployment permissions."}
                </EmptyState>
              </div>
            )
          }
        >
          {(schedules) => (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Schedules</caption>
                <thead className="bg-[var(--surface-2)] text-xs">
                  <tr>
                    <th scope="col" className="px-4 py-2">Name</th>
                    <th scope="col" className="px-4 py-2">Job</th>
                    <th scope="col" className="px-4 py-2">When</th>
                    <th scope="col" className="px-4 py-2">Next run</th>
                    <th scope="col" className="px-4 py-2">Last run</th>
                    <th scope="col" className="px-4 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.map((s) => (
                    <Fragment key={s.id}>
                      <tr className="border-t border-[var(--border)] align-top">
                        <td className="px-4 py-2">
                          <button type="button" className="text-left font-medium text-brand-700 hover:underline dark:text-brand-300" aria-expanded={expanded === s.id} onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                            {expanded === s.id ? "▾" : "▸"} {s.name}
                          </button>
                          {!s.enabled && (
                            <Badge tone="warning" className="ml-2">
                              disabled
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <Badge>{jobTypeLabel(s.job_type)}</Badge>
                        </td>
                        <td className="px-4 py-2">
                          {describeCron(s.cron)}
                          <span className="block text-xs text-[var(--text-2)]">
                            <code>{s.cron}</code> · {s.timezone}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-xs">{s.enabled ? formatDate(s.next_run_at) : "—"}</td>
                        <td className="px-4 py-2 text-xs">
                          {s.last_status ? (
                            <>
                              <Badge tone={lastStatusTone(s.last_status)}>{s.last_status}</Badge> {formatDate(s.last_run_at)}
                              {s.last_job_id && (
                                <Link href="/jobs" className="block underline">
                                  job {s.last_job_id.slice(0, 12)}…
                                </Link>
                              )}
                              {s.last_error && <span className="block max-w-xs text-red-700 dark:text-red-400">{s.last_error}</span>}
                            </>
                          ) : (
                            "never"
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-right">
                          <Button size="sm" onClick={() => runNow.mutate(s)} loading={runNow.isPending && runNow.variables?.id === s.id} aria-label={`Run ${s.name} now`}>
                            Run now
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => toggle.mutate(s)} aria-label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`}>
                            {s.enabled ? "Disable" : "Enable"}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}>
                            Edit
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setToDelete(s)} aria-label={`Delete ${s.name}`}>
                            Delete
                          </Button>
                        </td>
                      </tr>
                      {expanded === s.id && (
                        <tr className="border-t border-[var(--border)] bg-[var(--surface-2)]/40">
                          <td colSpan={6} className="px-4 py-3">
                            <ScheduleDetails id={s.id} />
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
      {creating !== null && types.data && <ScheduleForm types={types.data} initialJobType={creating || undefined} onClose={() => setCreating(null)} />}
      {editing && types.data && <ScheduleForm key={editing.id} types={types.data} existing={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!toDelete} onClose={() => setToDelete(null)} onConfirm={() => toDelete && remove.mutate(toDelete.id)} title="Delete schedule?" danger confirmLabel="Delete" loading={remove.isPending}>
        <p>
          <strong>{toDelete?.name}</strong> stops running. Jobs it already submitted are not affected.
        </p>
      </ConfirmDialog>
    </div>
  );
}

/** Next runs (from GET /v1/schedules/{id}) and the last result snapshot. */
function ScheduleDetails({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["schedule", id], queryFn: () => api.schedules.get(id) });
  if (q.isLoading) return <Spinner label="Loading schedule…" />;
  if (!q.data) return null;
  const s = q.data;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_1fr]">
      <section aria-label="Next runs">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-2)]">Next 5 runs</h3>
        <UpcomingRuns schedule={s} />
        <h3 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-2)]">Parameters</h3>
        <pre className="max-h-48 overflow-auto rounded bg-[var(--surface)] p-2 text-xs">{JSON.stringify(s.params, null, 2)}</pre>
      </section>
      <section aria-label="Last result">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-2)]">Last result</h3>
        <LastResult schedule={s} />
      </section>
    </div>
  );
}
