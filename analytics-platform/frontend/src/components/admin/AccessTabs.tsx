"use client";
/** Access management: OAuth clients (MGT-004a), network policy (MGT-007), SCIM token (AUTH-001a), teams (AUTH-004). */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, API_URL, ROLES, type OAuthClient, type OAuthClientWithSecret, type PermissionName, type Role, type Team } from "@/lib/api";
import { parseCidrList, policyWarnings } from "@/lib/cidr";
import { formatDate } from "@/lib/format";
import { ALL_PERMISSIONS, ROLE_LABELS, ROLE_PERMISSIONS } from "@/lib/rbac";
import { useToast } from "@/lib/toast";
import { SecretOnce } from "../SecretOnce";
import { Badge, Button, Card, CodeBlock, ConfirmDialog, EmptyState, KeyValue, Modal, MultiSelect, QueryState, SelectField, TextArea, TextField } from "../ui";

// -- OAuth clients ----------------------------------------------------------------------------

export function OAuthClientsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["oauth-clients"], queryFn: api.access.oauthClients });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", role: "data_scientist" as Role, scopes: [] as string[] });
  const [created, setCreated] = useState<OAuthClientWithSecret | null>(null);
  const [revoking, setRevoking] = useState<OAuthClient | null>(null);
  const create = useMutation({
    mutationFn: () => api.access.createOAuthClient({ name: form.name.trim(), role: form.role, scopes: form.scopes as PermissionName[] }),
    meta: { errorPrefix: "OAuth client not created" },
    onSuccess: (c) => {
      setOpen(false);
      setCreated(c);
      setForm({ name: "", role: "data_scientist", scopes: [] });
      qc.invalidateQueries({ queryKey: ["oauth-clients"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.access.revokeOAuthClient(id),
    onSuccess: () => {
      toast.success("Client revoked; its tokens stop working immediately");
      setRevoking(null);
      qc.invalidateQueries({ queryKey: ["oauth-clients"] });
    },
  });
  const scopeOptions = ALL_PERMISSIONS.filter((p) => ROLE_PERMISSIONS[form.role].has(p)).map((p) => ({ value: p, label: p }));
  const tokenUrl = `${API_URL}${created?.token_url ?? "/oauth/token"}`;
  return (
    <Card
      title="OAuth 2.0 clients (client credentials)"
      bodyClassName="p-0 overflow-x-auto"
      actions={
        <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
          New client
        </Button>
      }
    >
      <QueryState query={q} empty={(l) => (l.length ? null : <p className="p-4 text-sm text-[var(--text-2)]">No OAuth clients. Use them for machine-to-machine access with short-lived tokens.</p>)}>
        {(clients) => (
          <table className="w-full text-left text-sm">
            <caption className="sr-only">OAuth clients</caption>
            <thead className="bg-[var(--surface-2)] text-xs">
              <tr>
                <th scope="col" className="px-3 py-2">Name</th>
                <th scope="col" className="px-3 py-2">Client ID</th>
                <th scope="col" className="px-3 py-2">Role / scopes</th>
                <th scope="col" className="px-3 py-2">Last used</th>
                <th scope="col" className="px-3 py-2">Status</th>
                <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id} className="border-t border-[var(--border)]">
                  <td className="px-3 py-2 font-medium">{c.name}</td>
                  <td className="px-3 py-2 font-mono text-xs">{c.client_id}</td>
                  <td className="px-3 py-2 text-xs">
                    {ROLE_LABELS[c.role] ?? c.role}
                    {c.scopes.length ? ` · ${c.scopes.join(", ")}` : ""}
                  </td>
                  <td className="px-3 py-2 text-xs">{c.last_used_at ? formatDate(c.last_used_at) : "never"}</td>
                  <td className="px-3 py-2">{c.revoked_at ? <Badge tone="critical">revoked</Badge> : <Badge tone="good">active</Badge>}</td>
                  <td className="px-3 py-2 text-right">
                    {!c.revoked_at && (
                      <Button size="sm" variant="ghost" onClick={() => setRevoking(c)} aria-label={`Revoke ${c.name}`}>
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </QueryState>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New OAuth client"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!form.name.trim()}>
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <SelectField label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role, scopes: [] })} options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
          <MultiSelect label="Scopes (optional narrowing)" options={scopeOptions} value={form.scopes} onChange={(v) => setForm({ ...form, scopes: v })} hint="Empty = every permission of the role" />
        </div>
      </Modal>
      <SecretOnce
        open={!!created}
        onClose={() => setCreated(null)}
        title="OAuth client created"
        secrets={created ? [{ label: "Client ID", value: created.client_id }, { label: "Client secret", value: created.client_secret }] : []}
      >
        <p className="mb-2 text-sm">Exchange the credentials for a short-lived token:</p>
        <CodeBlock
          label="Token request"
          code={`curl -X POST '${tokenUrl}' \\\n  -u "$CLIENT_ID:$CLIENT_SECRET" \\\n  -d grant_type=client_credentials\n\n# then call the API with: Authorization: Bearer <access_token>`}
        />
      </SecretOnce>
      <ConfirmDialog open={!!revoking} onClose={() => setRevoking(null)} onConfirm={() => revoking && revoke.mutate(revoking.id)} title="Revoke OAuth client?" danger confirmLabel="Revoke" loading={revoke.isPending}>
        <p>
          <strong>{revoking?.name}</strong> can no longer get tokens, and tokens already issued stop working immediately.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

// -- Network policy ----------------------------------------------------------------------------

export function NetworkTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["network-policy"], queryFn: api.access.networkPolicy });
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState("");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (q.data) {
      setAllow(q.data.allow.join("\n"));
      setDeny(q.data.deny.join("\n"));
    }
  }, [q.data]);
  const a = useMemo(() => parseCidrList(allow), [allow]);
  const d = useMemo(() => parseCidrList(deny), [deny]);
  const warnings = policyWarnings({ allow: a.entries, deny: d.entries });
  const save = useMutation({
    mutationFn: () => api.access.putNetworkPolicy({ allow: a.entries, deny: d.entries }),
    meta: { errorPrefix: "Network policy not saved" },
    onSuccess: (p) => {
      setConfirm(false);
      qc.setQueryData(["network-policy"], p);
      toast.success("Network policy saved");
    },
    onError: () => setConfirm(false),
  });
  const invalid = a.errors.length + d.errors.length > 0;
  return (
    <Card title="IP allowlist / denylist">
      <QueryState query={q}>
        {() => (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (a.entries.length) setConfirm(true);
              else save.mutate();
            }}
          >
            <p className="text-sm text-[var(--text-2)]">
              Applies to every principal of the organization: users, API keys, OAuth clients and SCIM. Deny wins over allow; a non-empty allowlist blocks everything else. Blocked calls get 403 <code>ip_denied</code>.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <TextArea
                label="Allow (one IP or CIDR per line)"
                mono
                rows={6}
                value={allow}
                onChange={(e) => setAllow(e.target.value)}
                placeholder={"203.0.113.0/24\n2001:db8::/32"}
                error={a.errors.length ? a.errors.map((x) => x.error).join("; ") : null}
                hint="Empty = allow every address (unless denied)"
              />
              <TextArea label="Deny" mono rows={6} value={deny} onChange={(e) => setDeny(e.target.value)} placeholder="198.51.100.7" error={d.errors.length ? d.errors.map((x) => x.error).join("; ") : null} />
            </div>
            {warnings.map((w, i) => (
              <p key={i} role="alert" className="rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                ⚠ {w}
              </p>
            ))}
            <Button type="submit" variant="primary" loading={save.isPending} disabled={invalid}>
              Save policy
            </Button>
          </form>
        )}
      </QueryState>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => save.mutate()} title="Restrict access to the allowlist?" confirmLabel="Save policy" danger loading={save.isPending}>
        <p>Only these ranges will reach the API:</p>
        <ul className="list-disc pl-5 font-mono text-xs">
          {a.entries.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
        <p>Everyone else, including teammates and integrations outside these ranges, will be blocked. If your own IP isn&apos;t included the server refuses the change (409).</p>
      </ConfirmDialog>
    </Card>
  );
}

