/** Per-field distribution settings for the sample-data generator (GEN-006). */
import type { Distribution, DistributionKind, Schema } from "./types";

export interface DistributionDraft {
  kind: DistributionKind;
  mean: string;
  std: string;
  sigma: string;
  /** "gold=1, silver=3" */
  weights: string;
}

export const EMPTY_DRAFT: DistributionDraft = { kind: "uniform", mean: "", std: "", sigma: "", weights: "" };

/** Parse "a=1, b=2.5" (or one per line) into a weights map. */
export function parseWeights(text: string): { weights: Record<string, number>; error: string | null } {
  const weights: Record<string, number> = {};
  for (const raw of text.split(/[\n,]/)) {
    const part = raw.trim();
    if (!part) continue;
    const i = part.lastIndexOf("=");
    if (i <= 0) return { weights, error: `“${part}” should look like value=weight` };
    const key = part.slice(0, i).trim();
    const w = Number(part.slice(i + 1).trim());
    if (!key) return { weights, error: `“${part}” has no value` };
    if (!Number.isFinite(w) || w < 0) return { weights, error: `Weight for “${key}” must be a non-negative number` };
    weights[key] = w;
  }
  if (Object.keys(weights).length && Object.values(weights).every((w) => w === 0)) return { weights, error: "At least one weight must be positive" };
  return { weights, error: null };
}

function num(s: string): number | undefined {
  if (s.trim() === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Validate one draft; returns the API distribution or an error. `uniform` → null (the default, omitted). */
export function toDistribution(d: DistributionDraft): { value: Distribution | null; error: string | null } {
  switch (d.kind) {
    case "uniform":
      return { value: null, error: null };
    case "normal": {
      const std = num(d.std);
      if (std !== undefined && std <= 0) return { value: null, error: "Standard deviation must be > 0" };
      return { value: { kind: "normal", mean: num(d.mean) ?? null, std: std ?? null }, error: null };
    }
    case "lognormal": {
      const sigma = num(d.sigma);
      if (sigma !== undefined && (sigma <= 0 || sigma > 10)) return { value: null, error: "Sigma must be in (0, 10]" };
      return { value: { kind: "lognormal", mean: num(d.mean) ?? null, sigma: sigma ?? null }, error: null };
    }
    case "weights": {
      const { weights, error } = parseWeights(d.weights);
      if (error) return { value: null, error };
      if (!Object.keys(weights).length) return { value: null, error: "Add at least one value=weight pair" };
      return { value: { kind: "weights", weights }, error: null };
    }
  }
}

/** Build `options.distributions` from drafts keyed "entity.field"; collects errors per key. */
export function buildDistributions(drafts: Record<string, DistributionDraft>): { distributions: Record<string, Distribution>; errors: Record<string, string> } {
  const distributions: Record<string, Distribution> = {};
  const errors: Record<string, string> = {};
  for (const [key, draft] of Object.entries(drafts)) {
    const { value, error } = toDistribution(draft);
    if (error) errors[key] = error;
    else if (value) distributions[key] = value;
  }
  return { distributions, errors };
}

/** Fields a distribution can apply to: numbers, and strings/enums (weights). */
export function distributionTargets(schema: Schema | null): { key: string; type: string; enumValues: string[] | null }[] {
  if (!schema) return [];
  return schema.entities.flatMap((e) =>
    e.fields
      .filter((f) => !f.primary_key && !f.references && (f.type === "integer" || f.type === "number" || f.type === "string" || f.type === "boolean"))
      .map((f) => ({ key: `${e.name}.${f.name}`, type: f.type, enumValues: f.enum?.length ? f.enum.map(String) : null })),
  );
}
