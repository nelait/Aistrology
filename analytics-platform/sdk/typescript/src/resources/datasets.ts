import type {
  AdvancedProfile,
  AdvancedProfileRequest,
  AnnotationsUpdate,
  DatasetAnnotations,
  DatasetEvolution,
  DatasetProfile,
  DatasetRecord,
  Projection,
  ProjectionRequest,
  QueryRequest,
  QueryResult,
  Schema,
  Suggestion,
  SuggestionFeedback,
  SuggestionPreferences,
  UploadResponse,
  UploadSession,
  VersionMode,
} from "../types.js";
import { AnalyticsPlatformError, ApiError, ConflictError, NetworkError, ServerError, TimeoutError } from "../errors.js";
import { sleep } from "../http.js";
import { Resource, nameOf, seg, toBlob, type CallOptions, type UploadInput } from "./base.js";

/** `datasets.upload` switches to the resumable protocol above this size (100 MB). */
export const RESUMABLE_UPLOAD_THRESHOLD = 100 * 1024 * 1024;

export interface ResumableUploadOptions extends CallOptions {
  filename?: string;
  contentType?: string;
  projectId?: string;
  /** Hex SHA-256 of the whole file (verified by the server on completion). `true` computes it with WebCrypto. */
  sha256?: string | boolean;
  /** Bytes per part (capped by the server's `part_max_bytes`, 32 MB by default). */
  partSize?: number;
  /** Resume an existing session (e.g. after the app restarted) instead of starting a new one. */
  uploadId?: string;
  /** Called after every part with the bytes the server has received. */
  onProgress?: (sent: number, total: number) => void;
  /** Consecutive failed attempts tolerated per part (default 5). */
  maxPartRetries?: number;
}

export interface UploadOptions extends CallOptions {
  /** File name; its extension selects the parser (`.csv`, `.tsv`, `.json`, `.jsonl`, `.parquet`, `.xlsx`). Taken from `File.name` when omitted. */
  filename?: string;
  /** Hex SHA-256 of the content; the server rejects the upload if it does not match. */
  sha256?: string;
  /** Content type for the uploaded part. */
  contentType?: string;
  /**
   * `multipart` (default) posts a form with a `file` part; `stream` PUTs the raw bytes to
   * `/v1/datasets/upload?filename=`, which lets the server enforce size limits before reading;
   * `resumable` uses `uploadResumable`. Files above 100 MB use `resumable` unless a method is given.
   */
  method?: "multipart" | "stream" | "resumable";
  /** Target project (defaults to the open "Default" project). */
  projectId?: string;
  /** Progress callback (resumable uploads only). */
  onProgress?: (sent: number, total: number) => void;
}

export interface VersionOptions extends CallOptions {
  /** A specific version; the latest when omitted. */
  version?: number;
}

export class DatasetsResource extends Resource {
  /** Upload a file (Blob/File, bytes, or a string) and get back the dataset plus the inferred schema. */
  async upload(data: UploadInput, options: UploadOptions = {}): Promise<UploadResponse> {
    const { filename: givenName, sha256, contentType, method: givenMethod, projectId, onProgress, ...call } = options;
    const filename = givenName ?? nameOf(data);
    if (!filename) throw new AnalyticsPlatformError("datasets.upload needs a filename (pass options.filename)");
    const blob = toBlob(data, contentType);
    const method = givenMethod ?? (blob.size > RESUMABLE_UPLOAD_THRESHOLD ? "resumable" : "multipart");
    if (method === "resumable") {
      const resumable: ResumableUploadOptions = { ...call, filename };
      if (sha256 !== undefined) resumable.sha256 = sha256;
      if (projectId !== undefined) resumable.projectId = projectId;
      if (onProgress !== undefined) resumable.onProgress = onProgress;
      return this.uploadResumable(blob, resumable);
    }
    const headers: Record<string, string> = { ...(call.headers ?? {}) };
    if (sha256) headers["X-Content-SHA256"] = sha256;
    if (method === "stream") {
      if (blob.type) headers["Content-Type"] = blob.type;
      return this.http.request({
        method: "PUT",
        path: "/v1/datasets/upload",
        query: { filename, project_id: projectId },
        rawBody: blob,
        ...call,
        headers,
      });
    }
    const form = new FormData();
    form.append("file", blob, filename);
    return this.http.request({ method: "POST", path: "/v1/datasets", query: { project_id: projectId }, rawBody: form, ...call, headers });
  }

