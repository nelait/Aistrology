"use client";
/** ING-008 stream datasets: create dialog, buffer status, compact now, curl example and a test-record form. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DatasetRecord } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatBytes, formatDate, formatNumber, formatPercent } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { JobProgress } from "../JobProgress";
import { Badge, Button, Card, CodeBlock, KeyValue, Modal, ProgressBar, QueryState, SelectField, StatTile, TextArea, TextField } from "../ui";

export function CreateStreamDialog({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId?: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.projects.list(), enabled: open, meta: { silent: true } });
  const [name, setName] = useState("");
  const [project, setProject] = useState(projectId ?? "");
  const [columns, setColumns] = useState("");
  const [rows, setRows] = useState("");
  const [mb, setMb] = useState("");
  const cols = columns
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const dupCols = cols.length !== new Set(cols).size;
  const create = useMutation({
    mutationFn: () =>
      api.streams.create({
        name: name.trim(),
        project_id: project || undefined,
        columns: cols.length ? cols : undefined,
        compact_rows: rows ? Number(rows) : undefined,
        compact_bytes: mb ? Math.round(Number(mb) * 1024 * 1024) : undefined,
      }),
    meta: { errorPrefix: "Stream not created" },
    onSuccess: (d) => {
      toast.success(`Stream “${d.name}” created`);
      qc.invalidateQueries({ queryKey: ["datasets"] });
      onClose();
      router.push(`/datasets/${d.id}?tab=stream`);
    },
  });
  const rowsErr = rows && !(Number.isInteger(Number(rows)) && Number(rows) >= 1) ? "A whole number ≥ 1" : null;
  const mbErr = mb && !(Number(mb) >= 0.001 && Number(mb) <= 1024) ? "Between 0.001 and 1024 MB" : null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New stream dataset"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim() || dupCols || !!rowsErr || !!mbErr}>
            Create stream
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <p className="text-sm text-[var(--text-2)]">An append-only dataset fed by JSON records over HTTP. Records are buffered and compacted into immutable versions.</p>
        <TextField label="Name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        {(projects.data?.length ?? 0) > 1 && (
          <SelectField label="Project" value={project} onChange={(e) => setProject(e.target.value)} options={(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))} placeholder="Default project" />
        )}
        <TextField label="Initial columns (optional)" value={columns} onChange={(e) => setColumns(e.target.value)} placeholder="event, user_id, value" hint="Comma-separated. New keys in records add columns automatically." error={dupCols ? "Column names must be unique" : null} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Compact after rows" type="number" min={1} value={rows} onChange={(e) => setRows(e.target.value)} placeholder="10000 (default)" error={rowsErr} />
          <TextField label="…or after buffered MB" type="number" min={0.001} step="any" value={mb} onChange={(e) => setMb(e.target.value)} placeholder="16 (default)" error={mbErr} />
        </div>
      </form>
    </Modal>
  );
}

const EXAMPLE_RECORDS = '[\n  {"event": "signup", "user_id": 42, "value": 1.5, "ok": true}\n]';

export function StreamTab({ dataset }: { dataset: DatasetRecord }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const writer = can("data.write");
  const status = useQuery({ queryKey: ["stream", dataset.id], queryFn: () => api.streams.get(dataset.id), refetchInterval: 10_000 });
  const [jobId, setJobId] = useState<string | null>(null);
  const [records, setRecords] = useState(EXAMPLE_RECORDS);
  const [parseError, setParseError] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["stream", dataset.id] });
    qc.invalidateQueries({ queryKey: ["dataset", dataset.id] });
  };
  const compact = useMutation({
    mutationFn: () => api.streams.compact(dataset.id),
    meta: { errorPrefix: "Compaction not started" },
    onSuccess: (j) => {
      setJobId(j.id);
      toast.success("Compaction queued");
    },
  });
  const push = useMutation({
    mutationFn: (rows: Record<string, unknown>[]) => api.streams.push(dataset.id, rows),
    meta: { errorPrefix: "Records rejected" },
    onSuccess: (r) => {
      toast.success(`${r.accepted} record(s) buffered`);
      if (r.compaction_job_id) setJobId(r.compaction_job_id);
      refresh();
    },
  });
  const send = () => {
    try {
      const v = JSON.parse(records) as unknown;
      const rows = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { records?: unknown }).records) ? (v as { records: unknown[] }).records : [v];
      if (!rows.length) throw new Error("Add at least one record");
      if (!rows.every((r) => r && typeof r === "object" && !Array.isArray(r))) throw new Error("Each record must be a flat JSON object");
      const nested = rows.find((r) => Object.values(r as Record<string, unknown>).some((x) => x !== null && typeof x === "object"));
      if (nested) throw new Error("Values must be strings, numbers, booleans or null (no nested objects or arrays)");
      setParseError(null);
      push.mutate(rows as Record<string, unknown>[]);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Invalid JSON");
    }
  };

  const url = api.streams.recordsUrl(dataset.id);
  const curl = `curl -X POST '${url}' \\\n  -H 'X-API-Key: ap_live_…' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"records": [{"event": "signup", "user_id": 42, "value": 1.5}]}'`;

  return (
    <div className="space-y-4">
      <QueryState query={status} loadingLabel="Loading stream status…">
        {(s) => (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatTile label="Buffered rows" value={formatNumber(s.buffered_rows)} sub={`${s.buffered_batches} batch(es) · compacts at ${formatNumber(s.compact_rows)}`} />
              <StatTile label="Buffered size" value={formatBytes(s.buffered_bytes)} sub={`compacts at ${formatBytes(s.compact_bytes)}`} />
              <StatTile label="Stored" value={formatNumber(s.stored_rows)} sub={`rows · v${s.version} · ${formatBytes(s.stored_bytes)}`} />
              <StatTile label="Last compaction" value={s.last_compacted_at ? formatDate(s.last_compacted_at) : "never"} sub={s.compacting_job_id ? "compaction running…" : undefined} />
            </div>
            <Card
              title="Buffer"
              actions={
                writer && (
                  <Button size="sm" variant="primary" onClick={() => compact.mutate()} loading={compact.isPending} disabled={!!s.compacting_job_id || s.buffered_rows === 0}>
                    Compact now
                  </Button>
                )
              }
            >
              <div className="space-y-2">
                <div>
                  <p className="mb-1 text-xs text-[var(--text-2)]">Rows until automatic compaction ({formatPercent(s.buffered_rows / Math.max(1, s.compact_rows), 0)})</p>
                  <ProgressBar value={s.buffered_rows / Math.max(1, s.compact_rows)} label="Buffered rows relative to the compaction threshold" />
                </div>
                <div>
                  <p className="mb-1 text-xs text-[var(--text-2)]">
                    Dataset size limit: {formatBytes(s.stored_bytes + s.buffered_bytes)} of {formatBytes(s.max_dataset_bytes)}
                  </p>
                  <ProgressBar value={(s.stored_bytes + s.buffered_bytes) / Math.max(1, s.max_dataset_bytes)} label="Stored plus buffered bytes relative to the dataset limit" />
                </div>
                <KeyValue
                  items={[
                    ["Compaction", "Folds the buffer into the next immutable version. Columns whose values mix kinds are stored as strings."],
                    ["Automate", <span key="a">Schedule it: <Link href={`/schedules?new=stream.compact`} className="underline">Schedules → Stream compaction</Link></span>],
                  ]}
                />
              </div>
              {(jobId || s.compacting_job_id) && (
                <div className="mt-3">
                  <JobProgress
                    jobId={(jobId ?? s.compacting_job_id)!}
                    title="Compaction"
                    onDone={(j) => {
                      setJobId(null);
                      refresh();
                      if (j.status === "succeeded") toast.success("Compaction finished");
                    }}
                  />
                </div>
              )}
            </Card>
          </>
        )}
      </QueryState>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Send records from your code">
          <CodeBlock code={curl} label="curl example" />
          <p className="mt-2 text-xs text-[var(--text-2)]">
            Needs data.write, for example an API key with that scope (<Link href="/admin?tab=keys" className="underline">Admin → API keys</Link>). Up to 10,000 flat JSON objects and 10 MB per call; the body can also be a bare
            array. Returns 202 with the buffer size; 413 once the dataset would exceed 1 GB.
          </p>
        </Card>
        {writer && (
          <Card title="Send test records">
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <TextArea label="Records (JSON array of flat objects)" mono rows={7} value={records} onChange={(e) => setRecords(e.target.value)} error={parseError} spellCheck={false} />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" variant="primary" loading={push.isPending}>
                  Send
                </Button>
                {push.data && (
                  <span className="text-xs" aria-live="polite">
                    <Badge tone="good">{push.data.accepted} accepted</Badge> buffer: {formatNumber(push.data.buffered_rows)} rows, {formatBytes(push.data.buffered_bytes)}
                  </span>
                )}
              </div>
            </form>
          </Card>
        )}
      </div>
    </div>
  );
}
