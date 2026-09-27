/** Form definitions and (de)serialization for every cleaning step `op` in the API contract (CLN-*, PIP-001). */
import type { PipelineStep, StepOp } from "./types";

export type FieldKind =
  | "columns" // multi-select of dataset columns → string[] (optional unless required)
  | "column" // single dataset column → string
  | "enum"
  | "number"
  | "boolean"
  | "text"
  | "list" // comma-separated text → string[]
  | "mapping" // rows of old → new → Record<string, string>
  | "sql"
  | "value"; // free value: number when numeric, else string

export interface StepField {
  name: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  options?: string[];
  /** Options that also allow "not set" (null) */
  nullable?: boolean;
  default?: unknown;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Only show when another field has one of these values */
  showIf?: { field: string; in: unknown[] };
}

export interface StepDef {
  op: StepOp;
  label: string;
  description: string;
  fields: StepField[];
}

export const STEP_DEFS: StepDef[] = [
  {
    op: "drop_missing",
    label: "Drop missing",
    description: "Drop rows with missing values, or columns whose null share exceeds a threshold.",
    fields: [
      { name: "axis", label: "Drop", kind: "enum", options: ["rows", "columns"], default: "rows" },
      { name: "columns", label: "Consider columns", kind: "columns", help: "Empty = all columns", showIf: { field: "axis", in: ["rows"] } },
      { name: "how", label: "When", kind: "enum", options: ["any", "all"], default: "any", help: "any: a single null drops the row; all: every value is null", showIf: { field: "axis", in: ["rows"] } },
      { name: "max_null_fraction", label: "Max null fraction", kind: "number", default: 0.5, min: 0, max: 1, step: 0.05, showIf: { field: "axis", in: ["columns"] } },
    ],
  },
  {
    op: "fill_missing",
    label: "Fill missing",
    description: "Impute missing values.",
    fields: [
      { name: "columns", label: "Columns", kind: "columns", help: "Empty = all applicable columns" },
      { name: "strategy", label: "Strategy", kind: "enum", required: true, options: ["mean", "median", "mode", "constant", "ffill", "bfill", "interpolate"], default: "median" },
      { name: "value", label: "Constant value", kind: "value", showIf: { field: "strategy", in: ["constant"] }, required: true },
    ],
  },
  {
    op: "handle_outliers",
    label: "Handle outliers",
    description: "Remove, cap (winsorize) or flag outliers by IQR or Z-score.",
    fields: [
      { name: "columns", label: "Columns", kind: "columns", help: "Empty = all numeric columns" },
      { name: "method", label: "Method", kind: "enum", options: ["iqr", "zscore"], default: "iqr" },
      { name: "threshold", label: "Threshold", kind: "number", default: 1.5, min: 0.1, step: 0.1, help: "IQR multiplier or |z|" },
      { name: "action", label: "Action", kind: "enum", options: ["remove", "cap", "flag"], default: "cap" },
    ],
  },
  {
    op: "deduplicate",
    label: "Deduplicate",
    description: "Remove exact duplicate rows, optionally on a subset of key columns.",
    fields: [
      { name: "columns", label: "Key columns", kind: "columns", help: "Empty = whole row" },
      { name: "keep", label: "Keep", kind: "enum", options: ["first", "last"], default: "first" },
    ],
  },
  {
    op: "fuzzy_deduplicate",
    label: "Fuzzy deduplicate",
    description: "Remove near-duplicate rows (typos, spacing, case) whose similarity is above a threshold.",
    fields: [
      { name: "columns", label: "Compare columns", kind: "columns", help: "Empty = all columns except surrogate ids" },
      { name: "threshold", label: "Similarity threshold", kind: "number", default: 0.9, min: 0.5, max: 1, step: 0.01, help: "0.5–1; higher = only very close matches" },
      { name: "window", label: "Blocking window", kind: "number", default: 10, min: 1, step: 1, help: "Rows compared with each neighbour after sorting; larger = slower, finds more" },
      { name: "keep", label: "Keep", kind: "enum", options: ["first", "last"], default: "first" },
    ],
  },
  {
    op: "cast",
    label: "Change type",
    description: "Convert a column's type with a strategy for values that fail to convert.",
    fields: [
      { name: "column", label: "Column", kind: "column", required: true },
      { name: "to", label: "To type", kind: "enum", required: true, options: ["string", "integer", "number", "boolean", "date", "datetime"], default: "number" },
      { name: "format", label: "Date format", kind: "text", help: "strptime format, e.g. %d/%m/%Y", showIf: { field: "to", in: ["date", "datetime"] } },
      { name: "on_error", label: "On failure", kind: "enum", options: ["null", "drop_row", "fail"], default: "null" },
    ],
  },
  {
    op: "normalize_strings",
    label: "Normalize text",
    description: "Trim, change case, collapse whitespace, regex find/replace.",
    fields: [
      { name: "columns", label: "Columns", kind: "columns", help: "Empty = all text columns" },
      { name: "trim", label: "Trim whitespace", kind: "boolean", default: true },
      { name: "case", label: "Case", kind: "enum", options: ["lower", "upper", "title"], nullable: true, default: null },
      { name: "collapse_whitespace", label: "Collapse whitespace", kind: "boolean", default: false },
      { name: "find", label: "Find (regex)", kind: "text" },
      { name: "replace", label: "Replace with", kind: "text", default: "" },
    ],
  },
  {
    op: "normalize_dates",
    label: "Normalize dates",
    description: "Parse mixed date formats into a single date/datetime column.",
    fields: [
      { name: "column", label: "Column", kind: "column", required: true },
      { name: "formats", label: "Formats (in order)", kind: "list", help: "Comma-separated strptime formats; empty = flexible parsing" },
      { name: "output", label: "Output", kind: "enum", options: ["date", "datetime"], default: "date" },
      { name: "dayfirst", label: "Day first (31/12)", kind: "boolean", default: false },
    ],
  },
  {
    op: "rename",
    label: "Rename columns",
    description: "Rename one or more columns.",
    fields: [{ name: "mapping", label: "Renames", kind: "mapping", required: true }],
  },
  {
    op: "drop_columns",
    label: "Drop columns",
    description: "Remove columns.",
    fields: [{ name: "columns", label: "Columns", kind: "columns", required: true }],
  },
  {
    op: "reorder",
    label: "Reorder columns",
    description: "Listed columns come first; the rest keep their order.",
    fields: [{ name: "columns", label: "Columns (in order)", kind: "columns", required: true }],
  },
  {
    op: "split",
    label: "Split column",
    description: "Split one column into several by a separator.",
    fields: [
      { name: "column", label: "Column", kind: "column", required: true },
      { name: "separator", label: "Separator", kind: "text", required: true, default: "," },
      { name: "into", label: "New column names", kind: "list", required: true, help: "Comma-separated, at least two" },
      { name: "drop_original", label: "Drop original", kind: "boolean", default: false },
    ],
  },
  {
    op: "merge",
    label: "Merge columns",
    description: "Concatenate columns into a new column.",
    fields: [
      { name: "columns", label: "Columns", kind: "columns", required: true, help: "At least two" },
      { name: "into", label: "New column", kind: "text", required: true },
      { name: "separator", label: "Separator", kind: "text", default: " " },
      { name: "drop_original", label: "Drop originals", kind: "boolean", default: false },
    ],
  },
  {
    op: "derive",
    label: "Derived column",
    description: "Add a column computed from a SQL expression.",
    fields: [
      { name: "name", label: "New column name", kind: "text", required: true },
      { name: "expression", label: "SQL expression", kind: "sql", required: true, help: 'e.g. "price" * "quantity"' },
    ],
  },
  {
    op: "filter",
    label: "Filter rows",
    description: "Keep rows matching a SQL condition.",
    fields: [{ name: "condition", label: "SQL condition", kind: "sql", required: true, help: "e.g. \"amount\" > 0 AND \"country\" = 'US'" }],
  },
  {
    op: "mask_pii",
    label: "Mask PII",
    description: "Mask, hash or redact personal data.",
    fields: [
      { name: "columns", label: "Columns", kind: "columns", required: true },
      { name: "strategy", label: "Strategy", kind: "enum", options: ["partial", "hash", "redact"], default: "partial" },
    ],
  },
];

