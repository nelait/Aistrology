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
import { Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, Modal, PageHeader, QueryState, SelectField, TextField } from "@/components/ui";
import { schemaColumns } from "@/lib/data";

export default function DashboardsPage() {
  const { can } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [archived, setArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<string>("");
  const [tplDataset, setTplDataset] = useState("");
  const [measure, setMeasure] = useState("");
  const [dimension, setDimension] = useState("");
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api.datasets.list(), enabled: createOpen && !!template && template !== "blank" });
  const tplColumns = schemaColumns(datasets.data?.find((d) => d.id === tplDataset)?.schema);
  const [del, setDel] = useState<Dashboard | null>(null);
  const q = useQuery({ queryKey: ["dashboards", archived], queryFn: () => api.dashboards.list(archived) });
  const templates = useQuery({ queryKey: ["dashboard-templates"], queryFn: api.dashboards.templates, enabled: createOpen, meta: { silent: true } });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["dashboards"] });
  const create = useMutation({
    mutationFn: async () => {
      if (!template || template === "blank") return api.dashboards.create(name.trim(), emptySpec());
      const d = await api.dashboards.fromTemplate(template, name.trim(), { dataset_id: tplDataset, measure, dimension });
      // Point the template's data widgets at the chosen dataset.
      const spec = normalizeSpec(d.spec);
      const needs = spec.pages.some((p) => p.widgets.some((w) => ["chart", "kpi", "table", "alert"].includes(w.type) && !w.config.dataset_id && !w.config.analytic_id));
      if (!needs || !tplDataset) return d;
      const pages = spec.pages.map((p) => ({
        ...p,
        widgets: p.widgets.map((w) => (["chart", "kpi", "table", "alert"].includes(w.type) && !w.config.dataset_id && !w.config.analytic_id ? { ...w, config: { ...w.config, dataset_id: tplDataset } } : w)),
      }));
      return api.dashboards.update(d.id, { spec: { ...spec, pages } });
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
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) => api.dashboards.archive(id, archived),
    onSuccess: (d) => {
      toast.success(d.archived ? "Dashboard archived" : "Dashboard restored");
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
              const editable = can("dashboards.edit") && d.your_role !== "viewer";
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
                    {d.your_role && d.your_role !== "owner" && <Badge tone="info">shared · {d.your_role}</Badge>}
                    {d.your_role === "owner" && Object.keys(d.shares ?? {}).length > 0 && <Badge>shared</Badge>}
                  </div>
                  {can("dashboards.edit") && (
                    <div className="mt-3 flex flex-wrap gap-1">
                      <Button size="sm" onClick={() => clone.mutate(d.id)} loading={clone.isPending && clone.variables === d.id}>
                        Clone
                      </Button>
                      {editable && (
                        <Button size="sm" variant="ghost" onClick={() => archive.mutate({ id: d.id, archived: !d.archived })}>
                          {d.archived ? "Restore" : "Archive"}
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
            <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim() || (!!template && template !== "blank" && (!tplDataset || !measure || !dimension))}>
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
              {(templates.data ?? []).filter((t) => t.id !== "blank").map((t) => (
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
          {template && template !== "blank" && (
            <div className="grid gap-2 sm:grid-cols-3">
              <SelectField label="Dataset" value={tplDataset} onChange={(e) => setTplDataset(e.target.value)} options={(datasets.data ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="Choose…" />
              <SelectField label="Measure" value={measure} onChange={(e) => setMeasure(e.target.value)} options={tplColumns.filter((c) => c.type === "integer" || c.type === "number").map((c) => ({ value: c.name, label: c.name }))} placeholder="Numeric column…" />
              <SelectField label="Dimension" value={dimension} onChange={(e) => setDimension(e.target.value)} options={tplColumns.map((c) => ({ value: c.name, label: c.name }))} placeholder="Group by…" />
            </div>
          )}
        </div>
      </Modal>
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={() => del && remove.mutate(del.id)} title="Delete dashboard?" danger confirmLabel="Delete" loading={remove.isPending}>
        <p>“{del?.name}” will be deleted for everyone it is shared with.</p>
      </ConfirmDialog>
    </div>
  );
}
