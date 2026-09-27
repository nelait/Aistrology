"use client";
/** API-009 canary rollouts: start wizard, step timeline, live canary-vs-baseline metrics, promote / abort. */
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type CanaryRollout, type CanaryWindowStats, type ServingEndpoint } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { CANARY_EVENT_LABELS, canaryTone, parseSteps, stepStates } from "@/lib/canary";
import { formatDate, formatNumber, formatPercent } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, SelectField, Spinner, TextField, cx } from "../ui";

export function CanaryTab({ endpoint }: { endpoint: ServingEndpoint }) {
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ["canary", endpoint.name],
    queryFn: () => api.endpoints.canary(endpoint.name),
    retry: false,
    meta: { silent: true },
    refetchInterval: (query) => (query.state.data?.status === "running" ? 10_000 : false),
  });
  const none = q.error instanceof ApiError && q.error.status === 404;
  const [wizard, setWizard] = useState(false);
  const deployer = can("endpoints.deploy");

  if (q.isLoading) return <Spinner label="Loading canary status…" />;
  if (q.isError && !none) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const rollout = none ? null : q.data ?? null;
  const running = rollout?.status === "running";

  return (
    <div className="space-y-4">
      {rollout && <RolloutCard rollout={rollout} deployer={deployer} />}
      {!running &&
        (deployer ? (
          wizard || !rollout ? (
            <CanaryWizard endpoint={endpoint} onStarted={() => setWizard(false)} onCancel={rollout ? () => setWizard(false) : undefined} />
          ) : (
            <Button variant="primary" onClick={() => setWizard(true)}>
              Start a new canary rollout
            </Button>
          )
        ) : (
          !rollout && <EmptyState title="No canary rollouts">A user with the endpoints.deploy permission can start one.</EmptyState>
        ))}
      <p className="rounded-md bg-[var(--surface-2)] p-3 text-xs text-[var(--text-2)]">
        Each step is evaluated by a delayed job that doesn&apos;t survive API restarts. To keep rollouts moving reliably,{" "}
        <Link href="/schedules?new=serving.canary_step" className="font-medium underline">
          schedule the “Canary steps” job
        </Link>{" "}
        (for example every 5 minutes).
      </p>
    </div>
  );
}

function StatsCell({ s, label }: { s: CanaryWindowStats | undefined; label: string }) {
  if (!s) return <td className="px-3 py-1.5">—</td>;
  return (
    <td className="px-3 py-1.5 tabular-nums" aria-label={label}>
      {formatNumber(s.requests)} req · {s.error_rate === null ? "—" : formatPercent(s.error_rate)} errors · p95 {s.p95_ms === null ? "—" : `${formatNumber(s.p95_ms)} ms`}
    </td>
  );
}

