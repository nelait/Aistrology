"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type DatasetRecord } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { eta, formatBytes, formatDate, formatDuration } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { MAX_DATASET_BYTES, TOO_LARGE_MESSAGE } from "@/lib/constants";
import { FileDrop } from "@/components/FileDrop";
import { Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader, ProgressBar, QueryState } from "@/components/ui";


const ACCEPT = ".csv,.tsv,.txt,.json,.jsonl,.ndjson,.parquet,.xlsx,.xls,.xml,.gz,.zip,.avro,.orc";
const CONCURRENCY = 2;

interface UploadItem {
  key: string;
  file: File;
  status: "queued" | "uploading" | "processing" | "done" | "error" | "cancelled";
  loaded: number;
  total: number;
  started?: number;
  error?: string;
  dataset?: DatasetRecord;
  warnings?: string[];
  abort?: AbortController;
}

export default function DatasetsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const welcome = useSearchParams().get("welcome") === "1";
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: api.datasets.list });
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [toDelete, setToDelete] = useState<DatasetRecord | null>(null);
  const [, force] = useState(0);
  const active = useRef(0);
  const queue = useRef<UploadItem[]>([]);

  const patch = useCallback((key: string, p: Partial<UploadItem>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x))), []);

  const pump = useCallback(() => {
    while (active.current < CONCURRENCY && queue.current.length) {
      const item = queue.current.shift()!;
      active.current++;
      const abort = new AbortController();
      patch(item.key, { status: "uploading", started: Date.now(), abort });
      api.datasets
        .upload(
          item.file,
          (p) => {
            patch(item.key, { loaded: p.loaded, total: p.total || item.file.size, status: p.total && p.loaded >= p.total ? "processing" : "uploading" });
            force((n) => n + 1);
          },
          abort.signal,
        )
        .then((res) => {
          patch(item.key, { status: "done", dataset: res.dataset, warnings: res.inference?.warnings ?? [] });
          if (res.inference) qc.setQueryData(["inference", res.dataset.id], res.inference);
          qc.invalidateQueries({ queryKey: ["datasets"] });
          toast.success(`Uploaded ${item.file.name}`);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") patch(item.key, { status: "cancelled" });
          else {
            const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Upload failed";
            patch(item.key, { status: "error", error: msg });
            toast.error(`${item.file.name}: ${msg}`);
          }
        })
        .finally(() => {
          active.current--;
          pump();
        });
    }
  }, [patch, qc, toast]);

  const addFiles = (files: File[]) => {
    const items: UploadItem[] = files.map((file, i) => {
      const key = `${Date.now()}-${i}-${file.name}`;
      if (file.size > MAX_DATASET_BYTES) return { key, file, status: "error", loaded: 0, total: file.size, error: `${file.name}: ${TOO_LARGE_MESSAGE}` };
      if (file.size === 0) return { key, file, status: "error", loaded: 0, total: 0, error: "File is empty" };
      return { key, file, status: "queued", loaded: 0, total: file.size };
    });
    items.filter((i) => i.status === "error").forEach((i) => toast.error(i.error!));
    setUploads((u) => [...items, ...u]);
    queue.current.push(...items.filter((i) => i.status === "queued"));
    pump();
  };

  const del = useMutation({
    mutationFn: (id: string) => api.datasets.remove(id),
    onSuccess: () => {
      toast.success("Dataset deleted");
      setToDelete(null);
      qc.invalidateQueries({ queryKey: ["datasets"] });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Datasets"
        description="Upload files, review inferred schemas, profile, query and clean your data."
        actions={
          can("data.write") && (
            <Link href="/generate" className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-sm font-medium hover:bg-[var(--surface-2)]">
              Generate sample data
            </Link>
          )
        }
      />

      {welcome && (
        <Card title="Welcome! Let's set up your first project">
          <ol className="grid gap-3 text-sm sm:grid-cols-3">
            <li className="rounded-md border border-[var(--border)] p-3">
              <p className="font-medium">1. Bring data</p>
              <p className="text-[var(--text-2)]">Upload a CSV/Excel/JSON/Parquet file below, or generate realistic sample data from a schema.</p>
            </li>
            <li className="rounded-md border border-[var(--border)] p-3">
              <p className="font-medium">2. Review &amp; explore</p>
              <p className="text-[var(--text-2)]">Confirm the inferred schema, check the quality profile, and ask for AI-suggested analytics.</p>
            </li>
            <li className="rounded-md border border-[var(--border)] p-3">
              <p className="font-medium">3. Share insights</p>
              <p className="text-[var(--text-2)]">Save analytics, build a dashboard, and invite teammates from Admin.</p>
            </li>
          </ol>
        </Card>
      )}

      {can("data.write") && (
        <section aria-labelledby="upload-h" className="space-y-3">
          <h2 id="upload-h" className="sr-only">
            Upload
          </h2>
          <FileDrop onFiles={addFiles} accept={ACCEPT} label="Drag and drop data files here" hint="CSV, TSV, JSON/JSONL, Excel, Parquet, XML — up to 1 GB each. Several files upload in parallel." />
          {uploads.length > 0 && (
            <Card
              title="Uploads"
              actions={
                <Button size="sm" variant="ghost" onClick={() => setUploads((u) => u.filter((x) => x.status === "queued" || x.status === "uploading" || x.status === "processing"))}>
                  Clear finished
                </Button>
              }
            >
              <ul className="space-y-3">
                {uploads.map((u) => {
                  const pct = u.total ? u.loaded / u.total : 0;
                  const secs = u.started ? eta(u.loaded, u.total, (Date.now() - u.started) / 1000) : null;
                  return (
                    <li key={u.key} className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1 truncate font-medium">{u.file.name}</span>
                        <span className="text-xs text-[var(--text-2)]">{formatBytes(u.file.size)}</span>
                        {u.status === "uploading" && (
                          <span className="text-xs text-[var(--text-2)]">
                            {Math.round(pct * 100)}%{secs !== null ? ` · ${formatDuration(secs)} left` : ""}
                          </span>
                        )}
                        {u.status === "processing" && <Badge tone="info">Inferring schema…</Badge>}
                        {u.status === "queued" && <Badge>Queued</Badge>}
                        {u.status === "done" && <Badge tone="good">✓ Done</Badge>}
                        {u.status === "cancelled" && <Badge tone="warning">Cancelled</Badge>}
                        {u.status === "error" && <Badge tone="critical">✕ Failed</Badge>}
                        {(u.status === "uploading" || u.status === "queued") && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              if (u.status === "queued") {
                                queue.current = queue.current.filter((q) => q.key !== u.key);
                                patch(u.key, { status: "cancelled" });
                              } else u.abort?.abort();
                            }}
                            aria-label={`Cancel upload of ${u.file.name}`}
                          >
                            Cancel
                          </Button>
                        )}
                        {u.status === "done" && u.dataset && (
                          <Button size="sm" variant="primary" onClick={() => router.push(`/datasets/${u.dataset!.id}?tab=schema`)}>
                            Review schema
                          </Button>
                        )}
                      </div>
                      {(u.status === "uploading" || u.status === "processing") && <ProgressBar value={u.status === "processing" ? 1 : pct} label={`Upload progress for ${u.file.name}`} />}
                      {u.error && <p className="text-xs text-red-700 dark:text-red-400">{u.error}</p>}
                      {u.warnings?.map((w, i) => (
                        <p key={i} className="text-xs text-amber-800 dark:text-amber-300">
                          ⚠ {w}
                        </p>
                      ))}
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </section>
      )}

      <Card title="All datasets" bodyClassName="p-0">
        <QueryState
          query={datasets}
          empty={(d) =>
            d.length ? null : (
              <div className="p-4">
                <EmptyState title="No datasets yet">Upload a file above or generate sample data to get started.</EmptyState>
              </div>
            )
          }
        >
          {(list) => (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Datasets</caption>
                <thead className="bg-[var(--surface-2)] text-xs text-[var(--text-2)]">
                  <tr>
                    <th scope="col" className="px-4 py-2">Name</th>
                    <th scope="col" className="px-4 py-2">Version</th>
                    <th scope="col" className="px-4 py-2">Source</th>
                    <th scope="col" className="px-4 py-2">Tables</th>
                    <th scope="col" className="px-4 py-2 text-right">Size</th>
                    <th scope="col" className="px-4 py-2">Created</th>
                    <th scope="col" className="px-4 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((d) => (
                    <tr key={d.id} className="border-t border-[var(--border)]">
                      <td className="px-4 py-2">
                        <Link href={`/datasets/${d.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">
                          {d.name}
                        </Link>
                        {!d.schema?.entities?.length && <Badge tone="warning" className="ml-2">schema not confirmed</Badge>}
                      </td>
                      <td className="px-4 py-2">v{d.latest_version ?? d.version}</td>
                      <td className="px-4 py-2">{d.source}</td>
                      <td className="px-4 py-2 text-xs">{d.tables.map((t) => `${t.name} (${t.format}${t.row_count ? `, ${t.row_count.toLocaleString()} rows` : ""})`).join(", ")}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{formatBytes(d.size_bytes)}</td>
                      <td className="px-4 py-2 text-xs">{formatDate(d.created_at)}</td>
                      <td className="px-4 py-2 text-right">
                        {can("data.write") && (
                          <Button size="sm" variant="ghost" onClick={() => setToDelete(d)} aria-label={`Delete ${d.name}`}>
                            Delete
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryState>
      </Card>

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
        title="Delete dataset?"
        confirmLabel="Delete"
        danger
        loading={del.isPending}
      >
        <p>
          This permanently deletes <strong>{toDelete?.name}</strong> and all its versions.
        </p>
      </ConfirmDialog>
    </div>
  );
}
