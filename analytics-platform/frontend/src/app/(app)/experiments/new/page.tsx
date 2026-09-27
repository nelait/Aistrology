"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ExperimentCreate, type ForecastConfig, type JsonValue, type ProblemType, type TrainingConfig, type TrainingTemplate } from "@/lib/api";
import { schemaColumns } from "@/lib/data";
import { formatDate, formatNumber } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { RequirePermission } from "@/components/RequirePermission";
import { HyperparameterInputs } from "@/components/experiments/HyperparameterInputs";
import { Badge, Button, Card, Checkbox, ConfirmDialog, InfoTip, Modal, MultiSelect, PageHeader, SelectField, TextArea, TextField, toOptions } from "@/components/ui";

type Preprocessing = ExperimentCreate["preprocessing"];

interface Form {
  name: string;
  dataset_id: string;
  target: string;
  features: string[];
  problem_type: ProblemType | "";
  split: ExperimentCreate["split"];
  cv: ExperimentCreate["cv"];
  algorithms: string[];
  automl: ExperimentCreate["automl"];
  preprocessing: Omit<Preprocessing, "auto_features" | "pca">;
  fsEnabled: boolean;
  autoFeatures: { enabled: boolean; interactions: boolean; polynomial: boolean; top_k: number };
  pca: { enabled: boolean; n_components: number };
  class_imbalance: ExperimentCreate["class_imbalance"];
  max_training_seconds: number;
  seed: number;
  ensemble: { mode: "auto" | "on" | "off"; methods: ("stacking" | "voting")[]; top_k: number };
  clustering: { k_min: number; k_max: number; max_fit_rows: number };
  forecast: ForecastConfig;
}

const DEFAULT: Form = {
  name: "",
  dataset_id: "",
  target: "",
  features: [],
  problem_type: "",
  split: { method: "random", test_size: 0.2, validation_size: 0 },
  cv: { method: "kfold", folds: 5 },
  algorithms: [],
  automl: { enabled: true, strategy: "tpe", n_trials: 20, timeout_seconds: 300 },
  preprocessing: { encoding: "onehot", scaling: "standard", impute: "median", feature_selection: { method: "mutual_info", k: 20 } },
  fsEnabled: false,
  autoFeatures: { enabled: false, interactions: true, polynomial: true, top_k: 5 },
  pca: { enabled: false, n_components: 0.95 },
  class_imbalance: "none",
  max_training_seconds: 600,
  seed: 42,
  ensemble: { mode: "auto", methods: ["stacking", "voting"], top_k: 3 },
  clustering: { k_min: 2, k_max: 8, max_fit_rows: 5000 },
  forecast: { time_column: "", frequency: "", horizon: 12, season_length: null, backtest_folds: 3, interval_level: 0.9, aggregation: "mean" },
};

type FsMethod = NonNullable<Preprocessing["feature_selection"]>["method"];

const SUPERVISED = new Set(["binary", "multiclass", "regression"]);

/** The TrainingConfig sent to the API (also what a template stores). */
function buildConfig(form: Form, hp: Record<string, Record<string, JsonValue>>, problem: ProblemType | undefined, includeTarget = true): TrainingConfig {
  const clustering = problem === "clustering";
  const forecasting = problem === "forecasting";
  const supervised = !clustering && !forecasting;
  const isClassification = problem === "binary" || problem === "multiclass";
  return {
    ...(includeTarget && !clustering && form.target ? { target: form.target } : {}),
    ...(includeTarget && form.features.length && !forecasting ? { features: form.features } : {}),
    problem_type: problem,
    ...(supervised
      ? {
          split: { ...form.split, time_column: form.split.method === "time" ? form.split.time_column : undefined },
          cv: form.cv,
        }
      : {}),
    algorithms: form.algorithms.length ? form.algorithms : undefined,
    automl: form.automl,
    hyperparameters: Object.keys(hp).length ? Object.fromEntries(Object.entries(hp).filter(([k, v]) => form.algorithms.includes(k) && Object.keys(v).length)) : undefined,
    preprocessing: {
      ...form.preprocessing,
      feature_selection: form.fsEnabled && supervised ? form.preprocessing.feature_selection : undefined,
      auto_features: form.autoFeatures.enabled && !forecasting ? { interactions: form.autoFeatures.interactions, polynomial: form.autoFeatures.polynomial, top_k: form.autoFeatures.top_k } : undefined,
      pca: form.pca.enabled && !forecasting ? { n_components: form.pca.n_components } : undefined,
    },
    class_imbalance: isClassification ? form.class_imbalance : "none",
    max_training_seconds: form.max_training_seconds,
    seed: form.seed,
    ...(supervised ? { ensemble: { enabled: form.ensemble.mode === "auto" ? null : form.ensemble.mode === "on", methods: form.ensemble.methods, top_k: form.ensemble.top_k } } : {}),
    ...(clustering ? { clustering: form.clustering } : {}),
    ...(forecasting ? { forecast: { ...form.forecast, frequency: form.forecast.frequency || null, season_length: form.forecast.season_length || null } } : {}),
  };
}