  /**
   * Resumable upload (ING-NFR-001): declare the file, send it in parts with `Upload-Offset`, then complete.
   * After a network error, timeout, 5xx or offset conflict the client asks the server for its offset and
   * continues from there, so a flaky connection never restarts a large upload from zero.
   */
  async uploadResumable(data: UploadInput, options: ResumableUploadOptions = {}): Promise<UploadResponse> {
    const { filename: givenName, contentType, projectId, sha256, partSize, uploadId, onProgress, maxPartRetries = 5, ...call } = options;
    const filename = givenName ?? nameOf(data);
    if (!filename) throw new AnalyticsPlatformError("datasets.uploadResumable needs a filename (pass options.filename)");
    const blob = toBlob(data, contentType);
    let session: UploadSession;
    if (uploadId) {
      session = await this.uploadStatus(uploadId, call);
      if (session.size !== blob.size) throw new AnalyticsPlatformError(`upload ${uploadId} expects ${session.size} bytes, got ${blob.size}`);
    } else {
      const digest = sha256 === true ? await sha256Hex(blob) : typeof sha256 === "string" ? sha256 : undefined;
      const body: Record<string, unknown> = { filename, size: blob.size };
      if (digest) body.sha256 = digest;
      if (projectId) body.project_id = projectId;
      session = await this.http.request<UploadSession>({ method: "POST", path: "/v1/datasets/uploads", body, ...call });
    }
    const id = session.id;
    const part = Math.max(1, Math.min(partSize ?? session.part_max_bytes, session.part_max_bytes));
    let offset = session.offset;
    let failures = 0;
    for (;;) {
      while (offset < blob.size) {
        try {
          const status = await this.http.request<UploadSession>({
            method: "PATCH",
            path: `/v1/datasets/uploads/${seg(id)}`,
            rawBody: blob.slice(offset, offset + part),
            ...call,
            headers: { ...(call.headers ?? {}), "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" },
          });
          offset = status.offset;
          failures = 0;
        } catch (err) {
          if (!isResumable(err) || ++failures > maxPartRetries) throw err;
          if (!(err instanceof ConflictError)) await sleep(Math.min(500 * 2 ** (failures - 1), 10_000), call.signal);
          offset = await this.resyncOffset(id, err, call);
        }
        onProgress?.(offset, blob.size);
      }
      try {
        // Completing is idempotent once it succeeded, so it is safe to retry.
        return await this.http.request<UploadResponse>({ method: "POST", path: `/v1/datasets/uploads/${seg(id)}/complete`, idempotent: true, ...call });
      } catch (err) {
        if (!(err instanceof ConflictError) || ++failures > maxPartRetries) throw err;
        offset = await this.resyncOffset(id, err, call);
      }
    }
  }

  private async resyncOffset(uploadId: string, err: unknown, call: CallOptions): Promise<number> {
    const detail = err instanceof ApiError ? err.detail : undefined;
    const offset = detail && typeof detail === "object" ? (detail as { offset?: unknown }).offset : undefined;
    if (typeof offset === "number") return offset;
    return (await this.uploadStatus(uploadId, call)).offset;
  }

  /** Status of a resumable upload, including the byte `offset` received so far. */
  uploadStatus(uploadId: string, options?: CallOptions): Promise<UploadSession> {
    return this.http.request({ method: "GET", path: `/v1/datasets/uploads/${seg(uploadId)}`, ...options });
  }

