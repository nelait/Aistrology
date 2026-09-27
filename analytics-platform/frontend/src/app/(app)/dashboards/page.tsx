"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Dashboard } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { emptySpec, normalizeSpec } from "@/lib/dashboard";
import { formatDate } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, Modal, PageHeader, QueryState, TextField } from "@/components/ui";

export default function DashboardsPage() {
  const { can } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [archived, setArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<string>("");
  const [del, setDel] = useState<Dashboard | null>(null);
  const q = useQuery({ queryKey: ["dashboards", archived], queryFn: () => api.dashboards.list(archived) });
  const templates = useQuery({ queryKey: ["dashboard-templates"], queryFn: api.dashboards.templates, enabled: createOpen, meta: { silent: true } });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["dashboards"] });
  const create = useMutation({
    mutationFn: () => {
      const t = templates.data?.find((x) => x.id === template);
      return api.dashboards.create(name.trim(), t ? normalizeSpec(t.spec) : emptySpec());
    },
    onSuccess: (d) => {
      invalidate();
      router.push(`/dashboards/${d.id}?edit=1`);
    },
  });
  const clone = useMutation({
    mutationFn: (id: string) => api.dashboards.clone(id),
    onSuccess: (d) => {
      toast.success(`Cloned as “${d.name}”`);
      invalidate();
    },
  });
  const archive = useMutation({
    mutationFn: (id: string) => api.dashboards.archive(id),
    onSuccess: () => {
      toast.success("Dashboard archived");
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.dashboards.remove(id),
    onSuccess: () => {
      toast.success("Dashboard deleted");
      setDel(null);
      invalidate();
    },
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboards"
        description="Drag-and-drop dashboards built from reusable widgets."
        actions={
          can("dashboards.edit") && (
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              New dashboard
            </Button>
          )
        }
      />
      <Checkbox label="Show archived" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
      <QueryState query={q} empty={(l) => (l.length ? null : <EmptyState title={archived ? "No archived dashboards" : "No dashboards yet"}>Create one from scratch or from a template.</EmptyState>)}>
        {(list) => (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((d) => {
              const spec = normalizeSpec(d.spec);
              const widgets = spec.pages.reduce((n, p) => n + p.widgets.length, 0);
              const editable = can("dashboards.edit") && d.role !== "viewer";
              return (
                <Card key={d.id}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <Link href={`/dashboards/${d.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">
                        {d.name}
                      </Link>
                      <p className="text-xs text-[var(--text-2)]">
                        {spec.pages.length} page{spec.pages.length === 1 ? "" : "s"} · {widgets} widget{widgets === 1 ? "" : "s"}
                        {d.updated_at ? ` · updated ${formatDate(d.updated_at)}` : ""}
                      </p>
                    </div>
                    {d.archived && <Badge>archived</Badge>}
                    {d.role && d.role !== "owner" && <Badge tone="info">{d.role}</Badge>}
                  </div>
                  {can("dashboards.edit") && (
                    <div className="mt-3 flex flex-wrap gap-1">
                      <Button size="sm" onClick={() => clone.mutate(d.id)} loading={clone.isPending && clone.variables === d.id}>
                        Clone
                      </Button>
                      {editable && !d.archived && (
                        <Button size="sm" variant="ghost" onClick={() => archive.mutate(d.id)}>
                          Archive
                        </Button>
                      )}
                      {editable && (
                        <Button size="sm" variant="ghost" onClick={() => setDel(d)}>
                          Delete
                        </Button>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </QueryState>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New dashboard"
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim()}>
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-[var(--text-2)]">Start from</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex cursor-pointer gap-2 rounded-md border border-[var(--border)] p-2 text-sm">
                <input type="radio" name="tpl" checked={template === ""} onChange={() => setTemplate("")} className="accent-brand-600" />
                <span>
                  Blank
                  <span className="block text-xs text-[var(--text-2)]">An empty page</span>
                </span>
              </label>
              {(templates.data ?? []).map((t) => (
                <label key={t.id} className="flex cursor-pointer gap-2 rounded-md border border-[var(--border)] p-2 text-sm">
                  <input type="radio" name="tpl" checked={template === t.id} onChange={() => setTemplate(t.id)} className="accent-brand-600" />
                  <span>
                    {t.name}
                    {t.description && <span className="block text-xs text-[var(--text-2)]">{t.description}</span>}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </Modal>
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={() => del && remove.mutate(del.id)} title="Delete dashboard?" danger confirmLabel="Delete" loading={remove.isPending}>
        <p>“{del?.name}” will be deleted for everyone it is shared with.</p>
      </ConfirmDialog>
    </div>
  );
}
