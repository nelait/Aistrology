/** Query builder model → DuckDB SQL over the table `data` (USR-001). */

export type BuilderAggregation = "none" | "sum" | "avg" | "count" | "count_distinct" | "min" | "max";

export type FilterOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "in" | "between" | "is_null" | "not_null";

export const FILTER_OPS: { value: FilterOp; label: string }[] = [
  { value: "=", label: "equals" },
  { value: "!=", label: "not equal" },
  { value: ">", label: ">" },
  { value: ">=", label: "≥" },
  { value: "<", label: "<" },
  { value: "<=", label: "≤" },
  { value: "contains", label: "contains" },
  { value: "in", label: "in list" },
  { value: "between", label: "between" },
  { value: "is_null", label: "is empty" },
  { value: "not_null", label: "is not empty" },
];

export interface Measure {
  column: string; // "*" allowed for count
  aggregation: BuilderAggregation;
  alias?: string;
}

export interface BuilderFilter {
  column: string;
  op: FilterOp;
  /** Literal value; a value starting with ":" is a parameter reference (USR-006). */
  value?: string;
  value2?: string;
}

export interface QueryModel {
  dimensions: string[];
  measures: Measure[];
  filters: BuilderFilter[];
  orderBy?: { column: string; direction: "asc" | "desc" } | null;
  limit?: number | null;
  table?: string;
}

export function quoteIdent(name: string): string {
  if (name === "*") return "*";
  return `"${name.replace(/"/g, '""')}"`;
}

/** SQL literal: numbers stay bare, parameters (`:name`) stay bare, everything else is a quoted string. */
export function literal(value: string | undefined): string {
  const v = (value ?? "").trim();
  if (/^:[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return v;
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) return v;
  if (/^(true|false)$/i.test(v)) return v.toLowerCase();
  return `'${v.replace(/'/g, "''")}'`;
}

export function measureAlias(m: Measure): string {
  if (m.alias) return m.alias;
  if (m.aggregation === "none") return m.column;
  if (m.column === "*") return m.aggregation === "count" ? "count" : m.aggregation;
  return `${m.aggregation}_${m.column}`;
}

export function measureExpr(m: Measure): string {
  const col = quoteIdent(m.column);
  switch (m.aggregation) {
    case "none":
      return col;
    case "count":
      return m.column === "*" ? "COUNT(*)" : `COUNT(${col})`;
    case "count_distinct":
      return `COUNT(DISTINCT ${col})`;
    default:
      return `${m.aggregation.toUpperCase()}(${col})`;
  }
}

export function filterExpr(f: BuilderFilter): string {
  const col = quoteIdent(f.column);
  switch (f.op) {
    case "is_null":
      return `${col} IS NULL`;
    case "not_null":
      return `${col} IS NOT NULL`;
    case "contains":
      return `CAST(${col} AS VARCHAR) ILIKE ${literal(`%${(f.value ?? "").trim()}%`)}`;
    case "in": {
      const items = (f.value ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => literal(s));
      return items.length ? `${col} IN (${items.join(", ")})` : "FALSE";
    }
    case "between":
      return `${col} BETWEEN ${literal(f.value)} AND ${literal(f.value2)}`;
    default:
      return `${col} ${f.op} ${literal(f.value)}`;
  }
}

export function generateSql(model: QueryModel): string {
  const table = model.table ?? "data";
  const measures = model.measures.filter((m) => m.column);
  const aggregated = measures.some((m) => m.aggregation !== "none");
  const select: string[] = [
    ...model.dimensions.map(quoteIdent),
    ...measures.map((m) => {
      const expr = measureExpr(m);
      const alias = measureAlias(m);
      return m.aggregation === "none" && alias === m.column ? expr : `${expr} AS ${quoteIdent(alias)}`;
    }),
  ];
  if (!select.length) select.push("*");
  const lines = [`SELECT ${select.join(", ")}`, `FROM ${quoteIdent(table)}`];
  const where = model.filters.filter((f) => f.column).map(filterExpr);
  if (where.length) lines.push(`WHERE ${where.join("\n  AND ")}`);
  if (aggregated && model.dimensions.length) lines.push(`GROUP BY ${model.dimensions.map(quoteIdent).join(", ")}`);
  if (model.orderBy?.column) lines.push(`ORDER BY ${quoteIdent(model.orderBy.column)} ${model.orderBy.direction.toUpperCase()}`);
  else if (aggregated && model.dimensions.length) lines.push(`ORDER BY ${model.dimensions.map(quoteIdent).join(", ")}`);
  if (model.limit && model.limit > 0) lines.push(`LIMIT ${Math.floor(model.limit)}`);
  return lines.join("\n");
}

/** Parameter names referenced as `:name` in SQL (ignoring `::` casts and string literals). */
export function sqlParameters(sql: string): string[] {
  const stripped = sql.replace(/'(?:[^']|'')*'/g, "''");
  const names = new Set<string>();
  const re = /(^|[^:A-Za-z0-9_]):([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) names.add(m[2]);
  return [...names];
}

/** Inline parameter values for an ad-hoc preview run (saved analytics bind them server-side). */
export function bindParameters(sql: string, params: Record<string, string | number | null | undefined>): string {
  return sql.replace(/(^|[^:A-Za-z0-9_]):([A-Za-z_][A-Za-z0-9_]*)/g, (whole, pre: string, name: string) => {
    if (!(name in params)) return whole;
    const v = params[name];
    if (v === null || v === undefined || v === "") return `${pre}NULL`;
    return `${pre}${typeof v === "number" ? String(v) : literal(String(v))}`;
  });
}