export const STEP_DEF_BY_OP: Record<StepOp, StepDef> = Object.fromEntries(STEP_DEFS.map((d) => [d.op, d])) as Record<StepOp, StepDef>;

/** Form state: strings for text inputs, string[] for column pickers, booleans, mapping rows. */
export type FormValue = string | boolean | string[] | { from: string; to: string }[] | null;
export type StepFormState = Record<string, FormValue>;

export function isVisible(field: StepField, values: StepFormState): boolean {
  if (!field.showIf) return true;
  return field.showIf.in.includes(values[field.showIf.field] as unknown);
}

export function initialFormState(op: StepOp): StepFormState {
  const state: StepFormState = {};
  for (const f of STEP_DEF_BY_OP[op].fields) {
    switch (f.kind) {
      case "columns":
      case "list":
        state[f.name] = [];
        break;
      case "mapping":
        state[f.name] = [{ from: "", to: "" }];
        break;
      case "boolean":
        state[f.name] = Boolean(f.default);
        break;
      case "enum":
        state[f.name] = f.default === null || f.default === undefined ? (f.nullable ? null : f.options?.[0] ?? "") : String(f.default);
        break;
      default:
        state[f.name] = f.default === undefined || f.default === null ? "" : String(f.default);
    }
  }
  return state;
}