function RolloutCard({ rollout: r, deployer }: { rollout: CanaryRollout; deployer: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<"promote" | "abort" | null>(null);
  const done = (msg: string) => (x: CanaryRollout) => {
    toast.success(msg);
    setConfirm(null);
    qc.setQueryData(["canary", r.endpoint], x);
    qc.invalidateQueries({ queryKey: ["endpoint", r.endpoint] });
  };
  const promote = useMutation({ mutationFn: () => api.endpoints.promoteCanary(r.endpoint), meta: { errorPrefix: "Promote failed" }, onSuccess: done("Candidate promoted to 100 %") });
  const abort = useMutation({ mutationFn: () => api.endpoints.abortCanary(r.endpoint), meta: { errorPrefix: "Abort failed" }, onSuccess: done("Rollout aborted; baseline restored") });
  const states = stepStates(r);
  const running = r.status === "running";
  const t = r.thresholds;
  const live = r.live;
  const canaryBreaches =
    live && live.canary.requests >= t.min_requests
      ? [
          live.canary.error_rate !== null && live.canary.error_rate > t.max_error_rate ? "error rate above the limit" : null,
          live.canary.p95_ms !== null && live.baseline.p95_ms !== null && live.canary.p95_ms - live.baseline.p95_ms > t.max_p95_ms_increase ? "p95 latency increase above the limit" : null,
        ].filter(Boolean)
      : [];

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          Canary: model {r.candidate.model_id.slice(0, 8)} v{r.candidate.version} <Badge tone={canaryTone(r.status)}>{r.status.replace("_", " ")}</Badge>
          {running && <Badge tone="info">{r.weight}% of traffic</Badge>}
        </span>
      }
      actions={
        running &&
        deployer && (
          <>
            <Button size="sm" variant="primary" onClick={() => setConfirm("promote")}>
              Promote now
            </Button>
            <Button size="sm" variant="danger" onClick={() => setConfirm("abort")}>
              Abort
            </Button>
          </>
        )
      }
    >
      <ol className="mb-4 flex flex-wrap items-center gap-1" aria-label="Rollout steps">
        {r.steps.map((s, i) => (
          <li key={i} className="flex items-center gap-1">
            <span
              className={cx(
                "rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums",
                states[i] === "done" && "border-green-600 bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200",
                states[i] === "current" && "border-brand-500 bg-brand-50 text-brand-800 ring-2 ring-brand-500/30 dark:bg-brand-900/40 dark:text-brand-100",
                states[i] === "failed" && "border-red-600 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200",
                states[i] === "pending" && "border-[var(--border)] text-[var(--text-2)]",
              )}
              aria-current={states[i] === "current" ? "step" : undefined}
            >
              {states[i] === "done" ? "✓ " : states[i] === "failed" ? "✕ " : ""}
              {s}%<span className="sr-only"> ({states[i]})</span>
            </span>
            {i < r.steps.length - 1 && <span aria-hidden="true" className="text-[var(--text-2)]">→</span>}
          </li>
        ))}
      </ol>
      <div className="grid gap-3 text-sm md:grid-cols-2">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
          <dt className="text-[var(--text-2)]">Step length</dt>
          <dd>{r.step_minutes !== undefined ? `${formatNumber(r.step_minutes)} min` : "—"}</dd>
          <dt className="text-[var(--text-2)]">Guardrails</dt>
          <dd>
            errors ≤ {formatPercent(t.max_error_rate)}, p95 ≤ baseline + {formatNumber(t.max_p95_ms_increase)} ms, ≥ {formatNumber(t.min_requests)} requests per step
          </dd>
          {running && (
            <>
              <dt className="text-[var(--text-2)]">Step started</dt>
              <dd>{formatDate(r.step_started_at)}</dd>
              <dt className="text-[var(--text-2)]">Next evaluation</dt>
              <dd>{formatDate(r.next_eval_at)}</dd>
            </>
          )}
          {r.reason && (
            <>
              <dt className="text-[var(--text-2)]">Reason</dt>
              <dd>{r.reason}</dd>
            </>
          )}
          {r.finished_at && (
            <>
              <dt className="text-[var(--text-2)]">Finished</dt>
              <dd>{formatDate(r.finished_at)}</dd>
            </>
          )}
        </dl>
        {live && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="mb-1 text-left text-xs font-semibold">This step so far</caption>
              <tbody>
                <tr>
                  <th scope="row" className="px-3 py-1.5 font-medium">Canary</th>
                  <StatsCell s={live.canary} label="Canary metrics" />
                </tr>
                <tr className="border-t border-[var(--border)]">
                  <th scope="row" className="px-3 py-1.5 font-medium">Baseline</th>
                  <StatsCell s={live.baseline} label="Baseline metrics" />
                </tr>
              </tbody>
            </table>
            {live.canary.requests < t.min_requests && <p className="mt-1 text-xs text-[var(--text-2)]">Waiting for {t.min_requests - live.canary.requests} more canary request(s) before this step can pass.</p>}
            {canaryBreaches.length > 0 && <p className="mt-1 text-xs text-red-700 dark:text-red-400">⚠ {canaryBreaches.join(", ")}: the next evaluation will roll back.</p>}
          </div>
        )}
      </div>
      {r.history.length > 0 && (
        <details className="mt-4" open={r.history.length <= 6}>
          <summary className="cursor-pointer text-sm font-medium">Timeline ({r.history.length})</summary>
          <ol className="mt-2 space-y-1 border-l-2 border-[var(--border)] pl-3 text-sm">
            {r.history.map((h, i) => (
              <li key={i}>
                <span className="text-xs text-[var(--text-2)]">{formatDate(h.at)}</span> <strong>{CANARY_EVENT_LABELS[h.event] ?? h.event}</strong>
                {h.weight !== undefined && ` → ${h.weight}%`}
                {h.reason && ` · ${h.reason}`}
                {h.metrics?.canary && (
                  <span className="block text-xs text-[var(--text-2)]">
                    canary {formatNumber(h.metrics.canary.requests)} req, {h.metrics.canary.error_rate === null ? "—" : formatPercent(h.metrics.canary.error_rate)} errors, p95 {formatNumber(h.metrics.canary.p95_ms)} ms
                    {h.metrics.baseline ? ` · baseline p95 ${formatNumber(h.metrics.baseline.p95_ms)} ms` : ""}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => (confirm === "promote" ? promote.mutate() : abort.mutate())}
        title={confirm === "promote" ? "Promote the candidate?" : "Abort the rollout?"}
        danger={confirm === "abort"}
        confirmLabel={confirm === "promote" ? "Promote to 100 %" : "Abort and restore baseline"}
        loading={promote.isPending || abort.isPending}
      >
        <p>{confirm === "promote" ? "The candidate gets all traffic now, skipping the remaining steps." : "The previous routes are restored immediately."}</p>
      </ConfirmDialog>
    </Card>
  );
}

function CanaryWizard({ endpoint, onStarted, onCancel }: { endpoint: ServingEndpoint; onStarted: () => void; onCancel?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const models = useQuery({ queryKey: ["models"], queryFn: api.models.list });
  const [modelId, setModelId] = useState(endpoint.routes[0]?.model_id ?? "");
  const model = useQuery({ queryKey: ["model", modelId], queryFn: () => api.models.get(modelId), enabled: !!modelId });
  const [versionId, setVersionId] = useState("");
  const [steps, setSteps] = useState("5, 25, 50, 100");
  const [stepMinutes, setStepMinutes] = useState("10");
  const [maxErr, setMaxErr] = useState("5");
  const [maxP95, setMaxP95] = useState("200");
  const [minReq, setMinReq] = useState("20");
  const parsed = parseSteps(steps);
  const inRoutes = new Set(endpoint.routes.map((r) => r.model_version_id));
  const versions = (model.data?.versions ?? []).filter((v) => !inRoutes.has(v.id)).sort((a, b) => b.version - a.version);
  const numErr = (v: string, lo: number, hi: number) => (v === "" || !Number.isFinite(Number(v)) || Number(v) < lo || Number(v) > hi ? `Between ${lo} and ${hi}` : null);
  const errors = {
    stepMinutes: numErr(stepMinutes, 0, 10080),
    maxErr: numErr(maxErr, 0, 100),
    maxP95: numErr(maxP95, 0, 600000),
    minReq: numErr(minReq, 1, 1000000) ?? (Number.isInteger(Number(minReq)) ? null : "A whole number"),
  };
  const start = useMutation({
    mutationFn: () =>
      api.endpoints.startCanary(endpoint.name, {
        model_version_id: versionId,
        steps: parsed.steps!,
        step_minutes: Number(stepMinutes),
        max_error_rate: Number(maxErr) / 100,
        max_p95_ms_increase: Number(maxP95),
        min_requests: Number(minReq),
      }),
    meta: { errorPrefix: "Canary not started" },
    onSuccess: (r) => {
      toast.success(`Canary started at ${r.weight}%`);
      qc.setQueryData(["canary", endpoint.name], r);
      qc.invalidateQueries({ queryKey: ["endpoint", endpoint.name] });
      onStarted();
    },
  });
  const ready = !!versionId && !!parsed.steps && Object.values(errors).every((e) => !e);
  return (
    <Card title="Start a canary rollout">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) start.mutate();
        }}
      >
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-1 text-xs font-semibold">1. Candidate</legend>
          <SelectField label="Model" value={modelId} onChange={(e) => { setModelId(e.target.value); setVersionId(""); }} options={(models.data ?? []).map((m) => ({ value: m.id, label: m.name }))} placeholder="Choose a model…" />
          <SelectField
            label="Version"
            required
            value={versionId}
            onChange={(e) => setVersionId(e.target.value)}
            options={versions.map((v) => ({ value: v.id, label: `v${v.version}${v.stage !== "none" ? ` (${v.stage})` : ""}${v.algorithm ? ` · ${v.algorithm}` : ""}` }))}
            placeholder={model.isLoading ? "Loading…" : versions.length ? "Choose a version…" : "No other versions"}
            hint="Versions already serving on this endpoint are hidden"
          />
        </fieldset>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-1 text-xs font-semibold">2. Ramp</legend>
          <TextField label="Traffic steps (%)" value={steps} onChange={(e) => setSteps(e.target.value)} error={parsed.error} hint={parsed.steps ? `Ramp: ${parsed.steps.join("% → ")}%` : undefined} />
          <TextField label="Minutes per step" type="number" min={0} step="any" value={stepMinutes} onChange={(e) => setStepMinutes(e.target.value)} error={errors.stepMinutes} />
        </fieldset>
        <fieldset className="grid gap-3 sm:grid-cols-3">
          <legend className="mb-1 text-xs font-semibold">3. Guardrails (automatic rollback)</legend>
          <TextField label="Max error rate (%)" type="number" min={0} max={100} step="any" value={maxErr} onChange={(e) => setMaxErr(e.target.value)} error={errors.maxErr} hint="Responses with status ≥ 400" />
          <TextField label="Max p95 increase (ms)" type="number" min={0} step="any" value={maxP95} onChange={(e) => setMaxP95(e.target.value)} error={errors.maxP95} hint="Compared with the baseline" />
          <TextField label="Min requests per step" type="number" min={1} value={minReq} onChange={(e) => setMinReq(e.target.value)} error={errors.minReq} hint="Fewer → the step is held" />
        </fieldset>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={start.isPending} disabled={!ready}>
            Start rollout at {parsed.steps?.[0] ?? "—"}%
          </Button>
          {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        </div>
        <p className="text-xs text-[var(--text-2)]">While a rollout runs, the endpoint&apos;s routes can&apos;t be edited. The current routes share the remaining traffic proportionally.</p>
      </form>
    </Card>
  );
}
