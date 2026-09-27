"use client";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, type Job } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { saveBlob } from "@/lib/data";
import { useToast } from "@/lib/toast";
import { JobProgress } from "../JobProgress";
import { Button, Card, ConfirmDialog } from "../ui";

/** Data export (SOC-PRV-003) and organization deletion (MT-010 / SOC-PRV-004). */
export function DataTab() {
  const { me, logout } = useAuth();
  const toast = useToast();
  const [job, setJob] = useState<Job | null>(null);
  const [confirm, setConfirm] = useState(false);
  const request = useMutation({ mutationFn: api.tenant.requestExport, onSuccess: setJob });
  const download = useMutation({
    mutationFn: () => api.tenant.downloadExport(job!.id),
    onSuccess: ({ blob, filename }) => saveBlob(blob, filename ?? `export-${job!.id}.zip`),
  });
  const del = useMutation({
    mutationFn: () => api.tenant.remove(me!.tenant_id),
    onSuccess: async () => {
      toast.success("Organization scheduled for deletion");
      await logout();
    },
  });
  return (
    <div className="space-y-5">
      <Card title="Export all data">
        <p className="mb-3 text-sm text-[var(--text-2)]">Creates a ZIP archive of every dataset, pipeline, model, dashboard and the audit log. Large organizations can take a while.</p>
        <Button variant="primary" onClick={() => request.mutate()} loading={request.isPending}>
          Request export
        </Button>
        {job && (
          <div className="mt-4 space-y-2">
            <JobProgress jobId={job.id} title="Data export" onDone={setJob} />
            {job.status === "succeeded" && (
              <Button onClick={() => download.mutate()} loading={download.isPending}>
                Download ZIP
              </Button>
            )}
          </div>
        )}
      </Card>
      <Card title="Danger zone" className="border-red-300 dark:border-red-900">
        <p className="mb-3 text-sm">
          Deleting the organization removes all users, data, models and endpoints, and crypto-shreds its encryption key. <strong>This cannot be undone.</strong>
        </p>
        <Button variant="danger" onClick={() => setConfirm(true)}>
          Delete organization
        </Button>
      </Card>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => del.mutate()} title="Delete organization?" danger confirmLabel="Delete everything" typedConfirmation={me?.tenant_id ?? ""} loading={del.isPending}>
        <p>All data will be permanently destroyed. Export it first if you need a copy.</p>
      </ConfirmDialog>
    </div>
  );
}
