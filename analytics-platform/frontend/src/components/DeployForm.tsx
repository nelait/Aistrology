"use client";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type EndpointCreate, type EndpointRoute, type ServingEndpoint } from "@/lib/api";
import { Button, Checkbox, SelectField, TextField } from "./ui";


/** One-click deploy with optional A/B routes (API-001, MGT-008). */
export function DeployForm({ initialModel, initialVersion, onDone, existing }: { initialModel?: string; initialVersion?: number; onDone: (e: ServingEndpoint) => void; existing?: ServingEndpoint }) {
  const models = useQuery({ queryKey: ["models"], queryFn: api.models.list });
  const [name, setName] = useState(existing?.name ?? "");
  const [modelId, setModelId] = useState(existing?.routes[0]?.model_id ?? initialModel ?? "");
  const [version, setVersion] = useState(existing?.routes.length === 1 ? String(existing.routes[0].version) : initialVersion ? String(initialVersion) : "");
  const [ab, setAb] = useState((existing?.routes.length ?? 0) > 1);
  const [routes, setRoutes] = useState<EndpointRoute[]>(existing?.routes.map((r) => ({ model_version_id: r.model_version_id, weight: r.weight })) ?? []);
  const [minReplicas, setMinReplicas] = useState(String(existing?.min_replicas ?? 1));
  const [logPayloads, setLogPayloads] = useState(existing?.log_payloads ?? false);
  const [cors, setCors] = useState((existing?.cors_origins ?? []).join(", "));
  const detail = useQuery({ queryKey: ["model", modelId], queryFn: () => api.models.get(modelId), enabled: !!modelId });
  const versions = detail.data?.versions ?? [];

  useEffect(() => {
    if (!existing && !name && modelId) {
      const m = models.data?.find((x) => x.id === modelId);
      if (m) setName(m.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-"));
    }
  }, [modelId, models.data, name, existing]);

  const total = routes.reduce((a, r) => a + (Number(r.weight) || 0), 0);

  const submit = useMutation({
    mutationFn: () => {
      const abRoutes = routes.map((r) => ({ model_version_id: r.model_version_id, weight: Math.round(Number(r.weight)) }));
      const settings = {
        min_replicas: Number(minReplicas) || 0,
        log_payloads: logPayloads,
        cors_origins: cors
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
      if (existing) {
        // PATCH only accepts routes: a single version is a 100% route.
        const single = versions.find((v) => String(v.version) === version) ?? versions.find((v) => v.stage === "production");
        const patchRoutes = ab ? abRoutes : single ? [{ model_version_id: single.id, weight: 100 }] : undefined;
        return api.endpoints.patch(existing.name, { ...settings, routes: patchRoutes });
      }
      const body: EndpointCreate = ab
        ? { name, routes: abRoutes, ...settings }
        : { name, model_id: modelId, version: version ? Number(version) : undefined, ...settings };
      return api.endpoints.create(body);
    },
    meta: { errorPrefix: existing ? "Endpoint not updated" : "Deployment failed" },
    onSuccess: onDone,
  });

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit.mutate();
      }}
    >
      <TextField label="Endpoint name" required disabled={!!existing} value={name} onChange={(e) => setName(e.target.value)} hint="Lowercase letters, digits and dashes; part of the URL." pattern="[a-z0-9][a-z0-9-]*" />
      <SelectField label="Model" required value={modelId} disabled={!!existing} onChange={(e) => { setModelId(e.target.value); setVersion(""); setRoutes([]); }} options={(models.data ?? []).map((m) => ({ value: m.id, label: m.name }))} placeholder="Choose a model…" />
      <Checkbox label="A/B test: split traffic between versions" checked={ab} onChange={(e) => {
        setAb(e.target.checked);
        if (e.target.checked && !routes.length && versions.length) setRoutes(versions.slice(0, 2).map((v, i) => ({ model_version_id: v.id, weight: i === 0 ? 90 : 10 })));
      }} />
      {!ab ? (
        <SelectField
          label="Version"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          options={versions.map((v) => ({ value: String(v.version), label: `v${v.version} (${v.stage})` }))}
          placeholder="Production stage (default)"
        />
      ) : (
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-[var(--text-2)]">Routes</legend>
          {routes.map((r, i) => (
            <div key={i} className="flex items-end gap-2">
              <SelectField
                className="flex-1"
                label={`Route ${i + 1} version`}
                value={r.model_version_id}
                onChange={(e) => setRoutes(routes.map((x, j) => (j === i ? { ...x, model_version_id: e.target.value } : x)))}
                options={versions.map((v) => ({ value: v.id, label: `v${v.version} (${v.stage})` }))}
                placeholder="Version…"
              />
              <TextField className="w-24" label="Weight %" type="number" min={0} max={100} step={1} value={r.weight} onChange={(e) => setRoutes(routes.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)))} />
              <Button size="sm" variant="ghost" aria-label={`Remove route ${i + 1}`} onClick={() => setRoutes(routes.filter((_, j) => j !== i))}>
                ✕
              </Button>
            </div>
          ))}
          <Button size="sm" onClick={() => setRoutes([...routes, { model_version_id: versions[0] ? versions[0].id : "", weight: 0 }])} disabled={!versions.length}>
            + Add route
          </Button>
          {routes.length > 0 && total !== 100 && (
            <p role="alert" className="text-xs text-red-700 dark:text-red-400">
              Weights must add up to 100 (currently {total}).
            </p>
          )}
        </fieldset>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Min replicas" type="number" min={0} value={minReplicas} onChange={(e) => setMinReplicas(e.target.value)} hint="0 = scale to zero" />
        <TextField label="CORS origins" value={cors} onChange={(e) => setCors(e.target.value)} placeholder="https://app.example.com" hint="Comma-separated" />
      </div>
      <Checkbox label="Log request/response bodies" hint="Off by default; PII is redacted (MGT-006)." checked={logPayloads} onChange={(e) => setLogPayloads(e.target.checked)} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={submit.isPending} disabled={!name || !modelId || (ab && (routes.length === 0 || total !== 100 || routes.some((r) => !r.model_version_id)))}>
          {existing ? "Save changes" : "Deploy"}
        </Button>
      </div>
    </form>
  );
}
