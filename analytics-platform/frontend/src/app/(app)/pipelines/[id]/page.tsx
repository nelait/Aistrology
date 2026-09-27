"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Job, type Pipeline, type PipelineStep, type StepOp } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { STEP_DEFS, StepValidationError, describeStep, initialFormState, serializeStep, type StepFormState } from "@/lib/pipelineSteps";
import { schemaColumns } from "@/lib/data";
import { useToast } from "@/lib/toast";
import { StepForm } from "@/components/pipeline/StepForm";
import { PreviewPanel } from "@/components/pipeline/PreviewPanel";
import { JobProgress } from "@/components/JobProgress";
import { Badge, Button, Card, EmptyState, Modal, PageHeader, QueryState, SelectField, Spinner, TextField } from "@/components/ui";

export default function PipelineBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ["pipeline", id], queryFn: () => api.pipelines.get(id) });
  return <QueryState query={q}>{(p) => <Builder pipeline={p} />}</QueryState>;
}

function Builder({ pipeline }: { pipeline: Pipeline }) {
  const { can } = useAuth();
  const editable = can("pipelines.edit") && !pipeline.is_template;
  const qc = useQueryClient();
  const toast = useToast();
  const [op, setOp] = useState<StepOp>("fill_missing");
  const [values, setValues] = useState<StepFormState>(() => initialFormState("fill_missing"));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [job, setJob] = useState<Job | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState(`${pipeline.name} template`);
  const [applied, setApplied] = useState<{ dataset_id: string; version: number } | null>(null);

  const dataset = useQuery({ queryKey: ["dataset", pipeline.dataset_id, null], queryFn: () => api.datasets.get(pipeline.dataset_id!), enabled: !!pipeline.dataset_id });

  // Preview of the current pipeline (also yields the columns available to the next step).
  const current = useQuery({
    queryKey: ["pipeline-preview", pipeline.id, pipeline.hash],
    queryFn: () => api.pipelines.preview(pipeline.id, undefined, 50),
    enabled: !!pipeline.dataset_id,
  });
  const candidate = useMutation({ mutationFn: (step: PipelineStep) => api.pipelines.preview(pipeline.id, step, 50), meta: { errorPrefix: "Preview failed" } });

  const columns = useMemo(() => current.data?.columns ?? schemaColumns(dataset.data?.schema).map((c) => c.name), [current.data, dataset.data]);

  const setPipeline = (p: Pipeline) => {
    qc.setQueryData(["pipeline", pipeline.id], p);
    qc.invalidateQueries({ queryKey: ["pipelines"] });
  };

  const addStep = useMutation({
    mutationFn: (step: PipelineStep) => api.pipelines.addStep(pipeline.id, step),
    meta: { errorPrefix: "Step not added" },
    onSuccess: (p) => {
      setPipeline(p);
      candidate.reset();
      setValues(initialFormState(op));
      toast.success("Step added");
    },
  });
  const undo = useMutation({ mutationFn: () => api.pipelines.undo(pipeline.id), onSuccess: setPipeline });
  const redo = useMutation({ mutationFn: () => api.pipelines.redo(pipeline.id), onSuccess: setPipeline });
  const apply = useMutation({ mutationFn: () => api.pipelines.apply(pipeline.id), onSuccess: (j) => setJob(j) });
  const saveTemplate = useMutation({
    mutationFn: () => api.pipelines.saveTemplate(pipeline.id, templateName),
    onSuccess: () => {
      toast.success("Saved as template");
      setTemplateOpen(false);
      qc.invalidateQueries({ queryKey: ["pipeline-templates"] });
    },
  });

  // Keyboard shortcuts for undo/redo (PIP-002)
  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          if (pipeline.can_redo) redo.mutate();
        } else if (pipeline.can_undo) undo.mutate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, pipeline.can_redo, pipeline.can_undo, redo, undo]);

  const build = (): PipelineStep | null => {
    try {
      const extra: Record<string, unknown> = {};
      if (op === "mask_pii") {
        // pass known semantics so partial masking keeps the right shape (email, phone …)
        const fields = dataset.data?.schema?.entities?.[0]?.fields ?? [];
        const sem: Record<string, string> = {};
        for (const c of (values.columns as string[]) ?? []) {
          const f = fields.find((x) => x.name === c);
          if (f?.semantic) sem[c] = f.semantic;
        }
        if (Object.keys(sem).length) extra.semantics = sem;
      }
      const step = serializeStep(op, values, extra);
      setErrors({});
      return step;
    } catch (e) {
      if (e instanceof StepValidationError) setErrors(e.errors);
      return null;
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumb={
          <>
            <Link href={`/pipelines${pipeline.dataset_id ? `?dataset=${pipeline.dataset_id}` : ""}`} className="hover:underline">
              Pipelines
            </Link>{" "}
            / {pipeline.name}
          </>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {pipeline.name}
            {pipeline.is_template && <Badge tone="info">template</Badge>}
          </span>
        }
        description={
          <>
            Dataset:{" "}
            {pipeline.dataset_id ? (
              <Link href={`/datasets/${pipeline.dataset_id}`} className="underline">
                {dataset.data?.name ?? pipeline.dataset_id} (v{dataset.data?.latest_version ?? "?"})
              </Link>
            ) : (
              "—"
            )}{" "}
            · hash <span className="font-mono text-xs">{pipeline.hash.slice(0, 12)}</span>
          </>
        }
        actions={
          editable && (
            <>
              <Button onClick={() => undo.mutate()} disabled={!pipeline.can_undo} loading={undo.isPending} title="Undo (Ctrl+Z)">
                ↶ Undo
              </Button>
              <Button onClick={() => redo.mutate()} disabled={!pipeline.can_redo} loading={redo.isPending} title="Redo (Ctrl+Shift+Z)">
                ↷ Redo
              </Button>
              <Button onClick={() => setTemplateOpen(true)} disabled={!pipeline.steps.length}>
                Save as template
              </Button>
              <Button variant="primary" onClick={() => apply.mutate()} loading={apply.isPending} disabled={!pipeline.steps.length || !!(job && !["succeeded", "failed", "cancelled"].includes(job.status))}>
                Apply → new version
              </Button>
            </>
          )
        }
      />

      {job && (
        <div className="space-y-2">
          <JobProgress
            jobId={job.id}
            title="Applying pipeline"
            onDone={(j) => {
              if (j.status === "succeeded" && j.result) {
                const r = j.result as { dataset_id: string; version: number };
                setApplied(r);
                toast.success(`Created version v${r.version}`);
                qc.invalidateQueries({ queryKey: ["dataset", r.dataset_id] });
                qc.invalidateQueries({ queryKey: ["versions", r.dataset_id] });
                qc.invalidateQueries({ queryKey: ["datasets"] });
              }
            }}
          />
          {applied && (
            <p className="text-sm">
              ✓ New version ready:{" "}
              <Link href={`/datasets/${applied.dataset_id}?version=${applied.version}&tab=profile`} className="font-medium text-brand-600 underline dark:text-brand-300">
                v{applied.version} profile
              </Link>
            </p>
          )}
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card title={`Steps (${pipeline.steps.length})`} bodyClassName="p-0">
            {pipeline.steps.length ? (
              <ol className="divide-y divide-[var(--border)]">
                {pipeline.steps.map((s, i) => (
                  <li key={i} className="flex gap-3 px-4 py-2.5 text-sm">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--surface-2)] text-xs">{i + 1}</span>
                    <div className="min-w-0">
                      <p className="font-medium">{STEP_DEFS.find((d) => d.op === s.op)?.label ?? s.op}</p>
                      <p className="break-words text-xs text-[var(--text-2)]">{describeStep(s)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="p-4">
                <EmptyState title="No steps yet">Add a step on the right. Preview it first to see its effect.</EmptyState>
              </div>
            )}
          </Card>

          {editable && (
            <Card title="Add a step">
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const s = build();
                  if (s) addStep.mutate(s);
                }}
              >
                <SelectField
                  label="Operation"
                  value={op}
                  onChange={(e) => {
                    const next = e.target.value as StepOp;
                    setOp(next);
                    setValues(initialFormState(next));
                    setErrors({});
                    candidate.reset();
                  }}
                  options={STEP_DEFS.map((d) => ({ value: d.op, label: d.label }))}
                />
                <StepForm op={op} values={values} onChange={setValues} columns={columns} errors={errors} />
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      const s = build();
                      if (s) candidate.mutate(s);
                    }}
                    loading={candidate.isPending}
                  >
                    Preview step
                  </Button>
                  <Button type="submit" variant="primary" loading={addStep.isPending}>
                    Add step
                  </Button>
                </div>
              </form>
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-5">
          {candidate.data && <PreviewPanel preview={candidate.data} title="Preview with the new step" />}
          {current.isLoading ? <Spinner label="Computing preview…" /> : current.data ? <PreviewPanel preview={current.data} title="Current pipeline output" /> : null}
        </div>
      </div>

      <Modal
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        title="Save as template"
        size="sm"
        footer={
          <>
            <Button onClick={() => setTemplateOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => saveTemplate.mutate()} loading={saveTemplate.isPending} disabled={!templateName.trim()}>
              Save
            </Button>
          </>
        }
      >
        <TextField label="Template name" value={templateName} onChange={(e) => setTemplateName(e.target.value)} hint="Templates can be applied to any dataset with compatible columns." />
      </Modal>
    </div>
  );
}
