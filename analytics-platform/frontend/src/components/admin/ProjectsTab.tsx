"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { Badge, Button, Card, Checkbox, Modal, MultiSelect, QueryState, SelectField, TextField } from "../ui";

/** Projects and membership (AUTH-003). */
export function ProjectsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.projects.list() });
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.tenant.users() });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", open: false, members: [] as string[] });
  const [adding, setAdding] = useState<Record<string, string>>({});
  const invalidate = () => qc.invalidateQueries({ queryKey: ["projects"] });
  const create = useMutation({
    mutationFn: () => api.projects.create(form),
    onSuccess: () => {
      toast.success("Project created");
      setOpen(false);
      setForm({ name: "", open: false, members: [] });
      invalidate();
    },
  });
  const add = useMutation({ mutationFn: ({ id, user }: { id: string; user: string }) => api.projects.addMember(id, user), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: ({ id, user }: { id: string; user: string }) => api.projects.removeMember(id, user), onSuccess: invalidate });
  const userLabel = (id: string) => {
    const u = users.data?.find((x) => x.id === id);
    return u ? u.name ?? u.email : id;
  };
  return (
    <Card title="Projects" actions={<Button size="sm" variant="primary" onClick={() => setOpen(true)}>New project</Button>}>
      <p className="mb-3 text-sm text-[var(--text-2)]">Datasets belong to a project. Open projects are visible to everyone; restricted projects only to their members and admins.</p>
      <QueryState query={projects}>
        {(list) => (
          <ul className="divide-y divide-[var(--border)]">
            {list.map((p) => (
              <li key={p.id} className="space-y-2 py-3">
                <div className="flex items-center gap-2">
                  <span className="flex-1 font-medium">{p.name}</span>
                  {p.open ? <Badge tone="good">open</Badge> : <Badge tone="warning">restricted</Badge>}
                </div>
                {!p.open && (
                  <>
                    <div className="flex flex-wrap gap-1">
                      {p.members.map((m) => (
                        <button key={m} type="button" className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs hover:bg-[var(--surface-2)]" onClick={() => remove.mutate({ id: p.id, user: m })} aria-label={`Remove ${userLabel(m)} from ${p.name}`}>
                          {userLabel(m)} ✕
                        </button>
                      ))}
                      {!p.members.length && <span className="text-xs text-[var(--text-2)]">No members yet</span>}
                    </div>
                    <div className="flex items-end gap-2">
                      <SelectField
                        label={`Add member to ${p.name}`}
                        srOnlyLabel
                        value={adding[p.id] ?? ""}
                        onChange={(e) => setAdding((a) => ({ ...a, [p.id]: e.target.value }))}
                        options={(users.data ?? []).filter((u) => !p.members.includes(u.id)).map((u) => ({ value: u.id, label: u.name ?? u.email }))}
                        placeholder="Add member…"
                      />
                      <Button size="sm" disabled={!adding[p.id]} onClick={() => add.mutate({ id: p.id, user: adding[p.id] })}>
                        Add
                      </Button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New project"
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
          <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Checkbox label="Open to everyone in the organization" checked={form.open} onChange={(e) => setForm({ ...form, open: e.target.checked })} />
          {!form.open && <MultiSelect label="Members" options={(users.data ?? []).map((u) => ({ value: u.id, label: u.name ?? u.email }))} value={form.members} onChange={(members) => setForm({ ...form, members })} />}
        </div>
      </Modal>
    </Card>
  );
}
