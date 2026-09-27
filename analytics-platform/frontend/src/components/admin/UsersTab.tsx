"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ROLES, type Role } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ROLE_LABELS } from "@/lib/rbac";
import { useToast } from "@/lib/toast";
import { Badge, Button, Card, Modal, QueryState, SelectField, TextField } from "../ui";

const roleOptions = ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }));

export function UsersTab() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["users"], queryFn: api.tenant.users });
  const [invite, setInvite] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", role: "analyst" as Role, password: "" });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { role?: Role; disabled?: boolean } }) => api.tenant.patchUser(id, body),
    onSuccess: () => {
      toast.success("User updated");
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
  const create = useMutation({
    mutationFn: () => api.tenant.createUser({ email: form.email, role: form.role, password: form.password, name: form.name || undefined }),
    onSuccess: () => {
      toast.success(`Invited ${form.email}`);
      setInvite(false);
      setForm({ email: "", name: "", role: "analyst", password: "" });
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
  const generatePassword = () => {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    // base64 body plus guaranteed upper, lower and digit characters (backend password policy)
    setForm((f) => ({ ...f, password: `${btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "x")}Aa7` }));
  };

  return (
    <Card
      title="Users"
      bodyClassName="p-0 overflow-x-auto"
      actions={
        <Button variant="primary" size="sm" onClick={() => setInvite(true)}>
          Invite user
        </Button>
      }
    >
      <QueryState query={q}>
        {(users) => (
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Users</caption>
            <thead className="bg-[var(--surface-2)] text-xs text-[var(--text-2)]">
              <tr>
                <th scope="col" className="px-3 py-2">User</th>
                <th scope="col" className="px-3 py-2">Role</th>
                <th scope="col" className="px-3 py-2">MFA</th>
                <th scope="col" className="px-3 py-2">Status</th>
                <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u.id === me?.id;
                return (
                  <tr key={u.id} className="border-t border-[var(--border)]">
                    <td className="px-3 py-2">
                      {u.name ?? u.email}
                      <span className="block text-xs text-[var(--text-2)]">{u.email}</span>
                    </td>
                    <td className="px-3 py-2">
                      <SelectField label={`Role of ${u.email}`} srOnlyLabel value={u.role} disabled={self} onChange={(e) => patch.mutate({ id: u.id, body: { role: e.target.value as Role } })} options={roleOptions} />
                    </td>
                    <td className="px-3 py-2">{u.mfa_enabled ? <Badge tone="good">✓ on</Badge> : <Badge>off</Badge>}</td>
                    <td className="px-3 py-2">{u.disabled ? <Badge tone="critical">disabled</Badge> : <Badge tone="good">active</Badge>}</td>
                    <td className="px-3 py-2 text-right">
                      {!self && (
                        <Button size="sm" variant={u.disabled ? "secondary" : "ghost"} onClick={() => patch.mutate({ id: u.id, body: { disabled: !u.disabled } })}>
                          {u.disabled ? "Enable" : "Disable"}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </QueryState>
      <Modal
        open={invite}
        onClose={() => setInvite(false)}
        title="Invite user"
        footer={
          <>
            <Button onClick={() => setInvite(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!form.email || form.password.length < 12}>
              Create user
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <TextField label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <SelectField label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })} options={roleOptions} />
          <div className="flex items-end gap-2">
            <TextField className="flex-1" label="Temporary password" hint="12+ characters with upper- and lower-case letters and a digit. Share it securely; the user should enable MFA." value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            <Button onClick={generatePassword}>Generate</Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