export class StepValidationError extends Error {
  constructor(readonly errors: Record<string, string>) {
    super(Object.values(errors).join("; "));
    this.name = "StepValidationError";
  }
}

function splitList(v: FormValue): string[] {
  if (Array.isArray(v)) return (v as unknown[]).map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === "string")
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

/**
 * Turn form state into a contract-shaped step. Hidden fields and empty optional values are omitted so
 * backend defaults apply; required fields are validated.
 */
export function serializeStep(op: StepOp, values: StepFormState, extra: Record<string, unknown> = {}): PipelineStep {
  const def = STEP_DEF_BY_OP[op];
  if (!def) throw new StepValidationError({ op: `unknown step op: ${op}` });
  const step: PipelineStep = { op };
  const errors: Record<string, string> = {};

  for (const f of def.fields) {
    if (!isVisible(f, values)) continue;
    const raw = values[f.name];
    switch (f.kind) {
      case "columns":
      case "list": {
        const list = splitList(raw);
        if (list.length) step[f.name] = list;
        else if (f.required) errors[f.name] = `${f.label} is required`;
        break;
      }
      case "column":
      case "text":
      case "sql": {
        const s = typeof raw === "string" ? raw : "";
        // separators/replacement strings may legitimately be whitespace
        const keepWhitespace = f.name === "separator" || f.name === "replace";
        const v = keepWhitespace ? s : s.trim();
        if (v !== "") step[f.name] = v;
        else if (f.required) errors[f.name] = `${f.label} is required`;
        break;
      }
      case "enum": {
        if (raw === null || raw === "") {
          if (f.nullable) step[f.name] = null;
          else if (f.required) errors[f.name] = `${f.label} is required`;
        } else if (typeof raw === "string") {
          if (f.options && !f.options.includes(raw)) errors[f.name] = `${f.label} must be one of ${f.options.join(", ")}`;
          else step[f.name] = raw;
        }
        break;
      }
      case "number": {
        const s = typeof raw === "string" ? raw.trim() : "";
        if (s === "") {
          if (f.required) errors[f.name] = `${f.label} is required`;
          break;
        }
        const n = Number(s);
        if (!Number.isFinite(n)) errors[f.name] = `${f.label} must be a number`;
        else if (f.min !== undefined && n < f.min) errors[f.name] = `${f.label} must be ≥ ${f.min}`;
        else if (f.max !== undefined && n > f.max) errors[f.name] = `${f.label} must be ≤ ${f.max}`;
        else step[f.name] = n;
        break;
      }
      case "boolean":
        step[f.name] = Boolean(raw);
        break;
      case "value": {
        const s = typeof raw === "string" ? raw : "";
        if (s.trim() === "") {
          if (f.required) errors[f.name] = `${f.label} is required`;
        } else {
          const n = Number(s);
          step[f.name] = Number.isFinite(n) && /^-?\d/.test(s.trim()) ? n : s;
        }
        break;
      }
      case "mapping": {
        const rows = Array.isArray(raw) ? (raw as { from: string; to: string }[]) : [];
        const mapping: Record<string, string> = {};
        for (const r of rows) {
          if (r && typeof r === "object" && r.from?.trim() && r.to?.trim()) mapping[r.from.trim()] = r.to.trim();
        }
        if (Object.keys(mapping).length) step[f.name] = mapping;
        else if (f.required) errors[f.name] = `${f.label}: add at least one rename`;
        break;
      }
    }
  }

  if (op === "split" && Array.isArray(step.into) && step.into.length < 2) errors.into = "Split needs at least two new column names";
  if (op === "merge" && Array.isArray(step.columns) && step.columns.length < 2) errors.columns = "Merge needs at least two columns";
  if (op === "derive" && typeof step.name === "string" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(step.name))
    errors.name = "Column name must be an identifier (letters, digits, underscore)";

  if (Object.keys(errors).length) throw new StepValidationError(errors);
  return { ...step, ...extra };
}

