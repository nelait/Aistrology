import type { DatasetProfile, DatasetRecord, QueryRequest, QueryResult, Schema, Suggestion, UploadResponse } from "../types.js";
import { AnalyticsPlatformError } from "../errors.js";
import { Resource, nameOf, seg, toBlob, type CallOptions, type UploadInput } from "./base.js";

export interface UploadOptions extends CallOptions {
  /** File name; its extension selects the parser (`.csv`, `.tsv`, `.json`, `.jsonl`, `.parquet`, `.xlsx`). Taken from `File.name` when omitted. */
  filename?: string;
  /** Hex SHA-256 of the content; the server rejects the upload if it does not match. */
  sha256?: string;
  /** Content type for the uploaded part. */
  contentType?: string;
  /**
   * `multipart` (default) posts a form with a `file` part; `stream` PUTs the raw bytes to
   * `/v1/datasets/upload?filename=`, which lets the server enforce size limits before reading.
   */
  method?: "multipart" | "stream";
}

export interface VersionOptions extends CallOptions {
  /** A specific version; the latest when omitted. */
  version?: number;
}

export class DatasetsResource extends Resource {
  /** Upload a file (Blob/File, bytes, or a string) and get back the dataset plus the inferred schema. */
  async upload(data: UploadInput, options: UploadOptions = {}): Promise<UploadResponse> {
    const { filename: givenName, sha256, contentType, method = "multipart", ...call } = options;
    const filename = givenName ?? nameOf(data);
    if (!filename) throw new AnalyticsPlatformError("datasets.upload needs a filename (pass options.filename)");
    const blob = toBlob(data, contentType);
    const headers: Record<string, string> = { ...(call.headers ?? {}) };
    if (sha256) headers["X-Content-SHA256"] = sha256;
    if (method === "stream") {
      if (blob.type) headers["Content-Type"] = blob.type;
      return this.http.request({
        method: "PUT",
        path: "/v1/datasets/upload",
        query: { filename },
        rawBody: blob,
        ...call,
        headers,
      });
    }
    const form = new FormData();
    form.append("file", blob, filename);
    return this.http.request({ method: "POST", path: "/v1/datasets", rawBody: form, ...call, headers });
  }

  list(options?: CallOptions): Promise<DatasetRecord[]> {
    return this.http.request({ method: "GET", path: "/v1/datasets", ...options });
  }

  get(datasetId: string, options: VersionOptions = {}): Promise<DatasetRecord> {
    const { version, ...call } = options;
    return this.http.request({ method: "GET", path: `/v1/datasets/${seg(datasetId)}`, query: { version }, ...call });
  }

  /** Every version, with lineage (`parent_version`, `pipeline_id`). */
  versions(datasetId: string, options?: CallOptions): Promise<DatasetRecord[]> {
    return this.http.request({ method: "GET", path: `/v1/datasets/${seg(datasetId)}/versions`, ...options });
  }

  delete(datasetId: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: `/v1/datasets/${seg(datasetId)}`, ...options });
  }

  /** Confirm (optionally after editing) the inferred schema. */
  confirmSchema(datasetId: string, schema: Schema, options?: CallOptions): Promise<DatasetRecord> {
    return this.http.request({ method: "PUT", path: `/v1/datasets/${seg(datasetId)}/schema`, body: schema, ...options });
  }

  profile(datasetId: string, options: VersionOptions = {}): Promise<DatasetProfile> {
    const { version, ...call } = options;
    return this.http.request({ method: "GET", path: `/v1/datasets/${seg(datasetId)}/profile`, query: { version }, ...call });
  }

  /** Run read-only SQL in the sandbox. The main table is called `data`. */
  query(datasetId: string, query: string | QueryRequest, options: VersionOptions = {}): Promise<QueryResult> {
    const { version, ...call } = options;
    const body: QueryRequest = typeof query === "string" ? { sql: query } : query;
    return this.http.request({ method: "POST", path: `/v1/datasets/${seg(datasetId)}/query`, query: { version }, body, ...call });
  }

  /** LLM-generated analytics suggestions, each with validated SQL and a preview. */
  suggestions(datasetId: string, params: { question?: string } = {}, options?: CallOptions): Promise<Suggestion[]> {
    return this.http.request({
      method: "POST",
      path: `/v1/datasets/${seg(datasetId)}/suggestions`,
      body: params.question !== undefined ? { question: params.question } : {},
      ...options,
    });
  }
}