/** Fill the form from a template's config (target/features only when they fit the dataset). */
function formFromConfig(form: Form, c: TrainingConfig, columns: string[]): { form: Form; hp: Record<string, Record<string, JsonValue>> } {
  const pre = c.preprocessing;
  return {
    form: {
      ...form,
      target: c.target && columns.includes(c.target) ? c.target : form.target,
      features: c.features?.length ? c.features.filter((f) => columns.includes(f)) : form.features,
      problem_type: c.problem_type ?? "",
      split: { ...DEFAULT.split, ...c.split },
      cv: { ...DEFAULT.cv, ...c.cv },
      algorithms: c.algorithms ?? [],
      automl: { ...DEFAULT.automl, ...c.automl },
      preprocessing: { encoding: pre?.encoding ?? "onehot", scaling: pre?.scaling ?? "standard", impute: pre?.impute ?? "median", feature_selection: pre?.feature_selection ?? DEFAULT.preprocessing.feature_selection },
      fsEnabled: !!pre?.feature_selection,
      autoFeatures: pre?.auto_features ? { enabled: true, ...pre.auto_features } : DEFAULT.autoFeatures,
      pca: pre?.pca ? { enabled: true, n_components: pre.pca.n_components } : DEFAULT.pca,
      class_imbalance: c.class_imbalance ?? "none",
      max_training_seconds: c.max_training_seconds ?? 600,
      seed: c.seed ?? 42,
      ensemble: c.ensemble ? { mode: c.ensemble.enabled === null ? "auto" : c.ensemble.enabled ? "on" : "off", methods: c.ensemble.methods, top_k: c.ensemble.top_k } : DEFAULT.ensemble,
      clustering: { ...DEFAULT.clustering, ...c.clustering },
      forecast: { ...DEFAULT.forecast, ...c.forecast, frequency: c.forecast?.frequency ?? "" },
    },
    hp: (c.hyperparameters as Record<string, Record<string, JsonValue>>) ?? {},
  };
}

export default function NewExperimentPage() {
  return (
    <RequirePermission perm="models.train">
      <NewExperiment />
    </RequirePermission>
  );
}

