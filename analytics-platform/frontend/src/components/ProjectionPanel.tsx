"use client";
/** FE-005a: 2-D UMAP / t-SNE / PCA scatter of a dataset sample, or of a run's rows coloured by its predictions. */
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, type ProjectionMethod, type ProjectionRequest } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { colorScale, projectionOption } from "@/lib/projection";
import { useTheme } from "@/lib/theme";
import { EChart } from "./charts/EChart";
import { Badge, Button, Card, MultiSelect, SelectField, TextField, toOptions } from "./ui";

const METHODS: { value: ProjectionMethod; label: string }[] = [
  { value: "auto", label: "Auto (UMAP if installed, else t-SNE)" },
  { value: "umap", label: "UMAP" },
  { value: "tsne", label: "t-SNE" },
  { value: "pca", label: "PCA (fast, linear)" },
];

export function ProjectionPanel({ target, columns = [] }: { target: { kind: "dataset"; id: string; version?: number } | { kind: "run"; id: string }; columns?: string[] }) {
  const { dark } = useTheme();
  const [method, setMethod] = useState<ProjectionMethod>("auto");
  const [sample, setSample] = useState("2000");
  const [perplexity, setPerplexity] = useState("30");
  const [neighbors, setNeighbors] = useState("15");
  const [seed, setSeed] = useState("0");
  const [colorBy, setColorBy] = useState("");
  const [features, setFeatures] = useState<string[]>([]);
  const [colorMode, setColorMode] = useState<"predicted" | "actual">("predicted");

  const run = useMutation({
    mutationFn: () => {
      const body: ProjectionRequest = {
        method,
        sample: Math.min(5000, Math.max(10, Number(sample) || 2000)),
        perplexity: Number(perplexity) || 30,
        n_neighbors: Number(neighbors) || 15,
        seed: Number(seed) || 0,
      };
      if (target.kind === "dataset") {
        if (colorBy) body.color_by = colorBy;
        if (features.length) body.features = features;
        return api.datasets.projection(target.id, body, target.version);
      }
      return api.training.projection(target.id, body);
    },
    meta: { silent: true },
  });

  const data = run.data;
  const color = target.kind === "run" && colorMode === "actual" && data?.actual ? data.actual : data?.color;
  const option = useMemo(() => (data ? projectionOption(data.x, data.y, color, { dark, name: data.color_by ?? "rows", xName: `${data.method} 1`, yName: `${data.method} 2` }) : null), [data, color, dark]);
  const scale = colorScale(color);
  const err = run.error;
  const errText = err instanceof ApiError && err.status === 409 ? `Not available: ${err.message}` : err instanceof Error ? err.message : err ? String(err) : null;

  return (
    <Card title={target.kind === "run" ? "2-D projection of the run's rows" : "2-D projection"}>
      <form
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        <SelectField label="Method" value={method} onChange={(e) => setMethod(e.target.value as ProjectionMethod)} options={METHODS} />
        <TextField label="Sample rows" type="number" min={10} max={5000} value={sample} onChange={(e) => setSample(e.target.value)} hint="10–5,000 rows" />
        {(method === "tsne" || method === "auto") && <TextField label="Perplexity (t-SNE)" type="number" min={2} max={100} value={perplexity} onChange={(e) => setPerplexity(e.target.value)} />}
        {(method === "umap" || method === "auto") && <TextField label="Neighbours (UMAP)" type="number" min={2} max={200} value={neighbors} onChange={(e) => setNeighbors(e.target.value)} />}
        <TextField label="Seed" type="number" min={0} value={seed} onChange={(e) => setSeed(e.target.value)} />
        {target.kind === "dataset" && (
          <>
            <SelectField label="Colour by" value={colorBy} onChange={(e) => setColorBy(e.target.value)} options={toOptions(columns)} placeholder="(none)" />
            <div className="sm:col-span-2 lg:col-span-4">
              <MultiSelect label="Features (empty = all non-PII columns)" options={toOptions(columns)} value={features} onChange={setFeatures} maxHeight={120} hint="PII-tagged columns are only used when you list them here." />
            </div>
          </>
        )}
        <div className="flex items-end sm:col-span-2 lg:col-span-4">
          <Button type="submit" variant="primary" loading={run.isPending}>
            {data ? "Recompute" : "Compute projection"}
          </Button>
        </div>
      </form>
      {errText && (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
          {errText}
        </p>
      )}
      {data && option && (
        <div className="mt-4 space-y-2" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-2)]">
            <Badge tone="info">{data.method}</Badge>
            <span>
              {formatNumber(data.n)} of {formatNumber(data.total_rows)} rows
            </span>
            {data.features?.length ? <span>· {data.features.length} features</span> : null}
            {target.kind === "run" && data.actual && (
              <SelectField
                label="Colour"
                srOnlyLabel
                value={colorMode}
                onChange={(e) => setColorMode(e.target.value as "predicted" | "actual")}
                options={[
                  { value: "predicted", label: "Colour: predicted" },
                  { value: "actual", label: "Colour: actual target" },
                ]}
              />
            )}
            {scale.kind === "continuous" && <span>· colour scale {formatNumber(scale.min)} – {formatNumber(scale.max)}</span>}
          </div>
          <EChart option={option} height={420} ariaLabel={`${data.method} projection scatter of ${data.n} rows`} />
          <p className="text-xs text-[var(--text-2)]">{data.note ?? "Projections are for visualization only: distances and cluster sizes are distorted."}</p>
        </div>
      )}
    </Card>
  );
}
