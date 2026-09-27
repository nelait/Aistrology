"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, API_URL, type Job, type ServingEndpoint, type SignatureField } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { saveBlob } from "@/lib/data";
import { formatNumber, formatPercent } from "@/lib/format";
import { coerce } from "@/lib/signature";
import { useEndpointFields } from "@/components/useEndpointFields";
import { SignatureInput } from "@/components/SignatureInput";
import { useToast } from "@/lib/toast";
import { DeployForm } from "@/components/DeployForm";
import { DriftTab } from "@/components/endpoints/DriftTab";
import { ForecastTry } from "@/components/endpoints/ForecastTry";
import { CanaryTab } from "@/components/endpoints/CanaryTab";
import { SseTry, WsConsole } from "@/components/endpoints/StreamingTry";
import { formatPrediction, isAnomalyPrediction } from "@/lib/predictions";
import { FileDrop } from "@/components/FileDrop";
import { JobProgress } from "@/components/JobProgress";
import { Badge, Button, Card, Checkbox, CodeBlock, ConfirmDialog, KeyValue, Modal, PageHeader, QueryState, SelectField, StatTile, TabPanel, Tabs, TextArea } from "@/components/ui";

export default function EndpointPage() {
  const { name } = useParams<{ name: string }>();
  const endpointName = decodeURIComponent(name);
  const q = useQuery({ queryKey: ["endpoint", endpointName], queryFn: () => api.endpoints.get(endpointName) });
  return <QueryState query={q}>{(e) => <EndpointView endpoint={e} />}</QueryState>;
}

function snippets(name: string, fields: SignatureField[]) {
  const example = Object.fromEntries(fields.map((f) => [f.name, /(int|float|number|double)/i.test(f.type) ? 0 : /bool/i.test(f.type) ? false : "value"]));
  const body = JSON.stringify({ instances: [example] });
  const url = `${API_URL}/v1/endpoints/${name}/predict`;
  return {
    curl: `curl -X POST '${url}' \\\n  -H 'X-API-Key: ap_live_…' \\\n  -H 'Content-Type: application/json' \\\n  -d '${body}'`,
    python: `from analytics_platform import Client\n\nclient = Client(api_key="ap_live_…", base_url="${API_URL}")\nresult = client.endpoints.predict(\n    "${name}",\n    instances=[${JSON.stringify(example)}],\n)\nprint(result.predictions)`,
    js: `const res = await fetch("${url}", {\n  method: "POST",\n  headers: { "X-API-Key": process.env.AP_API_KEY, "Content-Type": "application/json" },\n  body: JSON.stringify(${body}),\n});\nconst { predictions } = await res.json();`,
  };
}

