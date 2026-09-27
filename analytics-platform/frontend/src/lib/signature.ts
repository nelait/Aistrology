import type { SignatureField } from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function typeOf(x: Record<string, unknown>): string {
  if (typeof x.type === "string") return x.type;
  const dtype = typeof x.dtype === "string" ? x.dtype : "";
  if (x.group === "numeric" || /^(int|float|uint)/.test(dtype)) return "number";
  if (x.group === "datetime" || /datetime/.test(dtype)) return "datetime";
  if (dtype === "bool") return "boolean";
  return "string";
}

function fromList(list: unknown[]): SignatureField[] {
  return list
    .map((x): SignatureField | null => {
      if (typeof x === "string") return { name: x, type: "string" };
      if (isRecord(x) && typeof x.name === "string") {
        if (x.group === "dropped") return null; // not used by the model
        return {
          name: x.name,
          type: typeOf(x),
          categories: Array.isArray(x.categories) ? x.categories.map(String) : undefined,
          min: typeof x.min === "number" ? x.min : undefined,
          max: typeof x.max === "number" ? x.max : undefined,
        };
      }
      return null;
    })
    .filter((x): x is SignatureField => x !== null);
}

/**
 * Normalize a model signature into input fields. The contract leaves `signature` open, so this accepts
 * `{inputs: [...]}`, `{features: [...]}`, `{columns: [...]}`, a list of `{name, type}`, a `{name: type}`
 * map, or a JSON-Schema object with `properties`.
 */
export function signatureFields(sig: unknown): SignatureField[] {
  if (!sig) return [];
  if (Array.isArray(sig)) return fromList(sig);
  if (!isRecord(sig)) return [];
  for (const key of ["features", "inputs", "columns", "input"]) {
    const v = sig[key];
    if (Array.isArray(v)) return fromList(v);
    if (isRecord(v)) return signatureFields(v);
  }
  if (isRecord(sig.properties))
    return Object.entries(sig.properties).map(([name, p]) => ({ name, type: isRecord(p) && typeof p.type === "string" ? p.type : "string" }));
  if ("target" in sig || "problem_type" in sig) return [];
  const entries = Object.entries(sig).filter(([, v]) => typeof v === "string");
  return entries.map(([name, type]) => ({ name, type: String(type) }));
}

/** Extract instance fields from an endpoint's OpenAPI document (fallback when no signature is available). */
export function openapiFields(doc: unknown): SignatureField[] {
  if (!isRecord(doc) || !isRecord(doc.components) || !isRecord(doc.components.schemas)) return [];
  const schemas = doc.components.schemas;
  const candidate = Object.entries(schemas).find(([k]) => /instance|input|features|record/i.test(k))?.[1];
  return candidate ? signatureFields(candidate) : [];
}

export function coerce(value: string, type: string): unknown {
  if (value === "") return null;
  const t = type.toLowerCase();
  if (/(int|float|double|number|numeric|decimal)/.test(t)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (/bool/.test(t)) return value === "true";
  return value;
}