// -- SCIM ----------------------------------------------------------------------------------

export function ScimTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["scim-token"], queryFn: api.access.scimToken });
  const [token, setToken] = useState<{ token: string; base_url: string } | null>(null);
  const [confirm, setConfirm] = useState<"rotate" | "revoke" | null>(null);
  const create = useMutation({
    mutationFn: api.access.createScimToken,
    onSuccess: (t) => {
      setConfirm(null);
      setToken(t);
      qc.invalidateQueries({ queryKey: ["scim-token"] });
    },
  });
  const revoke = useMutation({
    mutationFn: api.access.revokeScimToken,
    onSuccess: () => {
      setConfirm(null);
      toast.success("SCIM token revoked");
      qc.invalidateQueries({ queryKey: ["scim-token"] });
    },
  });
  const baseUrl = `${API_URL}${token?.base_url ?? "/scim/v2"}`;
  return (
    <Card title="SCIM 2.0 provisioning">
      <QueryState query={q}>
        {(s) => (
          <div className="space-y-3">
            <p className="text-sm text-[var(--text-2)]">Let your identity provider (Okta, Entra ID…) create, update and disable users. Provisioned users have no password and sign in with SSO.</p>
            <KeyValue
              items={[
                ["Base URL", <code key="u" className="font-mono text-xs">{baseUrl}</code>],
                ["Token", s.configured ? <Badge key="t" tone="good">configured</Badge> : <Badge key="t">not configured</Badge>],
                ...(s.configured ? ([["Created", `${formatDate(s.created_at)}${s.created_by ? ` by ${s.created_by}` : ""}`]] as [string, string][]) : []),
                ["Role attribute", <code key="r" className="font-mono text-xs">urn:ietf:params:scim:schemas:extension:analyticsplatform:2.0:User → role</code>],
              ]}
            />
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => (s.configured ? setConfirm("rotate") : create.mutate())} loading={create.isPending}>
                {s.configured ? "Rotate token" : "Create token"}
              </Button>
              {s.configured && (
                <Button variant="danger" onClick={() => setConfirm("revoke")}>
                  Revoke
                </Button>
              )}
            </div>
          </div>
        )}
      </QueryState>
      <SecretOnce open={!!token} onClose={() => setToken(null)} title="SCIM token" secrets={token ? [{ label: "Bearer token", value: token.token }, { label: "SCIM base URL", value: baseUrl }] : []} />
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => (confirm === "revoke" ? revoke.mutate() : create.mutate())}
        title={confirm === "revoke" ? "Revoke the SCIM token?" : "Rotate the SCIM token?"}
        confirmLabel={confirm === "revoke" ? "Revoke" : "Rotate"}
        danger
        loading={create.isPending || revoke.isPending}
      >
        <p>The current token stops working immediately; provisioning fails until the identity provider is updated{confirm === "rotate" ? " with the new token" : ""}.</p>
      </ConfirmDialog>
    </Card>
  );
}