function NewExperiment() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>({ ...DEFAULT, dataset_id: params.get("dataset") ?? "" });
  const [hp, setHp] = useState<Record<string, Record<string, JsonValue>>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);

  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api.datasets.list() });
  const algorithms = useQuery({ queryKey: ["algorithms"], queryFn: api.training.algorithms, staleTime: Infinity });
  const dataset = datasets.data?.find((d) => d.id === form.dataset_id);
  const columns = useMemo(() => schemaColumns(dataset?.schema), [dataset]);
  const timeColumns = columns.filter((c) => c.type === "date" || c.type === "datetime");
  const profile = useQuery({ queryKey: ["profile", form.dataset_id, dataset?.version], queryFn: () => api.datasets.profile(form.dataset_id), enabled: !!dataset && dataset.tables.length <= 1, meta: { silent: true } });

  const wantsClustering = form.problem_type === "clustering";
  const detect = useQuery({
    queryKey: ["detect", form.dataset_id, form.target],
    queryFn: () => api.training.detect(form.dataset_id, form.target),
    enabled: !!form.dataset_id && !!form.target && !wantsClustering,
  });

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (dataset && !form.name) set("name", `${dataset.name} model`);
  }, [dataset, form.name]);

  useEffect(() => {
    if (form.target) setForm((f) => ({ ...f, features: columns.map((c) => c.name).filter((c) => c !== f.target) }));
    else if (form.problem_type === "clustering") setForm((f) => ({ ...f, features: columns.map((c) => c.name) }));
  }, [form.target, form.problem_type, columns]);

  const problem: ProblemType | undefined = (form.problem_type || (wantsClustering ? "clustering" : detect.data?.problem_type)) as ProblemType | undefined;
  const clustering = problem === "clustering";
  const forecasting = problem === "forecasting";
  const supervised = !!problem && SUPERVISED.has(problem);
  const isClassification = problem === "binary" || problem === "multiclass";
  const available = (algorithms.data ?? []).filter((a) => !problem || a.problem_types.includes(problem)).filter((a) => !a.id.endsWith("_ensemble"));
  const forecastAlt = detect.data?.alternatives?.find((a) => a.problem_type === "forecasting");

  const leakage = useMemo(() => {
    const row = profile.data?.correlations?.[form.target];
    if (!row || !supervised) return [];
    return Object.entries(row)
      .filter(([c, v]) => c !== form.target && form.features.includes(c) && v !== null && Math.abs(v) > 0.95)
      .map(([c, v]) => `${c} (r = ${formatNumber(v)})`);
  }, [profile.data, form.target, form.features, supervised]);

  const create = useMutation({
    mutationFn: () => api.training.create({ name: form.name, dataset_id: form.dataset_id, ...buildConfig(form, hp, problem) } as ExperimentCreate),
    meta: { errorPrefix: "Experiment not started" },
    onSuccess: (r) => router.push(`/experiments/${r.experiment.id}`),
  });

  const num = (v: string, fallback: number) => (v === "" || !Number.isFinite(Number(v)) ? fallback : Number(v));
  const ready =
    !!form.dataset_id && !!form.name.trim() && (clustering ? form.features.length > 0 || columns.length > 0 : !!form.target) && (!forecasting || !!form.forecast.time_column) && (forecasting || clustering || form.features.length > 0);

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumb={
          <>
            <Link href="/experiments" className="hover:underline">
              Experiments
            </Link>{" "}
            / New
          </>
        }
        title="New experiment"
        description="Train and compare models with AutoML: classification, regression, clustering and forecasting. Every run is tracked with its parameters, metrics and dataset version."
        actions={
          <Button onClick={() => setSaveOpen(true)} disabled={!problem}>
            Save as template
          </Button>
        }
      />
      <Templates
        datasetId={form.dataset_id}
        experimentName={form.name}
        target={form.target}
        onLoad={(t) => {
          const r = formFromConfig(form, t.config, columns.map((c) => c.name));
          setForm(r.form);
          setHp(r.hp);
          toast.success(`Loaded template “${t.name}”`);
        }}
        onApplied={(id) => router.push(`/experiments/${id}`)}
      />
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Card title="Data & task">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <TextField label="Experiment name" required value={form.name} onChange={(e) => set("name", e.target.value)} />
            <SelectField
              label="Dataset"
              required
              value={form.dataset_id}
              onChange={(e) => setForm({ ...form, dataset_id: e.target.value, target: "", features: [], name: "" })}
              options={(datasets.data ?? []).map((d) => ({ value: d.id, label: `${d.name} (v${d.latest_version})` }))}
              placeholder="Choose a dataset…"
            />
            <SelectField
              label="Problem type"
              value={form.problem_type}
              onChange={(e) => {
                const v = e.target.value as ProblemType | "";
                setForm((f) => ({ ...f, problem_type: v, algorithms: [], target: v === "clustering" ? "" : f.target }));
              }}
              options={[
                { value: "binary", label: "Binary classification" },
                { value: "multiclass", label: "Multi-class classification" },
                { value: "regression", label: "Regression" },
                { value: "clustering", label: "Clustering (no target)" },
                { value: "forecasting", label: "Time-series forecasting" },
              ]}
              placeholder="Auto-detect from the target"
            />
            {!wantsClustering && (
              <SelectField
                label="Target column"
                required
                value={form.target}
                onChange={(e) => set("target", e.target.value)}
                options={columns.filter((c) => !forecasting || c.type === "integer" || c.type === "number").map((c) => ({ value: c.name, label: `${c.name} (${c.type})` }))}
                placeholder={forecasting ? "Numeric series to forecast…" : "Choose the column to predict…"}
                disabled={!dataset}
              />
            )}
          </div>
          {form.target && !form.problem_type && (
            <div className="mt-3 text-sm" aria-live="polite">
              {detect.isLoading ? (
                "Detecting problem type…"
              ) : detect.data ? (
                <>
                  Detected: <Badge tone="info">{detect.data.problem_type}</Badge> <span className="text-[var(--text-2)]">{detect.data.reason}</span>
                  {detect.data.classes?.length ? (
                    <span className="block text-xs text-[var(--text-2)]">
                      Classes:{" "}
                      {detect.data.classes
                        .slice(0, 10)
                        .map((c) => (c && typeof c === "object" && "value" in c ? `${String(c.value)} (${String(c.count)})` : String(c)))
                        .join(", ")}
                    </span>
                  ) : null}
                  {detect.data.imbalance_hint && <span className="block text-xs text-amber-800 dark:text-amber-300">⚠ {detect.data.imbalance_hint}</span>}
                </>
              ) : null}
            </div>
          )}
          {forecastAlt && form.problem_type !== "forecasting" && (
            <p className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-brand-50 p-2 text-sm dark:bg-brand-900/40">
              <span>
                This looks like a time series{forecastAlt.time_column ? ` indexed by ${forecastAlt.time_column}` : ""}
                {forecastAlt.frequency ? ` (${forecastAlt.frequency})` : ""}. {forecastAlt.reason}
              </span>
              <Button
                size="sm"
                onClick={() =>
                  setForm((f) => ({ ...f, problem_type: "forecasting", algorithms: [], forecast: { ...f.forecast, time_column: forecastAlt.time_column ?? f.forecast.time_column, frequency: forecastAlt.frequency ?? f.forecast.frequency } }))
                }
              >
                Forecast instead
              </Button>
            </p>
          )}
          {(form.target || clustering) && !forecasting && (
            <div className="mt-4">
              <MultiSelect
                label={clustering ? "Features to cluster on" : "Features"}
                options={toOptions(columns.map((c) => c.name).filter((c) => c !== form.target))}
                value={form.features}
                onChange={(v) => set("features", v)}
              />
              {leakage.length > 0 && (
                <p role="alert" className="mt-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                  ⚠ Possible target leakage: {leakage.join(", ")} correlate almost perfectly with the target. Consider removing them.
                </p>
              )}
            </div>
          )}
        </Card>

        {forecasting && (
          <Card title="Forecast settings">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SelectField
                label="Time column"
                required
                value={form.forecast.time_column}
                onChange={(e) => set("forecast", { ...form.forecast, time_column: e.target.value })}
                options={(timeColumns.length ? timeColumns : columns).map((c) => ({ value: c.name, label: `${c.name} (${c.type})` }))}
                placeholder="Choose…"
              />
              <TextField
                label={
                  <span className="inline-flex items-center gap-1">
                    Frequency <InfoTip text="pandas offset alias: D (daily), W-SUN (weekly), MS (month start), h (hourly)… Leave empty to detect it." />
                  </span>
                }
                value={form.forecast.frequency ?? ""}
                onChange={(e) => set("forecast", { ...form.forecast, frequency: e.target.value })}
                placeholder="auto-detect"
                list="freq-aliases"
              />
              <datalist id="freq-aliases">
                {["h", "D", "B", "W-SUN", "W-MON", "MS", "ME", "QS", "YS"].map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
              <TextField label="Horizon (periods)" type="number" min={1} max={1000} value={form.forecast.horizon} onChange={(e) => set("forecast", { ...form.forecast, horizon: num(e.target.value, 12) })} />
              <TextField label="Season length" type="number" min={1} max={1000} value={form.forecast.season_length ?? ""} placeholder="auto" onChange={(e) => set("forecast", { ...form.forecast, season_length: e.target.value ? num(e.target.value, 1) : null })} />
              <TextField label="Backtest folds" type="number" min={1} max={20} value={form.forecast.backtest_folds} onChange={(e) => set("forecast", { ...form.forecast, backtest_folds: num(e.target.value, 3) })} hint="Rolling-origin backtest" />
              <TextField label="Interval level" type="number" min={0.5} max={0.99} step={0.01} value={form.forecast.interval_level} onChange={(e) => set("forecast", { ...form.forecast, interval_level: num(e.target.value, 0.9) })} />
              <SelectField
                label="Aggregate duplicates by"
                value={form.forecast.aggregation}
                onChange={(e) => set("forecast", { ...form.forecast, aggregation: e.target.value as ForecastConfig["aggregation"] })}
                options={toOptions(["mean", "sum", "last"])}
              />
            </div>
          </Card>
        )}

        {clustering && (
          <Card title="Clustering settings">
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField label="Minimum k" type="number" min={2} max={50} value={form.clustering.k_min} onChange={(e) => set("clustering", { ...form.clustering, k_min: num(e.target.value, 2) })} />
              <TextField
                label="Maximum k"
                type="number"
                min={2}
                max={50}
                value={form.clustering.k_max}
                onChange={(e) => set("clustering", { ...form.clustering, k_max: num(e.target.value, 8) })}
                error={form.clustering.k_max < form.clustering.k_min ? "Must be ≥ minimum k" : null}
              />
              <TextField label="Max rows to fit" type="number" min={100} max={100000} value={form.clustering.max_fit_rows} onChange={(e) => set("clustering", { ...form.clustering, max_fit_rows: num(e.target.value, 5000) })} />
            </div>
            <p className="mt-2 text-xs text-[var(--text-2)]">AutoML searches the number of clusters in this range and ranks runs by silhouette score. DBSCAN finds k itself and may label noise (cluster −1).</p>
          </Card>
        )}

        {supervised && (
          <Card title="Validation">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SelectField
                label="Split method"
                value={form.split.method}
                onChange={(e) => set("split", { ...form.split, method: e.target.value as Form["split"]["method"] })}
                options={[
                  { value: "random", label: "Random" },
                  { value: "stratified", label: "Stratified" },
                  { value: "time", label: "Time-based" },
                ]}
              />
              <TextField label="Test size" type="number" min={0.05} max={0.5} step={0.05} value={form.split.test_size} onChange={(e) => set("split", { ...form.split, test_size: num(e.target.value, 0.2) })} />
              <TextField label="Validation size" type="number" min={0} max={0.5} step={0.05} value={form.split.validation_size} onChange={(e) => set("split", { ...form.split, validation_size: num(e.target.value, 0) })} />
              {form.split.method === "time" && (
                <SelectField label="Time column" value={form.split.time_column ?? ""} onChange={(e) => set("split", { ...form.split, time_column: e.target.value })} options={timeColumns.map((c) => ({ value: c.name, label: c.name }))} placeholder="Choose…" />
              )}
              <SelectField
                label="Cross-validation"
                value={form.cv.method}
                onChange={(e) => set("cv", { ...form.cv, method: e.target.value as Form["cv"]["method"] })}
                options={[
                  { value: "kfold", label: "K-fold" },
                  { value: "stratified_kfold", label: "Stratified k-fold" },
                  { value: "timeseries", label: "Time-series split" },
                ]}
              />
              <TextField label="Folds" type="number" min={2} max={20} value={form.cv.folds} onChange={(e) => set("cv", { ...form.cv, folds: num(e.target.value, 5) })} />
            </div>
          </Card>
        )}

        <Card title={`Algorithms${problem ? ` for ${problem}` : ""}`}>
          <p className="mb-3 text-sm text-[var(--text-2)]">Leave all unchecked to let AutoML try every suitable algorithm. Hover or focus ⓘ for documentation of each hyperparameter.</p>
          <ul className="space-y-2">
            {available.map((a) => {
              const checked = form.algorithms.includes(a.id);
              return (
                <li key={a.id} className="rounded-md border border-[var(--border)] p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Checkbox label={<span className="font-medium">{a.name}</span>} checked={checked} onChange={() => set("algorithms", checked ? form.algorithms.filter((x) => x !== a.id) : [...form.algorithms, a.id])} />
                    <Badge>{a.family}</Badge>
                    {a.id === "catboost" && <Badge tone="info">native categorical handling</Badge>}
                    {a.hyperparameters.length > 0 && (
                      <Button size="sm" variant="ghost" className="ml-auto" aria-expanded={expanded === a.id} onClick={() => setExpanded(expanded === a.id ? null : a.id)}>
                        Hyperparameters ({Object.keys(hp[a.id] ?? {}).length} set)
                      </Button>
                    )}
                  </div>
                  {expanded === a.id && (
                    <div className="mt-3">
                      <HyperparameterInputs algo={a} values={hp[a.id] ?? {}} onChange={(v) => setHp((h) => ({ ...h, [a.id]: v }))} />
                      <p className="mt-2 text-xs text-[var(--text-2)]">Fixed values override AutoML search for that parameter. Empty = default / searched.</p>
                    </div>
                  )}
                </li>
              );
            })}
            {!available.length && <li className="text-sm text-[var(--text-2)]">{algorithms.isLoading ? "Loading algorithms…" : "No algorithms available."}</li>}
          </ul>
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="AutoML">
            <div className="grid gap-3 sm:grid-cols-2">
              <Checkbox label="Enable hyperparameter search" checked={form.automl.enabled} onChange={(e) => set("automl", { ...form.automl, enabled: e.target.checked })} className="sm:col-span-2" />
              <SelectField
                label="Strategy"
                disabled={!form.automl.enabled}
                value={form.automl.strategy}
                onChange={(e) => set("automl", { ...form.automl, strategy: e.target.value as Form["automl"]["strategy"] })}
                options={[
                  { value: "tpe", label: "Bayesian (TPE)" },
                  { value: "random", label: "Random search" },
                  { value: "grid", label: "Grid search" },
                ]}
              />
              <TextField label="Trials" type="number" min={1} max={500} disabled={!form.automl.enabled} value={form.automl.n_trials} onChange={(e) => set("automl", { ...form.automl, n_trials: num(e.target.value, 20) })} />
              <TextField label="Search timeout (s)" type="number" min={10} disabled={!form.automl.enabled} value={form.automl.timeout_seconds} onChange={(e) => set("automl", { ...form.automl, timeout_seconds: num(e.target.value, 300) })} />
              <TextField label="Max training time (s)" type="number" min={10} value={form.max_training_seconds} onChange={(e) => set("max_training_seconds", num(e.target.value, 600))} />
              <TextField label="Random seed" type="number" min={0} value={form.seed} onChange={(e) => set("seed", num(e.target.value, 42))} />
            </div>
            {supervised && (
              <fieldset className="mt-4 grid gap-3 rounded-md border border-[var(--border)] p-3 sm:grid-cols-2">
                <legend className="px-1 text-xs font-semibold">Ensembles (stacking / voting)</legend>
                <SelectField
                  label="Build ensembles"
                  value={form.ensemble.mode}
                  onChange={(e) => set("ensemble", { ...form.ensemble, mode: e.target.value as Form["ensemble"]["mode"] })}
                  options={[
                    { value: "auto", label: "Auto (when AutoML picks the algorithms)" },
                    { value: "on", label: "Always" },
                    { value: "off", label: "Never" },
                  ]}
                />
                <TextField label="Top-k base models" type="number" min={2} max={5} disabled={form.ensemble.mode === "off"} value={form.ensemble.top_k} onChange={(e) => set("ensemble", { ...form.ensemble, top_k: num(e.target.value, 3) })} />
                <div className="flex gap-4 sm:col-span-2">
                  {(["stacking", "voting"] as const).map((m) => (
                    <Checkbox
                      key={m}
                      label={m === "stacking" ? "Stacking" : "Soft voting"}
                      disabled={form.ensemble.mode === "off"}
                      checked={form.ensemble.methods.includes(m)}
                      onChange={(e) => set("ensemble", { ...form.ensemble, methods: e.target.checked ? [...form.ensemble.methods, m] : form.ensemble.methods.filter((x) => x !== m) })}
                    />
                  ))}
                </div>
              </fieldset>
            )}
          </Card>
          <Card title="Preprocessing & features">
            <div className="grid gap-3 sm:grid-cols-3">
              <SelectField
                label="Categorical encoding"
                value={form.preprocessing.encoding}
                onChange={(e) => set("preprocessing", { ...form.preprocessing, encoding: e.target.value as Preprocessing["encoding"] })}
                options={toOptions(["onehot", "ordinal", "target"])}
              />
              <SelectField
                label="Scaling"
                value={form.preprocessing.scaling}
                onChange={(e) => set("preprocessing", { ...form.preprocessing, scaling: e.target.value as Preprocessing["scaling"] })}
                options={toOptions(["standard", "minmax", "robust", "log", "none"])}
              />
              <SelectField
                label="Impute missing"
                value={form.preprocessing.impute}
                onChange={(e) => set("preprocessing", { ...form.preprocessing, impute: e.target.value as Preprocessing["impute"] })}
                options={toOptions(["median", "mean", "most_frequent"])}
              />
              {supervised && <Checkbox label="Feature selection" checked={form.fsEnabled} onChange={(e) => set("fsEnabled", e.target.checked)} className="sm:col-span-3" />}
              {supervised && form.fsEnabled && (
                <>
                  <SelectField
                    label="Method"
                    value={form.preprocessing.feature_selection?.method ?? "mutual_info"}
                    onChange={(e) => set("preprocessing", { ...form.preprocessing, feature_selection: { k: form.preprocessing.feature_selection?.k ?? 20, method: e.target.value as FsMethod } })}
                    options={[
                      { value: "mutual_info", label: "Mutual information" },
                      { value: "correlation", label: "Correlation" },
                      { value: "rfe", label: "Recursive elimination" },
                      { value: "l1", label: "L1 regularization" },
                    ]}
                  />
                  <TextField
                    label="Keep top k"
                    type="number"
                    min={1}
                    value={form.preprocessing.feature_selection?.k ?? 20}
                    onChange={(e) => set("preprocessing", { ...form.preprocessing, feature_selection: { method: form.preprocessing.feature_selection?.method ?? "mutual_info", k: num(e.target.value, 20) } })}
                  />
                </>
              )}
              {!forecasting && (
                <>
                  <Checkbox
                    className="sm:col-span-3"
                    label="Automatic feature engineering"
                    hint="Adds a×b interactions and a² terms of the top-k numeric features (disables ONNX export)"
                    checked={form.autoFeatures.enabled}
                    onChange={(e) => set("autoFeatures", { ...form.autoFeatures, enabled: e.target.checked })}
                  />
                  {form.autoFeatures.enabled && (
                    <>
                      <Checkbox label="Interactions" checked={form.autoFeatures.interactions} onChange={(e) => set("autoFeatures", { ...form.autoFeatures, interactions: e.target.checked })} />
                      <Checkbox label="Squares" checked={form.autoFeatures.polynomial} onChange={(e) => set("autoFeatures", { ...form.autoFeatures, polynomial: e.target.checked })} />
                      <TextField label="Top-k features" type="number" min={2} max={20} value={form.autoFeatures.top_k} onChange={(e) => set("autoFeatures", { ...form.autoFeatures, top_k: num(e.target.value, 5) })} />
                    </>
                  )}
                  <Checkbox
                    className="sm:col-span-3"
                    label="PCA"
                    hint="Project features onto principal components; explanations are then per component"
                    checked={form.pca.enabled}
                    onChange={(e) => set("pca", { ...form.pca, enabled: e.target.checked })}
                  />
                  {form.pca.enabled && (
                    <TextField
                      className="sm:col-span-2"
                      label="Components"
                      type="number"
                      min={0.01}
                      step="any"
                      value={form.pca.n_components}
                      onChange={(e) => set("pca", { ...form.pca, n_components: num(e.target.value, 0.95) })}
                      hint="< 1: share of variance kept (0.95); ≥ 1: number of components"
                    />
                  )}
                </>
              )}
              {isClassification && (
                <SelectField
                  label="Class imbalance"
                  className="sm:col-span-3"
                  value={form.class_imbalance}
                  onChange={(e) => set("class_imbalance", e.target.value as Form["class_imbalance"])}
                  options={[
                    { value: "none", label: "None" },
                    { value: "class_weight", label: "Class weights" },
                    { value: "smote", label: "SMOTE oversampling" },
                    { value: "oversample", label: "Random oversampling" },
                    { value: "undersample", label: "Random undersampling" },
                  ]}
                />
              )}
            </div>
          </Card>
        </div>

        <div className="flex justify-end gap-2">
          <Link href="/experiments" className="rounded-md border border-[var(--border)] px-3.5 py-2 text-sm hover:bg-[var(--surface-2)]">
            Cancel
          </Link>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!ready}>
            Start training
          </Button>
        </div>
      </form>
      <SaveTemplateDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        config={() => buildConfig(form, hp, problem, false)}
        onSaved={() => qc.invalidateQueries({ queryKey: ["training-templates"] })}
      />
    </div>
  );
}

