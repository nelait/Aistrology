"use client";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Connector, type ConnectorKind, type Job } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { CONFIG_FIELDS, CONNECTOR_KINDS, CREDENTIAL_FIELDS, buildConnectorBody, describeConfig, selectQueryError, type ConnectorField } from "@/lib/connectors";
import { formatDate } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { JobProgress } from "@/components/JobProgress";
import { RequirePermission } from "@/components/RequirePermission";
import { Badge, Button, Card, ConfirmDialog, EmptyState, Modal, PageHeader, QueryState, SelectField, TextArea, TextField } from "@/components/ui";

export default function ConnectorsPage() {
  return (
    <RequirePermission perm="data.read">
      <Connectors />
    </RequirePermission>
  );
}

function Connectors() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["connectors"], queryFn: api.connectors.list });
  const [createOpen, setCreateOpen] = useState(false);
  const [importing, setImporting] = useState<Connector | null>(null);
  const [toDelete, setToDelete] = useState<Connector | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.connectors.remove(id),
    onSuccess: () => {
      toast.success("Connector deleted");
      setToDelete(null);
      qc.invalidateQueries({ queryKey: ["connectors"] });
    },
  });
  const writer = can("data.write");

  return (
    <div className="space-y-5">
      <PageHeader
        title="Connectors"
        description="Import data from S3, Google Cloud Storage, PostgreSQL and MySQL. Each import creates a dataset (one table per object or query)."
        actions={
          writer && (
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              New connector
            </Button>
          )
        }
      />
      <Card bodyClassName="p-0">
        <QueryState
          query={list}
          empty={(l) =>
            l.length ? null : (
              <div className="p-4">
                <EmptyState title="No connectors yet" action={writer && <Button onClick={() => setCreateOpen(true)}>New connector</Button>}>
                  Credentials are written to the secret store and never shown again.
                </EmptyState>
              </div>
            )
          }
        >
          {(connectors) => (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Connectors</caption>
                <thead className="bg-[var(--surface-2)] text-xs">
                  <tr>
                    <th scope="col" className="px-4 py-2">Name</th>
                    <th scope="col" className="px-4 py-2">Kind</th>
                    <th scope="col" className="px-4 py-2">Location</th>
                    <th scope="col" className="px-4 py-2">Created</th>
                    <th scope="col" className="px-4 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {connectors.map((c) => (
                    <tr key={c.id} className="border-t border-[var(--border)]">
                      <td className="px-4 py-2 font-medium">{c.name}</td>
                      <td className="px-4 py-2">
                        <Badge>{c.kind}</Badge>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">{describeConfig(c.kind, c.config)}</td>
                      <td className="px-4 py-2 text-xs">
                        {formatDate(c.created_at)} · {c.created_by}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {writer && (
                          <>
                            <Button size="sm" onClick={() => setImporting(c)}>
                              Import…
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setToDelete(c)} aria-label={`Delete ${c.name}`}>
                              Delete
                            </Button>
                          </>
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
      {can("tenant.manage") && <AllowlistCard />}
      {createOpen && <CreateConnector onClose={() => setCreateOpen(false)} />}
      {importing && <ImportDialog connector={importing} onClose={() => setImporting(null)} />}
      <ConfirmDialog open={!!toDelete} onClose={() => setToDelete(null)} onConfirm={() => toDelete && remove.mutate(toDelete.id)} title="Delete connector?" danger confirmLabel="Delete" loading={remove.isPending}>
        <p>
          Deletes <strong>{toDelete?.name}</strong> and its stored credentials. Datasets already imported are kept.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function FieldInput({ f, value, onChange, secret }: { f: ConnectorField; value: string; onChange: (v: string) => void; secret?: boolean }) {
  if (f.type === "textarea")
    return <TextArea label={f.label + (f.required ? " *" : "")} mono rows={5} value={value} onChange={(e) => onChange(e.target.value)} hint={f.hint} autoComplete="off" spellCheck={false} />;
  return (
    <TextField
      label={f.label + (f.required ? " *" : "")}
      type={f.type === "password" ? "password" : f.type === "number" ? "number" : "text"}
      value={value}
      placeholder={f.placeholder}
      hint={f.hint}
      onChange={(e) => onChange(e.target.value)}
      autoComplete={secret ? "new-password" : "off"}
      required={f.required}
    />
  );
}

function CreateConnector({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ConnectorKind>("postgresql");
  const [values, setValues] = useState<Record<string, string>>({});
  const body = buildConnectorBody(kind, values);
  const create = useMutation({
    mutationFn: () => api.connectors.create({ name: name.trim(), kind, config: body.config, credentials: body.credentials }),
    meta: { errorPrefix: "Connector not created" },
    onSuccess: (c) => {
      setValues({}); // drop secrets from memory
      qc.invalidateQueries({ queryKey: ["connectors"] });
      toast.success(`Connector “${c.name}” created`);
      onClose();
    },
  });
  const set = (k: string) => (v: string) => setValues((x) => ({ ...x, [k]: v }));
  return (
    <Modal
      open
      onClose={onClose}
      title="New connector"
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim() || body.missing.length > 0}>
            Create
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !body.missing.length) create.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Name *" value={name} onChange={(e) => setName(e.target.value)} hint="Letters, digits, spaces, _ - ." required />
          <SelectField
            label="Kind"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as ConnectorKind);
              setValues({});
            }}
            options={CONNECTOR_KINDS.map((k) => ({ value: k.kind, label: k.label }))}
          />
        </div>
        <fieldset className="grid gap-3 rounded-md border border-[var(--border)] p-3 sm:grid-cols-2">
          <legend className="px-1 text-xs font-semibold">Connection</legend>
          {CONFIG_FIELDS[kind].map((f) => (
            <FieldInput key={f.name} f={f} value={values[f.name] ?? ""} onChange={set(f.name)} />
          ))}
        </fieldset>
        <fieldset className="grid gap-3 rounded-md border border-[var(--border)] p-3 sm:grid-cols-2">
          <legend className="px-1 text-xs font-semibold">Credentials (write-only)</legend>
          <p className="text-xs text-[var(--text-2)] sm:col-span-2">
            Stored in the secret manager and never returned by the API. Use a read-only account. Hosts on private networks must be allowlisted by an admin.
          </p>
          {CREDENTIAL_FIELDS[kind].map((f) => (
            <div key={f.name} className={f.type === "textarea" ? "sm:col-span-2" : undefined}>
              <FieldInput f={f} value={values[f.name] ?? ""} onChange={set(f.name)} secret />
            </div>
          ))}
        </fieldset>
        {body.missing.length > 0 && <p className="text-xs text-[var(--text-2)]">Required: {body.missing.join(", ")}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function ImportDialog({ connector, onClose }: { connector: Connector; onClose: () => void }) {
  const qc = useQueryClient();
  const storage = connector.kind === "s3" || connector.kind === "gcs";
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.projects.list(), meta: { silent: true } });
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [target, setTarget] = useState<"key" | "prefix">("key");
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("SELECT *\nFROM public.my_table\nLIMIT 1000");
  const [rowLimit, setRowLimit] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [done, setDone] = useState<Job | null>(null);
  const qError = storage ? null : selectQueryError(query);
  const start = useMutation({
    mutationFn: () =>
      api.connectors.import(connector.id, {
        name: name.trim() || undefined,
        project_id: projectId || undefined,
        ...(storage ? { [target]: path.trim() } : { query, row_limit: rowLimit ? Number(rowLimit) : undefined }),
      }),
    meta: { errorPrefix: "Import not started" },
    onSuccess: (j) => {
      setJob(j);
      setDone(null);
    },
  });
  const result = done?.result as { dataset_id?: string; version?: number; tables?: { name: string; row_count: number; size_bytes: number }[]; warnings?: string[] } | null | undefined;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Import from ${connector.name}`}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => start.mutate()} loading={start.isPending} disabled={(storage ? !path.trim() && target === "key" : !!qError) || (!!job && !done)}>
            {storage ? "Import" : "Run query & import"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Dataset name (optional)" value={name} onChange={(e) => setName(e.target.value)} placeholder={connector.name} />
          {(projects.data?.length ?? 0) > 1 && (
            <SelectField label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)} options={(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))} placeholder="Default" />
          )}
        </div>
        {storage ? (
          <>
            <fieldset className="flex gap-4 text-sm">
              <legend className="mb-1 text-xs font-medium text-[var(--text-2)]">Import</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name="target" className="accent-brand-600" checked={target === "key"} onChange={() => setTarget("key")} /> One object (key)
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="target" className="accent-brand-600" checked={target === "prefix"} onChange={() => setTarget("prefix")} /> Every object under a prefix (≤ 100, one table each)
              </label>
            </fieldset>
            <TextField label={target === "key" ? "Object key" : "Prefix"} value={path} onChange={(e) => setPath(e.target.value)} placeholder={target === "key" ? "exports/2025/orders.parquet" : "exports/2025/"} />
          </>
        ) : (
          <>
            <TextArea label="SELECT query" mono rows={8} value={query} onChange={(e) => setQuery(e.target.value)} error={qError} hint="Runs in a read-only transaction with a statement timeout; capped at the row limit and 1 GB." spellCheck={false} />
            <TextField className="max-w-xs" label="Row limit (optional)" type="number" min={1} value={rowLimit} onChange={(e) => setRowLimit(e.target.value)} />
          </>
        )}
        {job && (
          <JobProgress
            jobId={job.id}
            title="Import"
            onDone={(j) => {
              setDone(j);
              qc.invalidateQueries({ queryKey: ["datasets"] });
            }}
          />
        )}
        {done?.status === "succeeded" && result?.dataset_id && (
          <div className="space-y-1 text-sm" aria-live="polite">
            <p>
              ✓ Imported as{" "}
              <Link href={`/datasets/${result.dataset_id}?tab=schema`} className="font-medium text-brand-600 underline dark:text-brand-300">
                dataset v{result.version ?? 1}
              </Link>
            </p>
            {result.tables?.length ? <p className="text-xs text-[var(--text-2)]">{result.tables.map((t) => `${t.name}: ${t.row_count.toLocaleString()} rows`).join(" · ")}</p> : null}
            {result.warnings?.map((w, i) => (
              <p key={i} className="text-xs text-amber-800 dark:text-amber-300">
                ⚠ {w}
              </p>
            ))}
          </div>
        )}
        {done?.status === "failed" && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            Import failed: {done.error ?? "unknown error"}
          </p>
        )}
      </div>
    </Modal>
  );
}

function AllowlistCard() {
  const toast = useToast();
  const q = useQuery({ queryKey: ["connector-allowlist"], queryFn: api.connectors.allowlist });
  const [text, setText] = useState<string | null>(null);
  const value = text ?? (q.data?.hosts ?? []).join("\n");
  const save = useMutation({
    mutationFn: () =>
      api.connectors.putAllowlist(
        value
          .split(/[\n,]/)
          .map((h) => h.trim())
          .filter(Boolean),
      ),
    meta: { errorPrefix: "Allowlist not saved" },
    onSuccess: (r) => {
      setText(r.hosts.join("\n"));
      toast.success("Connector allowlist saved");
    },
  });
  return (
    <Card title="Private hosts allowlist (admin)">
      <p className="mb-2 text-sm text-[var(--text-2)]">
        Connectors can&apos;t reach private (RFC 1918) addresses unless listed here: hostnames, <code>*.suffix</code> wildcards or CIDR ranges. Loopback, link-local and metadata addresses stay blocked.
      </p>
      <QueryState query={q}>
        {() => (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
            className="space-y-2"
          >
            <TextArea label="Allowed hosts (one per line)" mono rows={4} value={value} onChange={(e) => setText(e.target.value)} placeholder={"db.internal.example.com\n*.corp.example.com\n10.20.0.0/16"} />
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save allowlist
            </Button>
          </form>
        )}
      </QueryState>
    </Card>
  );
}
