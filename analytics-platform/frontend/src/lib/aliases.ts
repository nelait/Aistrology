/** Table aliases for multi-dataset analytics (LLM-008): `^[a-z_][a-z0-9_]{0,39}$`, not a SQL keyword, 1–5 datasets. */

export const ALIAS_RE = /^[a-z_][a-z0-9_]{0,39}$/;
export const MAX_DATASETS = 5;

/** The server's reserved list plus other common keywords (the client is slightly stricter on purpose). */
export const SQL_KEYWORDS = new Set([
  "select", "from", "where", "join", "on", "group", "order", "by", "limit", "table", "union", "as", "and", "or", "not",
  "with", "having", "distinct", "case", "when", "then", "else", "end", "null", "in", "is", "like", "between", "all",
  "any", "exists", "into", "values", "insert", "update", "delete", "create", "drop", "left", "right", "inner", "outer",
  "full", "cross", "natural", "using", "offset", "asc", "desc", "true", "false",
]);

export interface AliasEntry {
  alias: string;
  datasetId: string;
}

/** Error message for one alias, or null when valid. */
export function aliasError(alias: string): string | null {
  if (!alias) return "Enter an alias";
  if (alias.length > 40) return "At most 40 characters";
  if (!ALIAS_RE.test(alias)) return "Use lowercase letters, digits and underscores; start with a letter or underscore";
  if (SQL_KEYWORDS.has(alias)) return `“${alias}” is a SQL keyword`;
  return null;
}

/** A valid alias derived from a dataset name (`Customer Orders 2024` → `customer_orders_2024`). */
export function suggestAlias(name: string, taken: Iterable<string> = []): string {
  let base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!base) base = "t";
  if (/^[0-9]/.test(base)) base = `t_${base}`;
  base = base.slice(0, 36);
  if (SQL_KEYWORDS.has(base)) base = `${base}_t`;
  const used = new Set(taken);
  let alias = base;
  for (let i = 2; used.has(alias); i++) alias = `${base}_${i}`;
  return alias;
}

export interface AliasValidation {
  /** per-row error (same order as the input) */
  errors: (string | null)[];
  /** error for the whole set (count, duplicates) */
  formError: string | null;
  valid: boolean;
}

/** Validate the alias → dataset rows of the multi-dataset form. `min` is 1 for queries and 2 for suggestions. */
export function validateAliases(entries: AliasEntry[], min = 1): AliasValidation {
  const counts = new Map<string, number>();
  entries.forEach((e) => counts.set(e.alias, (counts.get(e.alias) ?? 0) + 1));
  const errors = entries.map((e) => {
    if (!e.datasetId) return "Choose a dataset";
    const err = aliasError(e.alias);
    if (err) return err;
    if ((counts.get(e.alias) ?? 0) > 1) return "Alias used twice";
    return null;
  });
  let formError: string | null = null;
  if (entries.length < min) formError = min === 1 ? "Add at least one dataset" : `Add at least ${min} datasets`;
  else if (entries.length > MAX_DATASETS) formError = `At most ${MAX_DATASETS} datasets`;
  return { errors, formError, valid: !formError && errors.every((e) => e === null) };
}

/** `{alias: dataset_id}` for the API. */
export function aliasMap(entries: AliasEntry[]): Record<string, string> {
  return Object.fromEntries(entries.map((e) => [e.alias, e.datasetId]));
}