function EndpointView({ endpoint }: { endpoint: ServingEndpoint }) {
  const { can } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState("overview");
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { fields, signature } = useEndpointFields(endpoint.name);
  const problemType = typeof signature?.problem_type === "string" ? signature.problem_type : null;
  const forecasting = problemType === "forecasting";
  const metrics = useQuery({ queryKey: ["endpoint-metrics", endpoint.name], queryFn: () => api.endpoints.metrics(endpoint.name), refetchInterval: 15_000 });
  const remove = useMutation({
    mutationFn: () => api.endpoints.remove(endpoint.name),
    onSuccess: () => {
      toast.success("Endpoint deleted");
      qc.invalidateQueries({ queryKey: ["endpoints"] });
      router.push("/endpoints");
    },
  });
  const pause = useMutation({
    mutationFn: () => api.endpoints.patch(endpoint.name, { status: endpoint.status === "paused" ? "active" : "paused" }),
    onSuccess: (e) => {
      qc.setQueryData(["endpoint", endpoint.name], e);
      toast.success(`Endpoint ${e.status}`);
    },
  });
  const code = snippets(endpoint.name, fields);
  const openapiDownload = async () => {
    try {
      const doc = await api.endpoints.openapi(endpoint.name);
      saveBlob(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }), `${endpoint.name}-openapi.json`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Download failed");
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumb={
          <>
            <Link href="/endpoints" className="hover:underline">
              Endpoints
            </Link>{" "}
            / {endpoint.name}
          </>
        }
        title={<span className="font-mono">{endpoint.name}</span>}
        description={
          <>
            {endpoint.routes.map((r, i) => (
              <span key={r.model_version_id}>
                {i > 0 && " · "}
                <Link href={`/models/${r.model_id}`} className="underline">
                  {r.model_id.slice(0, 8)} v{r.version}
                </Link>
                {endpoint.routes.length > 1 && ` (${r.weight}%)`}
              </span>
            ))}{" "}
            · <Badge tone={endpoint.status === "active" ? "good" : "warning"}>{endpoint.status}</Badge>
          </>
        }
        actions={
          can("endpoints.deploy") && (
            <>
              <Button onClick={() => pause.mutate()} loading={pause.isPending}>
                {endpoint.status === "paused" ? "Resume" : "Pause"}
              </Button>
              <Button onClick={() => setEditOpen(true)}>Edit routes &amp; settings</Button>
              <Button variant="danger" onClick={() => setDeleteOpen(true)}>
                Delete
              </Button>
            </>
          )
        }
      />
      <Tabs
        label="Endpoint sections"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "try", label: "Try it" },
          { id: "streaming", label: "Streaming", hidden: !can("endpoints.predict") },
          { id: "canary", label: "Canary" },
          { id: "drift", label: "Drift", hidden: forecasting },
          { id: "batch", label: "Batch prediction", hidden: forecasting },
          { id: "code", label: "Code & API docs" },
        ]}
      />
      <TabPanel id={tab}>
        {tab === "overview" && (
          <div className="space-y-4">
            <QueryState query={metrics}>
              {(m) => (
                <>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                    <StatTile label="Requests" value={formatNumber(m.requests)} sub={m.window_hours ? `last ${m.window_hours} h` : undefined} />
                    <StatTile label="Error rate" value={m.requests ? formatPercent(m.errors / m.requests) : "—"} sub={`${formatNumber(m.errors)} errors`} tone={m.requests && m.errors / m.requests > 0.05 ? "critical" : undefined} />
                    <StatTile label="p50 latency" value={m.p50_ms !== null ? `${formatNumber(m.p50_ms)} ms` : "—"} />
                    <StatTile label="p95 latency" value={m.p95_ms !== null ? `${formatNumber(m.p95_ms)} ms` : "—"} />
                    <StatTile label="p99 latency" value={m.p99_ms !== null ? `${formatNumber(m.p99_ms)} ms` : "—"} />
                  </div>
                  {Object.keys(m.by_version ?? {}).length > 0 && (
                    <Card title="By version" bodyClassName="p-0 overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-[var(--surface-2)] text-xs">
                          <tr>
                            <th scope="col" className="px-3 py-2">Version</th>
                            <th scope="col" className="px-3 py-2">Requests</th>
                            <th scope="col" className="px-3 py-2">Errors</th>
                            <th scope="col" className="px-3 py-2">p50</th>
                            <th scope="col" className="px-3 py-2">p95</th>
                            <th scope="col" className="px-3 py-2">p99</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(m.by_version).map(([v, s]) => (
                            <tr key={v} className="border-t border-[var(--border)]">
                              <td className="px-3 py-2">{v}</td>
                              <td className="px-3 py-2">{formatNumber(s.requests)}</td>
                              <td className="px-3 py-2">{formatNumber(s.errors)}</td>
                              <td className="px-3 py-2">{formatNumber(s.p50_ms)}</td>
                              <td className="px-3 py-2">{formatNumber(s.p95_ms)}</td>
                              <td className="px-3 py-2">{formatNumber(s.p99_ms)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </Card>
                  )}
                </>
              )}
            </QueryState>
            <Card title="Configuration">
              <KeyValue
                items={[
                  ["URL", <code key="u" className="break-all font-mono text-xs">{endpoint.url}</code>],
                  ["Routes", endpoint.routes.map((r) => `v${r.version} (${r.weight}%)`).join(", ")],
                  ["Min replicas", String(endpoint.min_replicas ?? "—")],
                  ["Payload logging", endpoint.log_payloads ? "On (PII redacted)" : "Off"],
                  ["CORS origins", endpoint.cors_origins?.join(", ") || "—"],
                  ["Inputs", fields.map((f) => `${f.name}:${f.type}`).join(", ") || "unknown"],
                ]}
              />
            </Card>
          </div>
        )}
        {tab === "try" && (forecasting ? <ForecastTry name={endpoint.name} signature={signature} /> : <TryIt name={endpoint.name} fields={fields} explainable={problemType !== "clustering" && problemType !== "anomaly"} />)}
        {tab === "streaming" && (
          <div className="space-y-4">
            <SseTry name={endpoint.name} fields={fields} forecasting={forecasting} />
            <WsConsole name={endpoint.name} fields={fields} forecasting={forecasting} />
          </div>
        )}
        {tab === "canary" && <CanaryTab endpoint={endpoint} />}
        {tab === "drift" && <DriftTab name={endpoint.name} />}
        {tab === "batch" && <Batch name={endpoint.name} />}
        {tab === "code" && (
          <div className="space-y-4">
            <Card
              title="OpenAPI"
              actions={
                <Button size="sm" onClick={openapiDownload}>
                  Download openapi.json
                </Button>
              }
            >
              <p className="text-sm">
                Machine-readable docs for this endpoint:{" "}
                <a href={api.endpoints.openapiUrl(endpoint.name)} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-xs text-brand-600 underline dark:text-brand-300">
                  {api.endpoints.openapiUrl(endpoint.name)}
                </a>{" "}
                (requires an API key).
              </p>
            </Card>
            <Card title="curl">
              <CodeBlock code={code.curl} label="curl example" />
            </Card>
            <Card title="Python SDK">
              <CodeBlock code={code.python} label="Python example" />
            </Card>
            <Card title="JavaScript">
              <CodeBlock code={code.js} label="JavaScript example" />
            </Card>
            <p className="text-xs text-[var(--text-2)]">
              Create an API key with the “endpoints.predict” scope in <Link href="/admin?tab=keys" className="underline">Admin → API keys</Link>.
            </p>
          </div>
        )}
      </TabPanel>

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit endpoint" size="lg">
        {editOpen && (
          <DeployForm
            existing={endpoint}
            onDone={() => {
              toast.success("Endpoint updated");
              setEditOpen(false);
              qc.invalidateQueries({ queryKey: ["endpoint", endpoint.name] });
            }}
          />
        )}
      </Modal>
      <ConfirmDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} onConfirm={() => remove.mutate()} title="Delete endpoint?" danger confirmLabel="Delete" typedConfirmation={endpoint.name} loading={remove.isPending}>
        <p>Clients calling this endpoint will start receiving errors.</p>
      </ConfirmDialog>
    </div>
  );
}