  abortUpload(uploadId: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: `/v1/datasets/uploads/${seg(uploadId)}`, ...options });
  }

  list(options: CallOptions & { projectId?: string } = {}): Promise<DatasetRecord[]> {
    const { projectId, ...call } = options;
    return this.http.request({ method: "GET", path: "/v1/datasets", query: { project_id: projectId }, ...call });
  }

  /**
   * Upload the next version of a dataset (INF-007/008): `append` adds the rows to the matching table,
   * `replace` keeps only the file's tables. Not retried on 5xx (it creates a version).
   */
  addVersion(
    datasetId: string,
    data: UploadInput,
    options: CallOptions & { filename?: string; mode?: VersionMode; sha256?: string; contentType?: string } = {},
  ): Promise<DatasetEvolution> {
    const { filename: givenName, mode = "append", sha256, contentType, ...call } = options;
    const filename = givenName ?? nameOf(data) ?? "upload.csv";
    const form = new FormData();
    form.append("file", toBlob(data, contentType), filename);
    const headers: Record<string, string> = { ...(call.headers ?? {}) };
    if (sha256) headers["X-Content-SHA256"] = sha256;
    return this.http.request({ method: "POST", path: `/v1/datasets/${seg(datasetId)}/versions`, query: { mode }, rawBody: form, ...call, headers });
  }

  annotations(datasetId: string, options: VersionOptions = {}): Promise<DatasetAnnotations> {
    const { version, ...call } = options;
    return this.http.request({ method: "GET", path: `/v1/datasets/${seg(datasetId)}/annotations`, query: { version }, ...call });
  }

  /** Tag columns (`pii`, `sensitive`, `derived`, `target`, `id`); `pii`/`sensitive` also mark the field as PII. */
  setAnnotations(datasetId: string, body: AnnotationsUpdate, options?: CallOptions): Promise<DatasetAnnotations> {
    return this.http.request({ method: "PUT", path: `/v1/datasets/${seg(datasetId)}/annotations`, body: { replace: true, ...body }, ...options });
  }

  /** Isolation-forest outliers, near duplicates and missingness patterns. Pass `{section: {enabled: false}}` to skip one. */
  advancedProfile(datasetId: string, body: AdvancedProfileRequest = {}, options: VersionOptions & { table?: string } = {}): Promise<AdvancedProfile> {
    const { version, table, ...call } = options;
    return this.http.request({ method: "POST", path: `/v1/datasets/${seg(datasetId)}/profile/advanced`, query: { version, table }, body, ...call });
  }

  /** 2-D UMAP / t-SNE / PCA projection of the rows, for scatter plots (FE-005a). */
  projection(datasetId: string, body: ProjectionRequest = {}, options: VersionOptions = {}): Promise<Projection> {
    const { version, ...call } = options;
    return this.http.request({ method: "POST", path: `/v1/datasets/${seg(datasetId)}/projection`, query: { version }, body, ...call });
  }

  /** Teach the suggestion ranking which chart types and categories are useful (LLM-009). */
  suggestionFeedback(datasetId: string, body: SuggestionFeedback, options?: CallOptions): Promise<SuggestionPreferences> {
    const { chart_type, category, title } = body.suggestion;
    const suggestion: SuggestionFeedback["suggestion"] = { chart_type, category };
    if (title !== undefined) suggestion.title = title;
    return this.http.request({
      method: "POST",
      path: `/v1/datasets/${seg(datasetId)}/suggestions/feedback`,
      body: { accepted: body.accepted, suggestion },
      ...options,
    });
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

function isResumable(err: unknown): boolean {
  return err instanceof ConflictError || err instanceof ServerError || err instanceof NetworkError || err instanceof TimeoutError;
}

async function sha256Hex(blob: Blob): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) throw new AnalyticsPlatformError("WebCrypto is not available to compute the SHA-256; pass it as a string");
  const digest = await subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
