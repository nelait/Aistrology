"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type Algorithm, type ExperimentCreate, type Hyperparameter, type JsonValue, type ProblemType } from "@/lib/api";
import { schemaColumns } from "@/lib/data";
import { formatNumber } from "@/lib/format";
import { RequirePermission } from "@/components/RequirePermission";
import { Badge, Button, Card, Checkbox, InfoTip, MultiSelect, PageHeader, SelectField, TextField, toOptions } from "@/components/ui";

type Form = Omit<ExperimentCreate, "hyperparameters" | "algorithms" | "problem_type" | "features"> & {
  problem_type: ProblemType | "";
  features: string[];
  algorithms: string[];
  fsEnabled: boolean;
};

type FsMethod = NonNullable<ExperimentCreate["preprocessing"]["feature_selection"]>["method"];

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
  class_imbalance: "none",
  max_training_seconds: 600,
  seed: 42,
};

export default function NewExperimentPage() {
  return (
    <RequirePermission perm="models.train">
      <NewExperiment />
    </RequirePermission>
  );
}

function hpDescription(h: Hyperparameter): string {
  const parts = [h.help];
  parts.push(`Default: ${JSON.stringify(h.default)}.`);
  if (h.min !== null && h.min !== undefined) parts.push(`Range: ${h.min} – ${h.max ?? "∞"}${h.log ? " (log scale)" : ""}.`);
  if (h.choices?.length) parts.push(`Choices: ${h.choices.map((c) => JSON.stringify(c)).join(", ")}.`);
  return parts.join(" ");
}

function HyperparameterInputs({ algo, values, onChange }: { algo: Algorithm; values: Record<string, JsonValue>; onChange: (v: Record<string, JsonValue>) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {algo.hyperparameters.map((h) => {
        const v = values[h.name];
        const label = (
          <span className="inline-flex items-center gap-1">
            {h.name} <InfoTip text={hpDescription(h)} label={`About ${h.name}`} />
          </span>
        );
        if (h.choices?.length)
          return (
            <SelectField
              key={h.name}
              label={label}
              value={v === undefined ? "" : JSON.stringify(v)}
              onChange={(e) => {
                const next = { ...values };
                if (e.target.value === "") delete next[h.name];
                else next[h.name] = JSON.parse(e.target.value) as JsonValue;
                onChange(next);
              }}
              options={h.choices.map((c) => ({ value: JSON.stringify(c), label: String(c) }))}
              placeholder={`default (${String(h.default)})`}
            />
          );
        if (h.type === "bool")
          return (
            <SelectField
              key={h.name}
              label={label}
              value={v === undefined ? "" : String(v)}
              onChange={(e) => {
                const next = { ...values };
                if (e.target.value === "") delete next[h.name];
                else next[h.name] = e.target.value === "true";
                onChange(next);
              }}
              options={[
                { value: "true", label: "true" },
                { value: "false", label: "false" },
              ]}
              placeholder={`default (${String(h.default)})`}
            />
          );
        return (
          <TextField
            key={h.name}
            label={label}
            type={h.type === "int" || h.type === "float" ? "number" : "text"}
            step={h.type === "int" ? 1 : "any"}
            min={h.min ?? undefined}
            max={h.max ?? undefined}
            placeholder={`default (${String(h.default)})`}
            value={v === undefined || v === null ? "" : String(v)}
            onChange={(e) => {
              const next = { ...values };
              if (e.target.value === "") delete next[h.name];
              else next[h.name] = h.type === "int" ? parseInt(e.target.value, 10) : h.type === "float" ? Number(e.target.value) : e.target.value;
              onChange(next);
            }}
          />
        );
      })}
    </div>
  );
}

