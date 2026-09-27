"use client";
/** Slack / Teams chat destinations (NTF-003) and signed incoming webhooks (WHK-002). */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, API_URL, NOTIFICATION_KINDS, type InboundHook, type InboundHookCreate, type InboundHookWithSecret } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { computeSignature, curlExample, pythonExample, signatureHeaderValue } from "@/lib/hookSignature";
import { useToast } from "@/lib/toast";
import { SecretOnce } from "../SecretOnce";
import { Badge, Button, Card, CodeBlock, ConfirmDialog, EmptyState, Modal, MultiSelect, QueryState, SelectField, TabPanel, Tabs, TextArea, TextField } from "../ui";

const EVENT_OPTIONS = [{ value: "*", label: "* (all events)" }, ...NOTIFICATION_KINDS.map((k) => ({ value: k, label: k }))];

/** Host rules mirrored from the server (it re-validates and applies the SSRF guard). */
export function chatUrlError(kind: "slack" | "teams", url: string): string | null {
  if (!url.trim()) return "Enter the incoming-webhook URL";
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return "Not a valid URL";
  }
  if (u.protocol !== "https:") return "Must use https://";
  const host = u.hostname.toLowerCase();
  if (kind === "slack" && host !== "hooks.slack.com") return "Slack webhooks must be on hooks.slack.com";
  if (kind === "teams" && !host.endsWith(".webhook.office.com") && !host.endsWith(".logic.azure.com")) return "Teams webhooks must be on *.webhook.office.com or *.logic.azure.com";
  return null;
}

