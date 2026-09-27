"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Experiment, type Job, type Run } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDuration, formatNumber } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { RunCharts } from "@/components/experiments/RunCharts";
import { Compare } from "@/components/experiments/Compare";
import { WhatIf } from "@/components/experiments/WhatIf";
import { JobProgress } from "@/components/JobProgress";
import { Badge, Button, Card, EmptyState, KeyValue, Modal, PageHeader, QueryState, StatusBadge, TabPanel, Tabs, TextArea, TextField } from "@/components/ui";

const LOWER_IS_BETTER = /(mae|mse|rmse|mape|loss|error)/i;
const ACTIVE = new Set(["queued", "running"]);

export default function ExperimentPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({
    queryKey: ["experiment", id],
    queryFn: () => api.training.get(id),
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return false;
      const running = ACTIVE.has(d.job?.status ?? "") || d.runs.some((r) => ACTIVE.has(r.status));
      return running ? 3000 : false;
    },
  });
  return <QueryState query={q}>{(d) => <ExperimentView experiment={d.experiment} runs={d.runs} job={d.job} />}</QueryState>;
}

function numericMetricNames(runs: Run[]): string[] {
  return Array.from(new Set(runs.flatMap((r) => Object.entries(r.metrics).filter(([, v]) => typeof v === "number").map(([k]) => k))));
}

function metric(r: Run, name: string): number | undefined {
  const v = r.metrics[name];
  return typeof v === "number" ? v : undefined;
}

function primaryMetric(runs: Run[], problem?: string | null): string | null {
  const names = numericMetricNames(runs);
  const pref = problem === "regression" ? ["rmse", "mae", "r2"] : ["roc_auc", "f1", "f1_macro", "accuracy"];
  return pref.find((p) => names.includes(p)) ?? names[0] ?? null;
}

