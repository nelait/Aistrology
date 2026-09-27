"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ROLES, type ApiKeyWithSecret, type PermissionName, type Role } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { ALL_PERMISSIONS, ROLE_LABELS, ROLE_PERMISSIONS } from "@/lib/rbac";
import { useToast } from "@/lib/toast";
import { Badge, Button, Card, ConfirmDialog, CopyButton, Modal, MultiSelect, QueryState, SelectField, TextField } from "../ui";

/** API keys (MGT-001/002/007): create → shown once, rotate, revoke. */
export function ApiKeysTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["api-keys"], queryFn: api.tenant.apiKeys });
  const [createOpen, setCreateOpen] = useState(false);
  const [secret, setSecret] = useState<ApiKeyWithSecret | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", role: "data_scientist" as Role, scopes: [] as string[], rate: "600", expires: "", ips: "" });

  const create = useMutation({
    mutationFn: () =>
      api.tenant.createApiKey({
        name: form.name,
        role: form.role,
        scopes: form.scopes as PermissionName[],
        rate_limit_per_minute: Number(form.rate) || 600,
        expires_in_days: form.expires ? Number(form.expires) : undefined,
        allowed_ips: form.ips
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    onSuccess: (k) => {
      setCreateOpen(false);
      setSecret(k);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
  const rotate = useMutation({
    mutationFn: (id: string) => api.tenant.rotateApiKey(id),
    onSuccess: (k) => {
      setSecret(k);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.tenant.revokeApiKey(id),
    onSuccess: () => {
      toast.success("Key revoked");
      setRevoking(null);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const scopeOptions = ALL_PERMISSIONS.filter((p) => ROLE_PERMISSIONS[form.role].has(p)).map((p) => ({ value: p, label: p }));

  return (
    <Card
      title="API keys"
      bodyClassName="p-0 overflow-x-auto"
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
          Create key
        </Button>
      }
    >
      <QueryState query={q} empty={(l) => (l.length ? null : <p className="p-4 text-sm text-[var(--text-2)]">No API keys yet.</p>)}>
        {(keys) => (
          <table className="w-full text-left text-sm">
            <caption className="sr-only">API keys</caption>
            <thead className="bg-[var(--surface-2)] text-xs text-[var(--text-2)]">
              <tr>
                <th scope="col" className="px-3 py-2">Name</th>
                <th scope="col" className="px-3 py-2">Key</th>
                <th scope="col" className="px-3 py-2">Role / scopes</th>
                <th scope="col" className="px-3 py-2">Rate limit</th>
                <th scope="col" className="px-3 py-2">Last used</th>
                <th scope="col" className="px-3 py-2">Expires</th>
                <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-t border-[var(--border)]">
                  <td className="px-3 py-2">
                    {k.name} {k.revoked_at && <Badge tone="critical">revoked</Badge>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{k.prefix}…</td>
                  <td className="px-3 py-2 text-xs">
                    {ROLE_LABELS[k.role] ?? k.role}
                    {k.scopes.length ? <span className="block text-[var(--text-2)]">{k.scopes.join(", ")}</span> : null}
                    {k.allowed_ips.length ? <span className="block text-[var(--text-2)]">IPs: {k.allowed_ips.join(", ")}</span> : null}
                  </td>
                  <td className="px-3 py-2 text-xs">{k.rate_limit_per_minute}/min</td>
                  <td className="px-3 py-2 text-xs">{formatDate(k.last_used_at)}</td>
                  <td className="px-3 py-2 text-xs">{k.expires_at ? formatDate(k.expires_at) : "never"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {!k.revoked_at && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => rotate.mutate(k.id)} loading={rotate.isPending && rotate.variables === k.id}>
                          Rotate
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRevoking(k.id)}>
                          Revoke
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </QueryState>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create API key"
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!form.name.trim()}>
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="CI pipeline" />
          <SelectField label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role, scopes: [] })} options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
          <MultiSelect label="Scopes (optional narrowing)" hint="Empty = all permissions of the role." options={scopeOptions} value={form.scopes} onChange={(scopes) => setForm({ ...form, scopes })} maxHeight={140} />
          <div className="grid grid-cols-2 gap-3">
            <TextField label="Rate limit / minute" type="number" min={1} value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} />
            <TextField label="Expires in (days)" type="number" min={1} value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })} placeholder="never" />
          </div>
          <TextField label="Allowed IPs / CIDRs" hint="Comma-separated; empty = any" value={form.ips} onChange={(e) => setForm({ ...form, ips: e.target.value })} />
        </div>
      </Modal>

      <Modal open={!!secret} onClose={() => setSecret(null)} title="Your new API key" footer={<Button variant="primary" onClick={() => setSecret(null)}>I&apos;ve saved it</Button>}>
        <p role="alert" className="mb-3 rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          ⚠ Copy this key now. It is shown only once and can&apos;t be recovered.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 break-all rounded bg-[var(--surface-2)] p-2 font-mono text-xs">{secret?.key}</code>
          {secret && <CopyButton text={secret.key} />}
        </div>
      </Modal>

      <ConfirmDialog open={!!revoking} onClose={() => setRevoking(null)} onConfirm={() => revoking && revoke.mutate(revoking)} title="Revoke API key?" danger confirmLabel="Revoke" loading={revoke.isPending}>
        <p>Requests using this key will be rejected immediately.</p>
      </ConfirmDialog>
    </Card>
  );
}
