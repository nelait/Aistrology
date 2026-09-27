/**
 * Signature editor state for custom ONNX uploads (TRN-010) and its serialization to the API's `signature`
 * JSON. Validation mirrors `UploadSignature` in backend/app/training/custom_models.py.
 */
import type { JsonValue, SupervisedProblemType, UploadFeature, UploadFeatureType, UploadSignature } from "./types";

export const FEATURE_TYPES: UploadFeatureType[] = ["number", "integer", "string", "boolean"];

export interface FeatureRow {
  name: string;
  type: UploadFeatureType;
  /** comma-separated (string features) */
  categories: string;
  min: string;
  max: string;
}

export interface SignatureDraft {
  problem_type: SupervisedProblemType;
  target: string;
  /** comma-separated class values (classification) */
  classes: string;
  input: UploadSignature["input"];
  features: FeatureRow[];
  outputs: { label: string; probabilities: string; value: string };
}

export const EMPTY_FEATURE: FeatureRow = { name: "", type: "number", categories: "", min: "", max: "" };

export const DEFAULT_DRAFT: SignatureDraft = {
  problem_type: "binary",
  target: "",
  classes: "0, 1",
  input: "auto",
  features: [{ ...EMPTY_FEATURE }],
  outputs: { label: "", probabilities: "", value: "" },
};

export function splitList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Class values: numbers stay numbers (`0, 1` → [0, 1]), everything else is a string. */
export function parseClasses(text: string): JsonValue[] {
  return splitList(text).map((c) => (/^-?\d+(\.\d+)?$/.test(c) ? Number(c) : c));
}

export interface SerializeResult {
  signature: UploadSignature | null;
  /** form-level errors */
  errors: string[];
  /** per-feature row errors (same order as draft.features) */
  featureErrors: (string | null)[];
}

function optNumber(text: string): number | undefined | "invalid" {
  const t = text.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : "invalid";
}

export function serializeSignature(d: SignatureDraft): SerializeResult {
  const errors: string[] = [];
  const names = d.features.map((f) => f.name.trim());
  const featureErrors = d.features.map((f, i): string | null => {
    const name = names[i];
    if (!name) return "Name is required";
    if (name.length > 200) return "At most 200 characters";
    if (names.indexOf(name) !== i) return "Duplicate feature name";
    const min = optNumber(f.min);
    const max = optNumber(f.max);
    if (min === "invalid" || max === "invalid") return "Min / max must be numbers";
    if (min !== undefined && max !== undefined && min > max) return "Min is greater than max";
    return null;
  });
  if (!d.features.length) errors.push("Add at least one feature");

  const classes = parseClasses(d.classes);
  if (d.problem_type === "regression") {
    // classes are ignored for regression
  } else if (classes.length < 2) errors.push("Classification models need at least two classes");
  else if (d.problem_type === "binary" && classes.length !== 2) errors.push("Binary models need exactly two classes");
  else if (new Set(classes.map(String)).size !== classes.length) errors.push("Class values must be unique");

  if (errors.length || featureErrors.some(Boolean)) return { signature: null, errors, featureErrors };

  const features: UploadFeature[] = d.features.map((f, i) => {
    const out: UploadFeature = { name: names[i], type: f.type };
    if (f.type === "number" || f.type === "integer") {
      const min = optNumber(f.min);
      const max = optNumber(f.max);
      if (typeof min === "number") out.min = min;
      if (typeof max === "number") out.max = max;
    } else if (f.type === "string") {
      const cats = splitList(f.categories);
      if (cats.length) out.categories = cats;
    }
    return out;
  });
  const outputs = Object.fromEntries(Object.entries(d.outputs).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
  const signature: UploadSignature = {
    problem_type: d.problem_type,
    ...(d.target.trim() ? { target: d.target.trim() } : {}),
    ...(d.problem_type !== "regression" ? { classes } : {}),
    features,
    input: d.input,
    ...(Object.keys(outputs).length ? { outputs } : {}),
  };
  return { signature, errors: [], featureErrors };
}

/** Load a signature JSON (e.g. pasted or from a previous upload) into the editor. */
export function draftFromSignature(sig: Partial<UploadSignature>): SignatureDraft {
  const features = (sig.features ?? []).map(
    (f): FeatureRow => ({
      name: f.name ?? "",
      type: FEATURE_TYPES.includes(f.type) ? f.type : "number",
      categories: (f.categories ?? []).join(", "),
      min: f.min !== undefined && f.min !== null ? String(f.min) : "",
      max: f.max !== undefined && f.max !== null ? String(f.max) : "",
    }),
  );
  return {
    problem_type: sig.problem_type ?? "binary",
    target: sig.target ?? "",
    classes: (sig.classes ?? []).map(String).join(", "),
    input: sig.input ?? "auto",
    features: features.length ? features : [{ ...EMPTY_FEATURE }],
    outputs: { label: sig.outputs?.label ?? "", probabilities: sig.outputs?.probabilities ?? "", value: sig.outputs?.value ?? "" },
  };
}

export function parseSignatureJson(text: string): { draft: SignatureDraft | null; error: string | null } {
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { draft: null, error: "The signature must be a JSON object" };
    const o = v as Partial<UploadSignature>;
    if (!Array.isArray(o.features)) return { draft: null, error: "“features” must be a list of {name, type}" };
    return { draft: draftFromSignature(o), error: null };
  } catch (e) {
    return { draft: null, error: e instanceof Error ? e.message : "Invalid JSON" };
  }
}

/** Feature rows from a CSV header line (all numeric; adjust the types afterwards). */
export function featuresFromHeader(header: string): FeatureRow[] {
  return splitList(header.replace(/["']/g, "")).map((name) => ({ ...EMPTY_FEATURE, name }));
}