function SaveTemplateDialog({ open, onClose, config, onSaved }: { open: boolean; onClose: () => void; config: () => TrainingConfig; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const save = useMutation({
    mutationFn: () => api.training.createTemplate({ name: name.trim(), description: description.trim() || undefined, config: config() }),
    meta: { errorPrefix: "Template not saved" },
    onSuccess: (t) => {
      toast.success(`Template “${t.name}” saved`);
      setName("");
      setDescription("");
      onSaved();
      onClose();
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save training template"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-[var(--text-2)]">Saves the current configuration (problem type, algorithms, AutoML, preprocessing, ensembles…). The target and features are left out so the template works on other datasets.</p>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <TextArea label="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
    </Modal>
  );
}

function Templates({ datasetId, experimentName, target, onLoad, onApplied }: { datasetId: string; experimentName: string; target: string; onLoad: (t: TrainingTemplate) => void; onApplied: (experimentId: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [toDelete, setToDelete] = useState<TrainingTemplate | null>(null);
  const q = useQuery({ queryKey: ["training-templates"], queryFn: api.training.templates, enabled: open });
  const apply = useMutation({
    mutationFn: (t: TrainingTemplate) =>
      api.training.applyTemplate(t.id, { name: experimentName.trim() || `${t.name} run`, dataset_id: datasetId, overrides: target && t.config.problem_type !== "clustering" ? { target } : {} }),
    meta: { errorPrefix: "Template not applied" },
    onSuccess: (r) => onApplied(r.experiment.id),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.training.deleteTemplate(id),
    onSuccess: () => {
      toast.success("Template deleted");
      setToDelete(null);
      qc.invalidateQueries({ queryKey: ["training-templates"] });
    },
  });
  return (
    <Card
      title="Training templates"
      actions={
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Show"}
        </Button>
      }
      bodyClassName={open ? "p-4" : "hidden"}
    >
      {open &&
        (q.isLoading ? (
          <p className="text-sm text-[var(--text-2)]">Loading templates…</p>
        ) : !q.data?.length ? (
          <p className="text-sm text-[var(--text-2)]">No templates yet. Configure an experiment and use “Save as template”.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {q.data.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{t.name}</span> {t.config.problem_type && <Badge tone="info">{t.config.problem_type}</Badge>}
                  <span className="block text-xs text-[var(--text-2)]">
                    {t.description ? `${t.description} · ` : ""}
                    {t.created_by} · {formatDate(t.created_at)}
                  </span>
                </span>
                <Button size="sm" onClick={() => onLoad(t)}>
                  Load into form
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => apply.mutate(t)}
                  loading={apply.isPending && apply.variables?.id === t.id}
                  disabled={!datasetId || (t.config.problem_type !== "clustering" && !t.config.target && !target)}
                  title={!datasetId ? "Choose a dataset first" : undefined}
                >
                  Apply &amp; train
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setToDelete(t)} aria-label={`Delete template ${t.name}`}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        ))}
      <ConfirmDialog open={!!toDelete} onClose={() => setToDelete(null)} onConfirm={() => toDelete && remove.mutate(toDelete.id)} title="Delete template?" danger confirmLabel="Delete" loading={remove.isPending}>
        <p>Experiments created from “{toDelete?.name}” are not affected.</p>
      </ConfirmDialog>
    </Card>
  );
}
