"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { describeStep } from "@/lib/pipelineSteps";
import { Badge, Button, Card, EmptyState, PageHeader, QueryState, SelectField, TextField } from "@/components/ui";

export default function PipelinesPage() {
  const { can } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const datasetId = params.get("dataset") ?? "";
  const [name, setName] = useState("Cleaning pipeline");

  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api.datasets.list() });
  const pipelines = useQuery({ queryKey: ["pipelines", datasetId], queryFn: () => api.pipelines.list(datasetId || undefined) });
  const templates = useQuery({ queryKey: ["pipeline-templates"], queryFn: api.pipelines.templates });

  const create = useMutation({
    mutationFn: () => api.pipelines.create({ dataset_id: datasetId, name, steps: [] }),
    onSuccess: (p) => router.push(`/pipelines/${p.id}`),
  });
  const fromTemplate = useMutation({
    mutationFn: (templateId: string) => api.pipelines.fromTemplate(templateId, datasetId),
    meta: { errorPrefix: "Template not applied" },
    onSuccess: (p) => router.push(`/pipelines/${p.id}`),
  });

  const dsName = (id: string | null) => datasets.data?.find((d) => d.id === id)?.name ?? id ?? "—";

  return (
    <div className="space-y-5">
      <PageHeader title="Cleaning pipelines" description="Reproducible, non-destructive cleaning: every step is recorded and applying creates a new dataset version." />
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <SelectField
            label="Dataset"
            className="min-w-64"
            value={datasetId}
            onChange={(e) => router.replace(e.target.value ? `${pathname}?dataset=${e.target.value}` : pathname)}
            options={(datasets.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
            placeholder="All datasets"
          />
          {datasetId && can("pipelines.edit") && (
            <>
              <TextField label="New pipeline name" value={name} onChange={(e) => setName(e.target.value)} />
              <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim()}>
                New pipeline
              </Button>
            </>
          )}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Card title="Pipelines" bodyClassName="p-0">
          <QueryState
            query={pipelines}
            empty={(l) => (l.length ? null : <div className="p-4"><EmptyState title="No pipelines yet">{datasetId ? "Create one above or start from a template." : "Pick a dataset to create one."}</EmptyState></div>)}
          >
            {(list) => (
              <ul className="divide-y divide-[var(--border)]">
                {list.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <Link href={`/pipelines/${p.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">
                        {p.name}
                      </Link>
                      <p className="truncate text-xs text-[var(--text-2)]">
                        {dsName(p.dataset_id)} · {p.steps.length} step{p.steps.length === 1 ? "" : "s"}
                        {p.steps.length ? ` · ${p.steps.map((s) => s.op).join(" → ")}` : ""}
                      </p>
                    </div>
                    <span className="font-mono text-[10px] text-[var(--text-2)]">{p.hash.slice(0, 10)}</span>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </Card>

        <Card title="Templates" bodyClassName="p-0">
          <QueryState query={templates} empty={(l) => (l.length ? null : <p className="p-4 text-sm text-[var(--text-2)]">Save a pipeline as a template to reuse it on other datasets.</p>)}>
            {(list) => (
              <ul className="divide-y divide-[var(--border)]">
                {list.map((t) => (
                  <li key={t.id} className="space-y-1 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="flex-1 font-medium">{t.name}</span>
                      <Badge>{t.steps.length} steps</Badge>
                    </div>
                    <ol className="list-decimal pl-5 text-xs text-[var(--text-2)]">
                      {t.steps.slice(0, 5).map((s, i) => (
                        <li key={i}>
                          <span className="font-mono">{s.op}</span> {describeStep(s)}
                        </li>
                      ))}
                    </ol>
                    {datasetId && can("pipelines.edit") && (
                      <Button size="sm" onClick={() => fromTemplate.mutate(t.id)} loading={fromTemplate.isPending && fromTemplate.variables === t.id}>
                        Apply to {dsName(datasetId)}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </Card>
      </div>
    </div>
  );
}