function TryIt({ name, fields, explainable = true }: { name: string; fields: SignatureField[]; explainable?: boolean }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState('{\n  "instances": [{}]\n}');
  const [explain, setExplain] = useState(false);
  const predict = useMutation({
    mutationFn: () => {
      if (fields.length) return api.endpoints.predict(name, [Object.fromEntries(fields.map((f) => [f.name, coerce(values[f.name] ?? "", f.type)]))], explain);
      const parsed = JSON.parse(raw) as { instances: Record<string, unknown>[] };
      return api.endpoints.predict(name, parsed.instances, explain);
    },
    meta: { errorPrefix: "Prediction failed" },
  });
  const r = predict.data;
  return (
    <Card title="Try a prediction">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          predict.mutate();
        }}
      >
        {fields.length ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {fields.map((f) => (
              <SignatureInput key={f.name} field={f} value={values[f.name] ?? ""} onChange={(v) => setValues((x) => ({ ...x, [f.name]: v }))} />
            ))}
          </div>
        ) : (
          <TextArea label="Request body (JSON)" hint="No model signature found; write the instances by hand." mono rows={8} value={raw} onChange={(e) => setRaw(e.target.value)} />
        )}
        {explainable && <Checkbox label="Include explanation (SHAP)" checked={explain} onChange={(e) => setExplain(e.target.checked)} />}
        <Button type="submit" variant="primary" loading={predict.isPending}>
          Predict
        </Button>
      </form>
      {r && (
        <div className="mt-4 space-y-2" aria-live="polite">
          {isAnomalyPrediction(r.predictions[0]) ? (
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={r.predictions[0].is_anomaly ? "critical" : "good"}>
                <span aria-hidden="true">{r.predictions[0].is_anomaly ? "⚠" : "✓"}</span> {r.predictions[0].is_anomaly ? "Anomaly" : "Normal"}
              </Badge>
              <span>
                is_anomaly <code>{String(r.predictions[0].is_anomaly)}</code> · score <strong className="tabular-nums">{formatNumber(r.predictions[0].score, 4)}</strong>
                {typeof r.threshold === "number" && <> (threshold {formatNumber(r.threshold, 4)}; higher = more anomalous)</>}
              </span>
              <Badge>model v{typeof r.model_version === "object" ? r.model_version.version : String(r.model_version)}</Badge>
            </p>
          ) : (
            <p>
              Prediction: <strong>{formatPrediction(r.predictions[0])}</strong>{" "}
              <Badge>model v{typeof r.model_version === "object" ? r.model_version.version : String(r.model_version)}</Badge>
            </p>
          )}
          {r.probabilities?.[0] && (
            <ul className="text-sm">
              {r.probabilities[0].map((p, i) => (
                <li key={i}>
                  {String(r.classes?.[i] ?? i)}: {formatPercent(p)}
                </li>
              ))}
            </ul>
          )}
          {r.shap?.[0] && (
            <div>
              <p className="text-sm font-medium">Top contributions (SHAP)</p>
              <ul className="text-sm">
                {Object.entries(r.shap[0])
                  .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
                  .slice(0, 8)
                  .map(([k, v]) => (
                    <li key={k} className="tabular-nums">
                      {k}: <span className={v >= 0 ? "text-brand-700 dark:text-brand-300" : "text-red-700 dark:text-red-400"}>{v >= 0 ? "+" : ""}{formatNumber(v)}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-sm">Raw response</summary>
            <CodeBlock code={JSON.stringify(r, null, 2)} />
          </details>
        </div>
      )}
    </Card>
  );
}

function Batch({ name }: { name: string }) {
  const toast = useToast();
  const [job, setJob] = useState<Job | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [datasetId, setDatasetId] = useState("");
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api.datasets.list() });
  const upload = useMutation({
    mutationFn: (file: File) => api.endpoints.batchFile(name, file, (p) => setProgress(p.total ? p.loaded / p.total : null)),
    meta: { errorPrefix: "Batch upload failed" },
    onSuccess: (j) => {
      setJob(j);
      setProgress(null);
    },
  });
  const fromDataset = useMutation({ mutationFn: () => api.endpoints.batchDataset(name, datasetId), onSuccess: setJob });
  const download = useMutation({
    mutationFn: () => api.endpoints.batchResult(name, job!.id),
    onSuccess: ({ blob, filename }) => {
      saveBlob(blob, filename ?? `${name}-predictions.csv`);
      toast.success("Predictions downloaded");
    },
  });
  return (
    <Card title="Batch prediction">
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <FileDrop multiple={false} accept=".csv,.parquet,.json,.jsonl" label="Drop a CSV/Parquet file to score" onFiles={(f) => upload.mutate(f[0])} disabled={upload.isPending} />
          {progress !== null && <p className="mt-2 text-xs">Uploading… {Math.round(progress * 100)}%</p>}
        </div>
        <div className="flex flex-col gap-2">
          <SelectField label="…or score a dataset" value={datasetId} onChange={(e) => setDatasetId(e.target.value)} options={(datasets.data ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="Choose a dataset…" />
          <Button onClick={() => fromDataset.mutate()} disabled={!datasetId} loading={fromDataset.isPending}>
            Start batch job
          </Button>
        </div>
      </div>
      {job && (
        <div className="mt-4 space-y-2">
          <JobProgress jobId={job.id} title="Batch prediction" onDone={(j) => setJob(j)} />
          {job.status === "succeeded" && (
            <Button variant="primary" onClick={() => download.mutate()} loading={download.isPending}>
              Download predictions (CSV)
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
