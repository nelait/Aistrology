/** Connector form definitions (ING-007). Credentials are write-only: sent once, stored in the secret manager. */
import type { ConnectorKind } from "./types";

export interface ConnectorField {
  name: string;
  label: string;
  required?: boolean;
  type?: "text" | "number" | "password" | "textarea";
  placeholder?: string;
  hint?: string;
}

export const CONNECTOR_KINDS: { kind: ConnectorKind; label: string; storage: boolean }[] = [
  { kind: "s3", label: "Amazon S3 (or S3-compatible)", storage: true },
  { kind: "gcs", label: "Google Cloud Storage", storage: true },
  { kind: "postgresql", label: "PostgreSQL", storage: false },
  { kind: "mysql", label: "MySQL / MariaDB", storage: false },
];

export const CONFIG_FIELDS: Record<ConnectorKind, ConnectorField[]> = {
  s3: [
    { name: "bucket", label: "Bucket", required: true },
    { name: "region", label: "Region", placeholder: "us-east-1" },
    { name: "endpoint_url", label: "Endpoint URL", placeholder: "https://minio.example.com", hint: "Only for S3-compatible stores (MinIO, R2…)" },
  ],
  gcs: [
    { name: "bucket", label: "Bucket", required: true },
    { name: "project", label: "Project" },
  ],
  postgresql: [
    { name: "host", label: "Host", required: true, placeholder: "db.example.com" },
    { name: "port", label: "Port", type: "number", placeholder: "5432" },
    { name: "database", label: "Database", required: true },
    { name: "sslmode", label: "SSL mode", placeholder: "require" },
  ],
  mysql: [
    { name: "host", label: "Host", required: true, placeholder: "db.example.com" },
    { name: "port", label: "Port", type: "number", placeholder: "3306" },
    { name: "database", label: "Database", required: true },
  ],
};

export const CREDENTIAL_FIELDS: Record<ConnectorKind, ConnectorField[]> = {
  s3: [
    { name: "access_key_id", label: "Access key ID", required: true },
    { name: "secret_access_key", label: "Secret access key", required: true, type: "password" },
    { name: "session_token", label: "Session token", type: "password" },
  ],
  gcs: [{ name: "service_account_json", label: "Service account JSON", required: true, type: "textarea" }],
  postgresql: [
    { name: "username", label: "Username", required: true },
    { name: "password", label: "Password", required: true, type: "password" },
  ],
  mysql: [
    { name: "username", label: "Username", required: true },
    { name: "password", label: "Password", required: true, type: "password" },
  ],
};

/** Build `{config, credentials}` from form values: trims, drops empties, converts numbers. Returns missing required labels. */
export function buildConnectorBody(kind: ConnectorKind, values: Record<string, string>): { config: Record<string, unknown>; credentials: Record<string, unknown>; missing: string[] } {
  const missing: string[] = [];
  const pick = (fields: ConnectorField[]) => {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = (values[f.name] ?? "").trim();
      if (!raw) {
        if (f.required) missing.push(f.label);
        continue;
      }
      out[f.name] = f.type === "number" ? Number(raw) : raw;
    }
    return out;
  };
  return { config: pick(CONFIG_FIELDS[kind]), credentials: pick(CREDENTIAL_FIELDS[kind]), missing };
}

/** Client-side check that the import query is a single SELECT (the server enforces it in a read-only transaction). */
export function selectQueryError(sql: string): string | null {
  const s = sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim()
    .replace(/;\s*$/, "");
  if (!s) return "Enter a SELECT query";
  if (!/^(select|with)\b/i.test(s)) return "Only a single SELECT (or WITH … SELECT) query is allowed";
  if (s.includes(";")) return "Only one statement is allowed";
  return null;
}

/** Short description of a connector's (non-secret) config. */
export function describeConfig(kind: string, config: Record<string, unknown>): string {
  if (kind === "s3" || kind === "gcs") return `${kind}://${String(config.bucket ?? "?")}${config.region ? ` (${String(config.region)})` : ""}`;
  return `${String(config.host ?? "?")}${config.port ? `:${String(config.port)}` : ""}/${String(config.database ?? "")}`;
}
