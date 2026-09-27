"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { Badge, Button, Card, CopyButton, Modal, MultiSelect, QueryState, StatusBadge, TextField } from "../ui";

const EVENTS = ["job.succeeded", "job.failed", "model.registered", "endpoint.threshold", "dataset.created", "pipeline.applied"];

function Deliveries({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["deliveries", id], queryFn: () => api.webhooks.deliveries(id) });
  const retry = useMutation({ mutationFn: api.webhooks.retry, onSuccess: () => q.refetch() });
  return (
    <QueryState query={q} empty={(l) => (l.length ? null : <p className="text-xs text-[var(--text-2)]">No deliveries yet.</p>)}>
      {(list) => (
        <ul className="space-y-1 text-xs">
          {list.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2">
              <StatusBadge status={d.status} />
              <span className="font-mono">{d.event}</span>
              {d.status_code ? <Badge>{d.status_code}</Badge> : null}
              <span className="text-[var(--text-2)]">{formatDate(d.created_at)}</span>
              {d.error && <span className="text-red-700 dark:text-red-400">{d.error}</span>}
              {d.status !== "succeeded" && (
                <Button size="sm" variant="ghost" onClick={() => retry.mutate(d.id)}>
                  Retry
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </QueryState>
  );
}

export function WebhooksTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["webhooks"], queryFn: api.webhooks.list });
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["job.succeeded", "job.failed"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.webhooks.create(url, events),
    onSuccess: (r) => {
      setOpen(false);
      setSecret(r.secret);
      setUrl("");
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
  });
  const remove = useMutation({
    mutationFn: api.webhooks.remove,
    onSuccess: () => {
      toast.success("Webhook deleted");
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
  });
  return (
    <Card title="Webhooks" actions={<Button size="sm" variant="primary" onClick={() => setOpen(true)}>Add webhook</Button>}>
      <p className="mb-3 text-xs text-[var(--text-2)]">
        Deliveries are signed: <code className="font-mono">X-AP-Signature: t=&lt;unix&gt;,v1=&lt;hex HMAC-SHA256(secret, t + &quot;.&quot; + body)&gt;</code>
      </p>
      <QueryState query={q} empty={(l) => (l.length ? null : <p className="text-sm text-[var(--text-2)]">No webhooks.</p>)}>
        {(hooks) => (
          <ul className="divide-y divide-[var(--border)]">
            {hooks.map((h) => (
              <li key={h.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 break-all font-mono text-sm">{h.url}</span>
                  {h.events.map((e) => (
                    <Badge key={e}>{e}</Badge>
                  ))}
                  <Button size="sm" variant="ghost" aria-expanded={expanded === h.id} onClick={() => setExpanded(expanded === h.id ? null : h.id)}>
                    Deliveries
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove.mutate(h.id)}>
                    Delete
                  </Button>
                </div>
                {expanded === h.id && (
                  <div className="mt-2">
                    <Deliveries id={h.id} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add webhook"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!url.startsWith("https://") || !events.length}>
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <TextField label="Endpoint URL" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/analytics" hint="Must use https://" />
          <MultiSelect label="Events" options={EVENTS.map((e) => ({ value: e, label: e }))} value={events} onChange={setEvents} />
        </div>
      </Modal>
      <Modal open={!!secret} onClose={() => setSecret(null)} title="Signing secret" footer={<Button variant="primary" onClick={() => setSecret(null)}>Done</Button>}>
        <p role="alert" className="mb-3 text-sm text-amber-900 dark:text-amber-200">⚠ Copy the signing secret now; it is shown only once.</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 break-all rounded bg-[var(--surface-2)] p-2 font-mono text-xs">{secret}</code>
          {secret && <CopyButton text={secret} />}
        </div>
      </Modal>
    </Card>
  );
}