function NewExperiment() {
  const router = useRouter();
  const params = useSearchParams();
  const [form, setForm] = useState<Form>({ ...DEFAULT, dataset_id: params.get("dataset") ?? "" });
  const [hp, setHp] = useState<Record<string, Record<string, JsonValue>>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api.datasets.list() });
  const algorithms = useQuery({ queryKey: ["algorithms"], queryFn: api.training.algorithms, staleTime: Infinity });
  const dataset = datasets.data?.find((d) => d.id === form.dataset_id);
  const columns = useMemo(() => schemaColumns(dataset?.schema), [dataset]);
  const profile = useQuery({ queryKey: ["profile", form.dataset_id, dataset?.version], queryFn: () => api.datasets.profile(form.dataset_id), enabled: !!dataset, meta: { silent: true } });

  const detect = useQuery({
    queryKey: ["detect", form.dataset_id, form.target],
    queryFn: () => api.training.detect(form.dataset_id, form.target),
    enabled: !!form.dataset_id && !!form.target,
  });

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (dataset && !form.name) set("name", `${dataset.name} model`);
  }, [dataset, form.name]);

  useEffect(() => {
    if (form.target) setForm((f) => ({ ...f, features: columns.map((c) => c.name).filter((c) => c !== f.target) }));
  }, [form.target, columns]);

  const problem: ProblemType | undefined = (form.problem_type || detect.data?.problem_type) as ProblemType | undefined;
  const isClassification = problem === "binary" || problem === "multiclass";
  const available = (algorithms.data ?? []).filter((a) => !problem || a.problem_types.includes(problem));

  // MDL-006: features that correlate almost perfectly with the target
  const leakage = useMemo(() => {
    const row = profile.data?.correlations?.[form.target];
    if (!row) return [];
    return Object.entries(row)
      .filter(([c, v]) => c !== form.target && form.features.includes(c) && v !== null && Math.abs(v) > 0.95)
      .map(([c, v]) => `${c} (r = ${formatNumber(v)})`);
  }, [profile.data, form.target, form.features]);

  const create = useMutation({
    mutationFn: () => {
      const body: ExperimentCreate = {
        name: form.name,
        dataset_id: form.dataset_id,
        target: form.target,
        features: form.features,
        problem_type: problem,
        split: { ...form.split, time_column: form.split.method === "time" ? form.split.time_column : undefined },
        cv: form.cv,
        algorithms: form.algorithms.length ? form.algorithms : undefined,
        automl: form.automl,
        hyperparameters: Object.keys(hp).length ? Object.fromEntries(Object.entries(hp).filter(([k, v]) => form.algorithms.includes(k) && Object.keys(v).length)) : undefined,
        preprocessing: {
          encoding: form.preprocessing.encoding,
          scaling: form.preprocessing.scaling,
          impute: form.preprocessing.impute,
          feature_selection: form.fsEnabled ? form.preprocessing.feature_selection : undefined,
        },
        class_imbalance: isClassification ? form.class_imbalance : "none",
        max_training_seconds: form.max_training_seconds,
        seed: form.seed,
      };
      return api.training.create(body);
    },
    meta: { errorPrefix: "Experiment not started" },
    onSuccess: (r) => router.push(`/experiments/${r.experiment.id}`),
  });

  const num = (v: string, fallback: number) => (v === "" || !Number.isFinite(Number(v)) ? fallback : Number(v));

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
        description="Train and compare models with AutoML. Every run is tracked with its parameters, metrics and dataset version."
      />
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Card title="Data & target">
          <div className="grid gap-3 md:grid-cols-3">
            <TextField label="Experiment name" required value={form.name} onChange={(e) => set("name", e.target.value)} />
            <SelectField
              label="Dataset"
              required
              value={form.dataset_id}
              onChange={(e) => setForm({ ...form, dataset_id: e.target.value, target: "", features: [], name: "" })}
              options={(datasets.data ?? []).map((d) => ({ value: d.id, label: `${d.name} (v${d.latest_version})` }))}
              placeholder="Choose a dataset…"
            />
            <SelectField label="Target column" required value={form.target} onChange={(e) => set("target", e.target.value)} options={columns.map((c) => ({ value: c.name, label: `${c.name} (${c.type})` }))} placeholder="Choose the column to predict…" disabled={!dataset} />
          </div>
          {form.target && (
            <div className="mt-3 flex flex-wrap items-end gap-3" aria-live="polite">
              <div className="text-sm">
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
              <SelectField
                label="Problem type"
                value={form.problem_type}
                onChange={(e) => set("problem_type", e.target.value as ProblemType | "")}
                options={[
                  { value: "binary", label: "Binary classification" },
                  { value: "multiclass", label: "Multi-class classification" },
                  { value: "regression", label: "Regression" },
                ]}
                placeholder="Use detected"
              />
            </div>
          )}
          {form.target && (
            <div className="mt-4">
              <MultiSelect label="Features" options={toOptions(columns.map((c) => c.name).filter((c) => c !== form.target))} value={form.features} onChange={(v) => set("features", v)} />
              {leakage.length > 0 && (
                <p role="alert" className="mt-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                  ⚠ Possible target leakage: {leakage.join(", ")} correlate almost perfectly with the target. Consider removing them.
                </p>
              )}
            </div>
          )}
        </Card>

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
              <SelectField
                label="Time column"
                value={form.split.time_column ?? ""}
                onChange={(e) => set("split", { ...form.split, time_column: e.target.value })}
                options={columns.filter((c) => c.type === "date" || c.type === "datetime").map((c) => ({ value: c.name, label: c.name }))}
                placeholder="Choose…"
              />
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
          </Card>
          <Card title="Preprocessing">
            <div className="grid gap-3 sm:grid-cols-3">
              <SelectField
                label="Categorical encoding"
                value={form.preprocessing.encoding}
                onChange={(e) => set("preprocessing", { ...form.preprocessing, encoding: e.target.value as Form["preprocessing"]["encoding"] })}
                options={toOptions(["onehot", "ordinal", "target"])}
              />
              <SelectField
                label="Scaling"
                value={form.preprocessing.scaling}
                onChange={(e) => set("preprocessing", { ...form.preprocessing, scaling: e.target.value as Form["preprocessing"]["scaling"] })}
                options={toOptions(["standard", "minmax", "robust", "log", "none"])}
              />
              <SelectField
                label="Impute missing"
                value={form.preprocessing.impute}
                onChange={(e) => set("preprocessing", { ...form.preprocessing, impute: e.target.value as Form["preprocessing"]["impute"] })}
                options={toOptions(["median", "mean", "most_frequent"])}
              />
              <Checkbox label="Feature selection" checked={form.fsEnabled} onChange={(e) => set("fsEnabled", e.target.checked)} className="sm:col-span-3" />
              {form.fsEnabled && (
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
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!form.dataset_id || !form.target || !form.name.trim() || !form.features.length}>
            Start training
          </Button>
        </div>
      </form>
    </div>
  );
}