/** Inverse of serializeStep, used to edit an existing step or re-open a template step. */
export function deserializeStep(step: PipelineStep): StepFormState {
  const state = initialFormState(step.op);
  for (const f of STEP_DEF_BY_OP[step.op].fields) {
    const v = step[f.name];
    if (v === undefined) continue;
    switch (f.kind) {
      case "columns":
      case "list":
        state[f.name] = Array.isArray(v) ? v.map(String) : [];
        break;
      case "mapping":
        state[f.name] =
          v && typeof v === "object" ? Object.entries(v as Record<string, string>).map(([from, to]) => ({ from, to })) : [{ from: "", to: "" }];
        break;
      case "boolean":
        state[f.name] = Boolean(v);
        break;
      case "enum":
        state[f.name] = v === null ? null : String(v);
        break;
      default:
        state[f.name] = v === null ? "" : String(v);
    }
  }
  return state;
}

/** One-line description of a step for the step list. */
export function describeStep(step: PipelineStep): string {
  const def = STEP_DEF_BY_OP[step.op];
  const cols = (k: string) => (Array.isArray(step[k]) ? (step[k] as string[]).join(", ") : "");
  switch (step.op) {
    case "drop_missing":
      return step.axis === "columns" ? `columns with > ${Number(step.max_null_fraction ?? 0.5) * 100}% nulls` : `rows (${step.how ?? "any"}) ${cols("columns") || "all columns"}`;
    case "fill_missing":
      return `${cols("columns") || "all"} with ${step.strategy}${step.strategy === "constant" ? ` = ${String(step.value)}` : ""}`;
    case "handle_outliers":
      return `${step.action ?? "cap"} ${step.method ?? "iqr"} > ${step.threshold ?? 1.5} on ${cols("columns") || "numeric columns"}`;
    case "deduplicate":
      return `on ${cols("columns") || "whole row"}, keep ${step.keep ?? "first"}`;
    case "fuzzy_deduplicate":
      return `similarity ≥ ${step.threshold ?? 0.9} on ${cols("columns") || "all columns"}, keep ${step.keep ?? "first"}`;
    case "cast":
      return `${String(step.column)} → ${String(step.to)} (on error: ${step.on_error ?? "null"})`;
    case "normalize_strings":
      return `${cols("columns") || "text columns"}${step.case ? `, ${step.case}` : ""}${step.find ? `, /${step.find}/ → "${step.replace ?? ""}"` : ""}`;
    case "normalize_dates":
      return `${String(step.column)} → ${step.output ?? "date"}`;
    case "rename":
      return Object.entries((step.mapping as Record<string, string>) ?? {})
        .map(([a, b]) => `${a} → ${b}`)
        .join(", ");
    case "drop_columns":
    case "reorder":
      return cols("columns");
    case "split":
      return `${String(step.column)} by "${String(step.separator)}" into ${cols("into")}`;
    case "merge":
      return `${cols("columns")} → ${String(step.into)}`;
    case "derive":
      return `${String(step.name)} = ${String(step.expression)}`;
    case "filter":
      return String(step.condition);
    case "mask_pii":
      return `${cols("columns")} (${step.strategy ?? "partial"})`;
    default:
      return def?.description ?? "";
  }
}
