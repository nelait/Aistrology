"use client";
/** TRN-010: upload a custom ONNX model with a signature (features, types, problem type, classes). */
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import {
  DEFAULT_DRAFT,
  EMPTY_FEATURE,
  FEATURE_TYPES,
  featuresFromHeader,
  parseSignatureJson,
  serializeSignature,
  type FeatureRow,
  type SignatureDraft,
} from "@/lib/onnxSignature";
import { useToast } from "@/lib/toast";
import { FileDrop } from "../FileDrop";
import { Badge, Button, Modal, ProgressBar, SelectField, TextArea, TextField, cx } from "../ui";

const MAX_BYTES = 200 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function OnnxSignatureEditor({ draft, onChange, featureErrors }: { draft: SignatureDraft; onChange: (d: SignatureDraft) => void; featureErrors: (string | null)[] }) {
  const [header, setHeader] = useState("");
  const [json, setJson] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const setFeature = (i: number, p: Partial<FeatureRow>) => onChange({ ...draft, features: draft.features.map((f, j) => (j === i ? { ...f, ...p } : f)) });
  const classification = draft.problem_type !== "regression";

  return (
    <fieldset className="space-y-3 rounded-md border border-[var(--border)] p-3">
      <legend className="px-1 text-xs font-semibold">Signature</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField
          label="Problem type"
          value={draft.problem_type}
          onChange={(e) => onChange({ ...draft, problem_type: e.target.value as SignatureDraft["problem_type"] })}
          options={[
            { value: "binary", label: "Binary classification" },
            { value: "multiclass", label: "Multi-class classification" },
            { value: "regression", label: "Regression" },
          ]}
        />
        <TextField label="Target name (optional)" value={draft.target} onChange={(e) => onChange({ ...draft, target: e.target.value })} />
        <SelectField
          label="Input layout"
          value={draft.input}
          onChange={(e) => onChange({ ...draft, input: e.target.value as SignatureDraft["input"] })}
          options={[
            { value: "auto", label: "Auto-detect" },
            { value: "per_feature", label: "One [N,1] tensor per feature" },
            { value: "tensor", label: "One float [N,F] tensor" },
          ]}
          hint="Per-feature inputs are named after the features"
        />
        {classification && (
          <TextField
            className="sm:col-span-3"
            label="Classes (comma-separated, in model order)"
            value={draft.classes}
            onChange={(e) => onChange({ ...draft, classes: e.target.value })}
            hint={draft.problem_type === "binary" ? "Exactly two, e.g. 0, 1 or no, yes. Labels may be class values or indices." : "At least two, unique."}
          />
        )}
      </div>

      <div>
        <div className="mb-1 flex flex-wrap items-end gap-2">
          <h3 className="flex-1 text-xs font-semibold">Features ({draft.features.length})</h3>
          <Button size="sm" onClick={() => setJson(json === null ? JSON.stringify(serializeSignature(draft).signature ?? {}, null, 2) : null)} aria-expanded={json !== null}>
            {json === null ? "Edit as JSON" : "Close JSON"}
          </Button>
        </div>
        {json !== null ? (
          <div className="space-y-2">
            <TextArea label="Signature JSON" mono rows={12} value={json} onChange={(e) => setJson(e.target.value)} error={jsonError} spellCheck={false} />
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                const r = parseSignatureJson(json);
                if (r.error || !r.draft) setJsonError(r.error);
                else {
                  setJsonError(null);
                  onChange(r.draft);
                  setJson(null);
                }
              }}
            >
              Apply JSON
            </Button>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Model input features</caption>
                <thead className="text-xs text-[var(--text-2)]">
                  <tr>
                    <th scope="col" className="py-1 pr-2">Name</th>
                    <th scope="col" className="py-1 pr-2">Type</th>
                    <th scope="col" className="py-1 pr-2">Categories / range</th>
                    <th scope="col" className="py-1"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {draft.features.map((f, i) => (
                    <tr key={i} className="align-top">
                      <td className="py-1 pr-2">
                        <TextField label={`Feature ${i + 1} name`} srOnlyLabel value={f.name} onChange={(e) => setFeature(i, { name: e.target.value })} error={featureErrors[i]} placeholder="column name" />
                      </td>
                      <td className="py-1 pr-2">
                        <SelectField label={`Feature ${i + 1} type`} srOnlyLabel value={f.type} onChange={(e) => setFeature(i, { type: e.target.value as FeatureRow["type"] })} options={FEATURE_TYPES.map((t) => ({ value: t, label: t }))} />
                      </td>
                      <td className="py-1 pr-2">
                        {f.type === "string" ? (
                          <TextField label={`Feature ${i + 1} categories`} srOnlyLabel value={f.categories} onChange={(e) => setFeature(i, { categories: e.target.value })} placeholder="a, b, c (optional)" />
                        ) : f.type === "boolean" ? (
                          <span className="text-xs text-[var(--text-2)]">true / false</span>
                        ) : (
                          <div className="flex gap-1">
                            <TextField label={`Feature ${i + 1} minimum`} srOnlyLabel value={f.min} onChange={(e) => setFeature(i, { min: e.target.value })} placeholder="min" inputMode="decimal" />
                            <TextField label={`Feature ${i + 1} maximum`} srOnlyLabel value={f.max} onChange={(e) => setFeature(i, { max: e.target.value })} placeholder="max" inputMode="decimal" />
                          </div>
                        )}
                      </td>
                      <td className="py-1">
                        <Button size="sm" variant="ghost" onClick={() => onChange({ ...draft, features: draft.features.filter((_, j) => j !== i) })} aria-label={`Remove feature ${f.name || i + 1}`}>
                          ✕
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Button size="sm" onClick={() => onChange({ ...draft, features: [...draft.features, { ...EMPTY_FEATURE }] })}>
                + Feature
              </Button>
              <TextField label="…or paste a CSV header" className="min-w-48 flex-1" value={header} onChange={(e) => setHeader(e.target.value)} placeholder="age, income, plan" />
              <Button
                size="sm"
                disabled={!header.trim()}
                onClick={() => {
                  onChange({ ...draft, features: featuresFromHeader(header) });
                  setHeader("");
                }}
              >
                Use header
              </Button>
            </div>
          </>
        )}
      </div>
      <details>
        <summary className="cursor-pointer text-xs font-medium">Output names (optional)</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {classification ? (
            <>
              <TextField label="Label output" value={draft.outputs.label} onChange={(e) => onChange({ ...draft, outputs: { ...draft.outputs, label: e.target.value } })} placeholder="auto" />
              <TextField label="Probabilities output" value={draft.outputs.probabilities} onChange={(e) => onChange({ ...draft, outputs: { ...draft.outputs, probabilities: e.target.value } })} placeholder="auto (matrix or ZipMap)" />
            </>
          ) : (
            <TextField label="Value output" value={draft.outputs.value} onChange={(e) => onChange({ ...draft, outputs: { ...draft.outputs, value: e.target.value } })} placeholder="auto" />
          )}
        </div>
      </details>
    </fieldset>
  );
}

export function UploadModelDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [draft, setDraft] = useState<SignatureDraft>(DEFAULT_DRAFT);
  const [progress, setProgress] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api.datasets.list(), enabled: open, meta: { silent: true } });
  const ser = serializeSignature(draft);
  const fileError = file && file.size > MAX_BYTES ? "The file exceeds 200 MB" : file && /\.(pkl|pickle|joblib|zip)$/i.test(file.name) ? "Only ONNX files are accepted (pickle / joblib / zip are refused)" : null;
  const nameError = name && !NAME_RE.test(name) ? "Letters, digits, “_”, “.” and “-”; start with a letter or digit" : null;

  const upload = useMutation({
    mutationFn: () => {
      abort.current = new AbortController();
      return api.models.upload({ file: file!, signature: ser.signature!, name, description: description || undefined, dataset_id: datasetId || undefined }, (p) => setProgress(p.total ? p.loaded / p.total : null), abort.current.signal);
    },
    meta: { silent: true },
    onSettled: () => setProgress(null),
    onSuccess: (r) => {
      toast.success(`${r.name} v${r.version} registered`);
      qc.invalidateQueries({ queryKey: ["models"] });
      onClose();
      router.push(`/models/${r.model_id}`);
    },
  });
  const err = upload.error;
  const rejected = err instanceof ApiError && err.code === "model_rejected";
  const errText = err instanceof DOMException && err.name === "AbortError" ? "Upload cancelled" : err instanceof Error ? err.message : err ? String(err) : null;
  const ready = !!file && !fileError && !!name && !nameError && !!ser.signature;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Upload ONNX model"
      footer={
        <>
          <Button onClick={() => (upload.isPending ? abort.current?.abort() : onClose())}>{upload.isPending ? "Cancel upload" : "Cancel"}</Button>
          <Button variant="primary" onClick={() => upload.mutate()} loading={upload.isPending} disabled={!ready}>
            Validate &amp; register
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) upload.mutate();
        }}
      >
        <p className="text-sm text-[var(--text-2)]">
          The file is checked (ONNX only, embedded weights, standard operators), loaded in onnxruntime and dry-run on a synthetic row from the signature before it becomes a registry version you can deploy.
        </p>
        <div>
          <FileDrop multiple={false} accept=".onnx" label="Drop an .onnx file or browse" hint="Up to 200 MB" onFiles={(f) => setFile(f[0] ?? null)} disabled={upload.isPending} />
          {file && (
            <p className={cx("mt-1 text-sm", fileError && "text-red-700 dark:text-red-400")}>
              {file.name} · {formatBytes(file.size)} {fileError && `— ${fileError}`}
            </p>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Model name" required value={name} onChange={(e) => setName(e.target.value)} error={nameError} hint="An existing name adds a new version" />
          <SelectField
            label="Reference dataset (optional)"
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
            options={(datasets.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
            placeholder="Synthetic rows from the signature"
            hint="Used for drift monitoring and explanations"
          />
          <TextArea className="sm:col-span-2" label="Description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <OnnxSignatureEditor draft={draft} onChange={setDraft} featureErrors={ser.featureErrors} />
        {ser.errors.length > 0 && (
          <ul className="text-xs text-amber-800 dark:text-amber-300">
            {ser.errors.map((e) => (
              <li key={e}>⚠ {e}</li>
            ))}
          </ul>
        )}
        {progress !== null && <ProgressBar value={progress} label="Upload progress" />}
        {upload.isPending && progress === null && <p className="text-sm text-[var(--text-2)]">Validating the model…</p>}
        {errText && (
          <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
            <p className="font-medium">{rejected ? <Badge tone="critical">Model rejected</Badge> : "Upload failed"}</p>
            <p className="mt-1 whitespace-pre-wrap">{errText}</p>
          </div>
        )}
      </form>
    </Modal>
  );
}
