"use client";
/** Polls a job until it finishes (MT-003/004); shows progress, message and a cancel button. */
import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type Job } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { Button, ProgressBar, StatusBadge } from "./ui";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export function useJob(jobId: string | null | undefined, interval = 1500) {
  return useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api.jobs.get(jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data && TERMINAL.has(q.state.data.status) ? false : interval),
  });
}

export function JobProgress({ jobId, onDone, title }: { jobId: string; onDone?: (job: Job) => void; title?: string }) {
  const q = useJob(jobId);
  const job = q.data;
  const done = useRef(false);
  const cancel = useMutation({ mutationFn: () => api.jobs.cancel(jobId), onSuccess: () => q.refetch() });

  useEffect(() => {
    if (job && TERMINAL.has(job.status) && !done.current) {
      done.current = true;
      onDone?.(job);
    }
  }, [job, onDone]);

  if (!job) return <p className="text-sm text-[var(--text-2)]">Starting job…</p>;
  const running = !TERMINAL.has(job.status);
  const elapsed = job.started_at ? ((job.finished_at ? new Date(job.finished_at) : new Date()).getTime() - new Date(job.started_at).getTime()) / 1000 : null;
  return (
    <div className="space-y-2 rounded-md border border-[var(--border)] p-3" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{title ?? job.type}</span>
        <StatusBadge status={job.status} />
        <span className="text-xs text-[var(--text-2)]">{Math.round(job.progress * 100)}%{elapsed !== null ? ` · ${formatDuration(elapsed)}` : ""}</span>
        {running && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => cancel.mutate()} loading={cancel.isPending}>
            Cancel
          </Button>
        )}
      </div>
      <ProgressBar value={job.status === "succeeded" ? 1 : job.progress} label={`${title ?? job.type} progress`} />
      {job.message && <p className="text-xs text-[var(--text-2)]">{job.message}</p>}
      {job.error && <p className="text-xs text-red-700 dark:text-red-400">{job.error}</p>}
    </div>
  );
}