export function ChatDestinationsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["chat-destinations"], queryFn: api.access.chatDestinations });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ kind: "slack" as "slack" | "teams", name: "", url: "", events: ["job.failed", "endpoint.threshold"] as string[] });
  const [toDelete, setToDelete] = useState<string | null>(null);
  const urlError = form.url ? chatUrlError(form.kind, form.url) : null;
  const create = useMutation({
    mutationFn: () => api.access.createChatDestination({ ...form, name: form.name.trim(), url: form.url.trim() }),
    meta: { errorPrefix: "Destination not added" },
    onSuccess: () => {
      setOpen(false);
      setForm({ kind: "slack", name: "", url: "", events: ["job.failed", "endpoint.threshold"] });
      toast.success("Chat destination added");
      qc.invalidateQueries({ queryKey: ["chat-destinations"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.access.deleteChatDestination(id),
    onSuccess: () => {
      setToDelete(null);
      toast.success("Destination removed");
      qc.invalidateQueries({ queryKey: ["chat-destinations"] });
    },
  });
  return (
    <Card
      title="Chat destinations (Slack / Microsoft Teams)"
      actions={
        <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
          Add destination
        </Button>
      }
    >
      <QueryState query={q} empty={(l) => (l.length ? null : <EmptyState title="No chat destinations">Post notifications such as failed jobs or drift alerts to a Slack or Teams channel.</EmptyState>)}>
        {(list) => (
          <ul className="divide-y divide-[var(--border)]">
            {list.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <Badge tone="info">{d.kind === "slack" ? "Slack" : "Teams"}</Badge>
                <span className="font-medium">{d.name}</span>
                <span className="font-mono text-xs text-[var(--text-2)]">{d.host}</span>
                <span className="flex flex-1 flex-wrap gap-1">
                  {d.events.map((e) => (
                    <Badge key={e}>{e}</Badge>
                  ))}
                </span>
                <span className="text-xs text-[var(--text-2)]">{formatDate(d.created_at)}</span>
                <Button size="sm" variant="ghost" onClick={() => setToDelete(d.id)} aria-label={`Remove ${d.name}`}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add chat destination"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!form.name.trim() || !!chatUrlError(form.kind, form.url) || !form.events.length}>
              Add
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <SelectField
            label="Service"
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as "slack" | "teams" })}
            options={[
              { value: "slack", label: "Slack" },
              { value: "teams", label: "Microsoft Teams" },
            ]}
          />
          <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="#data-alerts" required />
          <TextField
            label="Incoming-webhook URL"
            type="password"
            autoComplete="off"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            placeholder={form.kind === "slack" ? "https://hooks.slack.com/services/…" : "https://….webhook.office.com/…"}
            error={urlError}
            hint="Stored in the secret manager and never shown again."
          />
          <MultiSelect label="Events" options={EVENT_OPTIONS} value={form.events} onChange={(v) => setForm({ ...form, events: v })} />
        </div>
      </Modal>
      <ConfirmDialog open={!!toDelete} onClose={() => setToDelete(null)} onConfirm={() => toDelete && remove.mutate(toDelete)} title="Remove destination?" danger confirmLabel="Remove" loading={remove.isPending}>
        <p>Notifications stop being posted to this channel and its webhook URL is deleted.</p>
      </ConfirmDialog>
    </Card>
  );
}

// -- Inbound hooks ---------------------------------------------------------------------------------

const SAMPLE_JSON = '[{"id": 1, "amount": 42.5}]';
const SAMPLE_CSV = "id,amount\n1,42.5\n";

function HookExamples({ hook }: { hook: InboundHook }) {
  const [tab, setTab] = useState("curl");
  const [format, setFormat] = useState<"json" | "csv">("json");
  const url = `${API_URL}${hook.path}`;
  const input = { url, body: format === "json" ? SAMPLE_JSON : SAMPLE_CSV, contentType: format === "json" ? ("application/json" as const) : ("text/csv" as const) };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          label="Example language"
          active={tab}
          onChange={setTab}
          tabs={[
            { id: "curl", label: "curl + openssl" },
            { id: "python", label: "Python" },
          ]}
        />
        <SelectField
          label="Body format"
          srOnlyLabel
          value={format}
          onChange={(e) => setFormat(e.target.value as "json" | "csv")}
          options={[
            { value: "json", label: "JSON rows" },
            { value: "csv", label: "CSV" },
          ]}
        />
      </div>
      <TabPanel id={tab} className="pt-1">
        <CodeBlock code={tab === "curl" ? curlExample(input) : pythonExample(input)} label={`${tab} example`} />
      </TabPanel>
      <p className="text-xs text-[var(--text-2)]">
        Sign <code>{"<unix timestamp>.<raw body>"}</code> with HMAC-SHA256 using the hook secret and send <code>X-AP-Signature: t=&lt;timestamp&gt;,v1=&lt;hex digest&gt;</code>. Signatures older than 5 minutes and replays are rejected (401). Bodies: CSV, a JSON array of rows or{" "}
        <code>{'{"rows": [...]}'}</code>, up to 50 MB. The response is 202 with the job.
      </p>
    </div>
  );
}

function SignTester() {
  const [secret, setSecret] = useState("");
  const [body, setBody] = useState(SAMPLE_JSON);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <details className="rounded-md border border-[var(--border)] p-3">
      <summary className="cursor-pointer text-sm font-medium">Compute a signature in the browser (for testing)</summary>
      <form
        className="mt-3 space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const t = Math.floor(Date.now() / 1000);
            setResult(signatureHeaderValue(t, await computeSignature(secret, t, body)));
            setError(null);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        <TextField label="Secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} hint="Computed locally with Web Crypto; never sent anywhere." />
        <TextArea label="Body (exact bytes)" mono rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
        <Button type="submit" size="sm" disabled={!secret}>
          Sign
        </Button>
        {error && <p className="text-xs text-red-700 dark:text-red-400">{error}</p>}
        {result && <CodeBlock code={`X-AP-Signature: ${result}`} label="Signature header (valid for 5 minutes)" />}
      </form>
    </details>
  );
}

export function InboundHooksTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["inbound-hooks"], queryFn: api.inboundHooks.list });
  const endpoints = useQuery({ queryKey: ["endpoints"], queryFn: api.endpoints.list, meta: { silent: true } });
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api.datasets.list(), meta: { silent: true } });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", action: "ingest" as "ingest" | "predict", endpoint: "", dataset_id: "", mode: "append" as "append" | "replace" });
  const [created, setCreated] = useState<InboundHookWithSecret | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<InboundHook | null>(null);
  const body = (): InboundHookCreate =>
    form.action === "predict" ? { name: form.name.trim(), action: "predict", endpoint: form.endpoint } : { name: form.name.trim(), action: "ingest", dataset_id: form.dataset_id, mode: form.mode };
  const create = useMutation({
    mutationFn: () => api.inboundHooks.create(body()),
    meta: { errorPrefix: "Hook not created" },
    onSuccess: (h) => {
      setOpen(false);
      setCreated(h);
      setForm({ name: "", action: "ingest", endpoint: "", dataset_id: "", mode: "append" });
      qc.invalidateQueries({ queryKey: ["inbound-hooks"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.inboundHooks.remove(id),
    onSuccess: () => {
      setToDelete(null);
      toast.success("Hook deactivated and its secret deleted");
      qc.invalidateQueries({ queryKey: ["inbound-hooks"] });
    },
  });
  const ready = !!form.name.trim() && (form.action === "predict" ? !!form.endpoint : !!form.dataset_id);
  const describe = (h: InboundHook) =>
    h.action === "predict" ? `score rows with endpoint ${h.config.endpoint}` : `${h.config.mode ?? "append"} rows into dataset ${datasets.data?.find((d) => d.id === h.config.dataset_id)?.name ?? h.config.dataset_id}`;
  return (
    <div className="space-y-4">
      <Card
        title="Incoming webhooks"
        actions={
          <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
            New hook
          </Button>
        }
      >
        <p className="mb-3 text-sm text-[var(--text-2)]">Let external systems push rows without credentials: every request must be signed with the hook&apos;s secret. Each call starts a job (batch prediction or a new dataset version).</p>
        <QueryState query={q} empty={(l) => (l.length ? null : <EmptyState title="No incoming webhooks">Create one to ingest rows into a dataset or score them with an endpoint.</EmptyState>)}>
          {(hooks) => (
            <ul className="divide-y divide-[var(--border)]">
              {hooks.map((h) => (
                <li key={h.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{h.name}</span>
                    <Badge tone="info">{h.action}</Badge>
                    {h.active ? <Badge tone="good">active</Badge> : <Badge>inactive</Badge>}
                    <span className="flex-1 text-xs text-[var(--text-2)]">
                      {describe(h)} · last triggered {h.last_triggered_at ? formatDate(h.last_triggered_at) : "never"}
                    </span>
                    {h.active && (
                      <>
                        <Button size="sm" variant="ghost" aria-expanded={expanded === h.id} onClick={() => setExpanded(expanded === h.id ? null : h.id)}>
                          Example request
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setToDelete(h)} aria-label={`Deactivate ${h.name}`}>
                          Deactivate
                        </Button>
                      </>
                    )}
                  </div>
                  <code className="mt-1 block break-all font-mono text-xs text-[var(--text-2)]">POST {API_URL}{h.path}</code>
                  {expanded === h.id && (
                    <div className="mt-2">
                      <HookExamples hook={h} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Card>
      <SignTester />
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New incoming webhook"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!ready}>
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <SelectField
            label="Action"
            value={form.action}
            onChange={(e) => setForm({ ...form, action: e.target.value as "ingest" | "predict" })}
            options={[
              { value: "ingest", label: "Ingest: create the next version of a dataset" },
              { value: "predict", label: "Predict: batch-score the rows with an endpoint" },
            ]}
          />
          {form.action === "predict" ? (
            <SelectField label="Endpoint" value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} options={(endpoints.data ?? []).map((e) => ({ value: e.name, label: e.name }))} placeholder="Choose…" hint="Fetch results with GET /v1/endpoints/{name}/batch/{job_id}" />
          ) : (
            <>
              <SelectField
                label="Dataset (single table)"
                value={form.dataset_id}
                onChange={(e) => setForm({ ...form, dataset_id: e.target.value })}
                options={(datasets.data ?? []).filter((d) => d.tables.length <= 1).map((d) => ({ value: d.id, label: d.name }))}
                placeholder="Choose…"
              />
              <SelectField
                label="Mode"
                value={form.mode}
                onChange={(e) => setForm({ ...form, mode: e.target.value as "append" | "replace" })}
                options={[
                  { value: "append", label: "Append rows" },
                  { value: "replace", label: "Replace the contents" },
                ]}
              />
            </>
          )}
        </div>
      </Modal>
      <SecretOnce
        open={!!created}
        onClose={() => setCreated(null)}
        title="Incoming webhook created"
        secrets={created ? [{ label: "Signing secret", value: created.secret }, { label: "URL", value: `${API_URL}${created.path}` }] : []}
      >
        {created && <HookExamples hook={created} />}
      </SecretOnce>
      <ConfirmDialog open={!!toDelete} onClose={() => setToDelete(null)} onConfirm={() => toDelete && remove.mutate(toDelete.id)} title="Deactivate hook?" danger confirmLabel="Deactivate" loading={remove.isPending}>
        <p>Requests to “{toDelete?.name}” will be rejected and its secret is deleted. This can&apos;t be undone.</p>
      </ConfirmDialog>
    </div>
  );
}