function ExperimentView({ experiment, runs, job }: { experiment: Experiment; runs: Run[]; job: Job | null }) {
  const { can } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const problemType = experiment.config.problem_type ?? (typeof runs[0]?.metrics.problem_type === "string" ? (runs[0].metrics.problem_type as string) : null);
  const metricNames = useMemo(() => numericMetricNames(runs).slice(0, 8), [runs]);
  const [sortBy, setSortBy] = useState<string | null>(primaryMetric(runs, problemType));
  const [selected, setSelected] = useState<string[]>([]);
  const [tab, setTab] = useState("leaderboard");
  const [runId, setRunId] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [modelName, setModelName] = useState(experiment.name.replace(/[^A-Za-z0-9_-]+/g, "-").toLowerCase());
  const [description, setDescription] = useState("");

  const sorted = useMemo(() => {
    if (!sortBy) return runs;
    const dir = LOWER_IS_BETTER.test(sortBy) ? 1 : -1;
    const fallback = dir === 1 ? Infinity : -Infinity;
    return [...runs].sort((a, b) => ((metric(a, sortBy) ?? fallback) - (metric(b, sortBy) ?? fallback)) * dir);
  }, [runs, sortBy]);

  const bestId = runs.find((r) => r.artifacts?.is_best)?.id ?? sorted.find((r) => r.status === "succeeded")?.id ?? sorted[0]?.id;
  const activeRunId = runId ?? bestId ?? null;
  const run = useQuery({ queryKey: ["run", activeRunId], queryFn: () => api.training.run(activeRunId!), enabled: !!activeRunId && (tab === "run" || tab === "whatif") });

  const register = useMutation({
    mutationFn: () => api.models.register({ name: modelName, run_id: activeRunId!, description: description || undefined }),
    onSuccess: (r) => {
      toast.success("Model registered");
      setRegisterOpen(false);
      qc.invalidateQueries({ queryKey: ["models"] });
      toast.success(`${r.name} v${r.version} registered`);
      router.push(`/models/${r.model_id}`);
    },
  });

  const openRun = (id: string) => {
    setRunId(id);
    setTab("run");
  };

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumb={
          <>
            <Link href="/experiments" className="hover:underline">
              Experiments
            </Link>{" "}
            / {experiment.name}
          </>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {experiment.name} {job && <StatusBadge status={job.status} />}
          </span>
        }
        description={
          <>
            Target <span className="font-mono">{experiment.config.target}</span>
            {problemType ? ` · ${problemType}` : ""} · dataset{" "}
            <Link href={`/datasets/${experiment.dataset_id}`} className="underline">
              {experiment.dataset_id}
            </Link>
            {experiment.dataset_version ? ` v${experiment.dataset_version}` : ""}
          </>
        }
        actions={
          can("models.train") &&
          activeRunId && (
            <Button variant="primary" onClick={() => setRegisterOpen(true)}>
              Register model
            </Button>
          )
        }
      />
      {job && ACTIVE.has(job.status) && <JobProgress jobId={job.id} title="Training" onDone={() => qc.invalidateQueries({ queryKey: ["experiment", experiment.id] })} />}
      {job?.status === "failed" && (
        <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          Training failed: {job.error ?? "unknown error"}
        </p>
      )}
      {runs[0]?.artifacts?.warnings?.length ? (
        <ul className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {runs[0].artifacts.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      ) : null}

      <Tabs
        label="Experiment sections"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "leaderboard", label: `Leaderboard (${runs.length})` },
          { id: "run", label: "Run details" },
          { id: "compare", label: `Compare${selected.length ? ` (${selected.length})` : ""}` },
          { id: "whatif", label: "What-if" },
        ]}
      />
      <TabPanel id={tab}>
        {tab === "leaderboard" &&
          (runs.length ? (
            <Card bodyClassName="p-0 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Runs leaderboard</caption>
                <thead className="bg-[var(--surface-2)] text-xs">
                  <tr>
                    <th scope="col" className="px-3 py-2"><span className="sr-only">Select for comparison</span></th>
                    <th scope="col" className="px-3 py-2">#</th>
                    <th scope="col" className="px-3 py-2">Algorithm</th>
                    <th scope="col" className="px-3 py-2">Status</th>
                    {metricNames.map((m) => (
                      <th key={m} scope="col" className="px-3 py-2" aria-sort={sortBy === m ? (LOWER_IS_BETTER.test(m) ? "ascending" : "descending") : "none"}>
                        <button type="button" onClick={() => setSortBy(m)} className="font-mono">
                          {m} {sortBy === m ? "▾" : ""}
                        </button>
                      </th>
                    ))}
                    <th scope="col" className="px-3 py-2">Duration</th>
                    <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r, i) => (
                    <tr key={r.id} className="border-t border-[var(--border)]">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-brand-600"
                          aria-label={`Select ${r.algorithm} run ${r.id.slice(0, 6)} for comparison`}
                          checked={selected.includes(r.id)}
                          onChange={() => setSelected((s) => (s.includes(r.id) ? s.filter((x) => x !== r.id) : [...s, r.id]))}
                        />
                      </td>
                      <td className="px-3 py-2">{i + 1}</td>
                      <td className="px-3 py-2">
                        {r.algorithm} {r.id === bestId && <Badge tone="good">★ best</Badge>}
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={r.status} />
                      </td>
                      {metricNames.map((m) => (
                        <td key={m} className="px-3 py-2 tabular-nums">
                          {formatNumber(metric(r, m), 4)}
                        </td>
                      ))}
                      <td className="px-3 py-2">{formatDuration(r.duration_seconds)}</td>
                      <td className="px-3 py-2">
                        <Button size="sm" variant="ghost" onClick={() => openRun(r.id)}>
                          Details
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center gap-2 border-t border-[var(--border)] p-3">
                <Button size="sm" disabled={selected.length < 2} onClick={() => setTab("compare")}>
                  Compare selected ({selected.length})
                </Button>
              </div>
            </Card>
          ) : (
            <EmptyState title="No runs yet">Runs appear here as training progresses.</EmptyState>
          ))}
        {tab === "run" && (
          <QueryState query={run}>
            {(r) => (
              <div className="space-y-4">
                <Card title={`${r.algorithm} · ${r.id.slice(0, 8)}`}>
                  <KeyValue
                    items={[
                      ["Status", <StatusBadge key="s" status={r.status} />],
                      ["Duration", formatDuration(r.duration_seconds)],
                      ...Object.entries(r.metrics).map(([k, v]) => [k, typeof v === "number" ? formatNumber(v, 4) : String(v)] as [string, string]),
                      ["Parameters", <code key="p" className="font-mono text-xs">{JSON.stringify(r.params)}</code>],
                    ]}
                  />
                </Card>
                <RunCharts run={r} />
              </div>
            )}
          </QueryState>
        )}
        {tab === "compare" && <Compare runIds={selected} />}
        {tab === "whatif" && <QueryState query={run}>{(r) => <WhatIf run={r} experiment={experiment} />}</QueryState>}
      </TabPanel>

      <Modal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        title="Register model"
        footer={
          <>
            <Button onClick={() => setRegisterOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => register.mutate()} loading={register.isPending} disabled={!modelName.trim()}>
              Register
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-[var(--text-2)]">
            Registers run <span className="font-mono">{activeRunId?.slice(0, 8)}</span> as a new version. An existing model name adds a version to it.
          </p>
          <TextField label="Model name" value={modelName} onChange={(e) => setModelName(e.target.value)} />
          <TextArea label="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </Modal>
    </div>
  );
}