// -- Teams ---------------------------------------------------------------------------------

export function TeamsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.access.teams });
  const users = useQuery({ queryKey: ["users"], queryFn: api.tenant.users });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.projects.list() });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", members: [] as string[] });
  const [toDelete, setToDelete] = useState<Team | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["teams"] });
  const create = useMutation({
    mutationFn: () => api.access.createTeam({ name: form.name.trim(), description: form.description.trim() || undefined, members: form.members }),
    meta: { errorPrefix: "Team not created" },
    onSuccess: () => {
      setOpen(false);
      setForm({ name: "", description: "", members: [] });
      toast.success("Team created");
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.access.deleteTeam(id),
    onSuccess: () => {
      setToDelete(null);
      toast.success("Team deleted");
      invalidate();
    },
  });
  const userLabel = (id: string) => {
    const u = users.data?.find((x) => x.id === id);
    return u ? u.name || u.email : id;
  };
  const userOptions = (users.data ?? []).filter((u) => !u.disabled).map((u) => ({ value: u.id, label: `${u.name ?? u.email} (${u.email})` }));
  return (
    <Card
      title="Teams"
      actions={
        <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
          New team
        </Button>
      }
    >
      <QueryState query={teams} empty={(l) => (l.length ? null : <EmptyState title="No teams yet">Group users into teams and grant them access to restricted projects.</EmptyState>)}>
        {(list) => (
          <ul className="space-y-4">
            {list.map((t) => (
              <TeamRow key={t.id} team={t} userLabel={userLabel} userOptions={userOptions} projects={projects.data ?? []} onChanged={invalidate} onDelete={() => setToDelete(t)} />
            ))}
          </ul>
        )}
      </QueryState>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New team"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!form.name.trim()}>
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <TextField label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <MultiSelect label="Members" options={userOptions} value={form.members} onChange={(v) => setForm({ ...form, members: v })} />
        </div>
      </Modal>
      <ConfirmDialog open={!!toDelete} onClose={() => setToDelete(null)} onConfirm={() => toDelete && remove.mutate(toDelete.id)} title="Delete team?" danger confirmLabel="Delete" loading={remove.isPending}>
        <p>Members lose the project access granted through “{toDelete?.name}”.</p>
      </ConfirmDialog>
    </Card>
  );
}

function TeamRow({
  team,
  userLabel,
  userOptions,
  projects,
  onChanged,
  onDelete,
}: {
  team: Team;
  userLabel: (id: string) => string;
  userOptions: { value: string; label: string }[];
  projects: { id: string; name: string; open: boolean }[];
  onChanged: () => void;
  onDelete: () => void;
}) {
  const [member, setMember] = useState("");
  const [project, setProject] = useState("");
  const addMember = useMutation({ mutationFn: () => api.access.addTeamMember(team.id, member), onSuccess: () => (setMember(""), onChanged()) });
  const removeMember = useMutation({ mutationFn: (uid: string) => api.access.removeTeamMember(team.id, uid), onSuccess: onChanged });
  const grant = useMutation({ mutationFn: () => api.access.grantProject(project, team.id), onSuccess: () => (setProject(""), onChanged()) });
  const revoke = useMutation({ mutationFn: (pid: string) => api.access.revokeProject(pid, team.id), onSuccess: onChanged });
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  return (
    <li className="rounded-md border border-[var(--border)] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{team.name}</h3>
        {team.description && <span className="text-sm text-[var(--text-2)]">{team.description}</span>}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onDelete} aria-label={`Delete team ${team.name}`}>
          Delete
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-semibold">Members ({team.members.length})</p>
          <ul className="mb-2 flex flex-wrap gap-1">
            {team.members.map((m) => (
              <li key={m}>
                <Badge>
                  {userLabel(m)}
                  <button type="button" className="ml-1" onClick={() => removeMember.mutate(m)} aria-label={`Remove ${userLabel(m)} from ${team.name}`}>
                    ×
                  </button>
                </Badge>
              </li>
            ))}
            {!team.members.length && <li className="text-xs text-[var(--text-2)]">No members</li>}
          </ul>
          <div className="flex items-end gap-2">
            <SelectField className="flex-1" label="Add member" value={member} onChange={(e) => setMember(e.target.value)} options={userOptions.filter((o) => !team.members.includes(o.value))} placeholder="Choose a user…" />
            <Button size="sm" onClick={() => addMember.mutate()} disabled={!member} loading={addMember.isPending}>
              Add
            </Button>
          </div>
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold">Projects granted ({team.projects.length})</p>
          <ul className="mb-2 flex flex-wrap gap-1">
            {team.projects.map((p) => (
              <li key={p}>
                <Badge tone="info">
                  {projectName(p)}
                  <button type="button" className="ml-1" onClick={() => revoke.mutate(p)} aria-label={`Revoke ${projectName(p)} from ${team.name}`}>
                    ×
                  </button>
                </Badge>
              </li>
            ))}
            {!team.projects.length && <li className="text-xs text-[var(--text-2)]">None</li>}
          </ul>
          <div className="flex items-end gap-2">
            <SelectField
              className="flex-1"
              label="Grant project"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              options={projects.filter((p) => !team.projects.includes(p.id)).map((p) => ({ value: p.id, label: `${p.name}${p.open ? " (open)" : ""}` }))}
              placeholder="Choose a project…"
            />
            <Button size="sm" onClick={() => grant.mutate()} disabled={!project} loading={grant.isPending}>
              Grant
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}
