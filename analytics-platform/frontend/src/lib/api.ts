/**
 * Typed client for the Analytics Platform API (docs/API_CONTRACT.md).
 *
 * Token handling:
 *  - the access token lives in memory only;
 *  - the refresh token lives in localStorage so a reload keeps the session;
 *  - on a 401 the client refreshes once and retries the request. Refresh tokens rotate (single use),
 *    so concurrent 401s share a single in-flight refresh promise, and a request that failed with an
 *    access token that has since been replaced is simply retried without refreshing again.
 */
import type * as T from "./types";

export * from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/+$/, "");
export const REFRESH_KEY = "ap.refresh_token";

// -- Errors ---------------------------------------------------------------------------

export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;
  readonly code?: string;

  constructor(status: number, detail: unknown) {
    super(errorMessage(detail, status));
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    if (detail && typeof detail === "object" && !Array.isArray(detail) && "code" in detail) {
      const code = (detail as { code: unknown }).code;
      if (typeof code === "string") this.code = code;
    }
  }
}

/** Human readable text for a FastAPI `detail` (string, {code, message}, {message, issues} or a 422 list). */
export function errorMessage(detail: unknown, status?: number): string {
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((d) => {
      if (d && typeof d === "object") {
        const o = d as { loc?: unknown[]; msg?: string; message?: string; path?: string };
        const where = Array.isArray(o.loc) ? o.loc.filter((p) => p !== "body").join(".") : o.path;
        const text = o.msg ?? o.message ?? JSON.stringify(d);
        return where ? `${where}: ${text}` : text;
      }
      return String(d);
    });
    return parts.join("; ") || `Request failed${status ? ` (${status})` : ""}`;
  }
  if (detail && typeof detail === "object") {
    const o = detail as { message?: unknown; issues?: unknown; code?: unknown };
    let text = typeof o.message === "string" ? o.message : typeof o.code === "string" ? o.code : "";
    if (Array.isArray(o.issues) && o.issues.length) text = `${text}${text ? ": " : ""}${errorMessage(o.issues)}`;
    if (text) return text;
  }
  if (status === 0) return "Network error: the API is unreachable";
  return `Request failed${status ? ` (${status})` : ""}`;
}

// -- Storage abstraction (testable) -----------------------------------------------------

export interface TokenStorage {
  get(): string | null;
  set(token: string | null): void;
}

export const localTokenStorage: TokenStorage = {
  get() {
    try {
      return typeof window === "undefined" ? null : window.localStorage.getItem(REFRESH_KEY);
    } catch {
      return null;
    }
  },
  set(token) {
    try {
      if (typeof window === "undefined") return;
      if (token) window.localStorage.setItem(REFRESH_KEY, token);
      else window.localStorage.removeItem(REFRESH_KEY);
    } catch {
      /* storage unavailable: session lasts until reload */
    }
  },
};

export function memoryTokenStorage(initial: string | null = null): TokenStorage {
  let value = initial;
  return {
    get: () => value,
    set: (t) => {
      value = t;
    },
  };
}

// -- Client ----------------------------------------------------------------------------

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: string;
  query?: Query;
  /** JSON body (serialized) */
  json?: unknown;
  /** Raw body (FormData, Blob …) */
  body?: BodyInit;
  headers?: Record<string, string>;
  /** Send the bearer token and refresh on 401 (default true). */
  auth?: boolean;
  signal?: AbortSignal;
}

export interface ClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  storage?: TokenStorage;
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly storage: TokenStorage;
  private accessToken: string | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  private listeners = new Set<(authenticated: boolean) => void>();

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? API_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.storage = opts.storage ?? localTokenStorage;
  }

  // -- token state --

  get isAuthenticated(): boolean {
    return this.accessToken !== null;
  }

  get hasRefreshToken(): boolean {
    return !!this.storage.get();
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  /** Subscribe to auth changes (false = the session was lost and the user must log in again). */
  onAuthChange(fn: (authenticated: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setTokens(pair: T.TokenPair): void {
    this.accessToken = pair.access_token;
    this.storage.set(pair.refresh_token);
    this.listeners.forEach((l) => l(true));
  }

  clearTokens(): void {
    const had = this.accessToken !== null || this.storage.get() !== null;
    this.accessToken = null;
    this.storage.set(null);
    if (had) this.listeners.forEach((l) => l(false));
  }

  /**
   * Exchange the stored refresh token for a new pair. Concurrent callers share one in-flight request,
   * because each refresh token can be used exactly once.
   */
  refresh(): Promise<boolean> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async doRefresh(retry = true): Promise<boolean> {
    const token = this.storage.get();
    if (!token) {
      this.clearTokens();
      return false;
    }
    const res = await this.fetchImpl(`${this.baseUrl}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: token }),
    });
    if (res.ok) {
      this.setTokens((await res.json()) as T.TokenPair);
      return true;
    }
    if (res.status === 401 || res.status === 403) {
      // Another tab may have rotated the token in the meantime: retry once with the newer token.
      const latest = this.storage.get();
      if (retry && latest && latest !== token) return this.doRefresh(false);
      this.clearTokens();
      return false;
    }
    throw new ApiError(res.status, await readDetail(res));
  }

  url(path: string, query?: Query): string {
    const u = `${this.baseUrl}${path}`;
    if (!query) return u;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
    const qs = params.toString();
    return qs ? `${u}?${qs}` : u;
  }

  /** Low-level request returning the raw Response (after 401 → refresh → retry). Throws ApiError on !ok. */
  async raw(path: string, opts: RequestOptions = {}): Promise<Response> {
    const auth = opts.auth ?? true;
    if (auth && !this.accessToken && this.storage.get()) await this.refresh();

    const send = () => {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      let body = opts.body;
      if (opts.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.json);
      }
      const used = this.accessToken;
      if (auth && used) headers.Authorization = `Bearer ${used}`;
      return {
        used,
        promise: this.fetchImpl(this.url(path, opts.query), { method: opts.method ?? "GET", headers, body, signal: opts.signal }),
      };
    };

    let attempt;
    let res: Response;
    try {
      attempt = send();
      res = await attempt.promise;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new ApiError(0, err instanceof Error ? `Network error: ${err.message}` : "Network error");
    }
    if (res.status === 401 && auth) {
      // If another request already refreshed while this one was in flight, just retry.
      const refreshed = this.accessToken && this.accessToken !== attempt.used ? true : await this.refresh();
      if (refreshed) {
        attempt = send();
        res = await attempt.promise;
      }
    }
    if (!res.ok) throw new ApiError(res.status, await readDetail(res));
    return res;
  }

  async request<R>(path: string, opts: RequestOptions = {}): Promise<R> {
    const res = await this.raw(path, opts);
    if (res.status === 204) return undefined as R;
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("application/json")) return (await res.json()) as R;
    return (await res.text()) as unknown as R;
  }

  get<R>(path: string, query?: Query): Promise<R> {
    return this.request<R>(path, { query });
  }

  post<R>(path: string, json?: unknown, query?: Query): Promise<R> {
    return this.request<R>(path, { method: "POST", json, query });
  }

  put<R>(path: string, json?: unknown, query?: Query): Promise<R> {
    return this.request<R>(path, { method: "PUT", json, query });
  }

  patch<R>(path: string, json?: unknown): Promise<R> {
    return this.request<R>(path, { method: "PATCH", json });
  }

  del<R = void>(path: string, query?: Query): Promise<R> {
    return this.request<R>(path, { method: "DELETE", query });
  }

  /** Authenticated file download. */
  async download(path: string, opts: RequestOptions = {}): Promise<{ blob: Blob; filename: string | null }> {
    const res = await this.raw(path, opts);
    return { blob: await res.blob(), filename: filenameFromDisposition(res.headers.get("content-disposition")) };
  }

  /**
   * Multipart upload with progress (XMLHttpRequest: fetch has no upload progress). Retries once after a
   * token refresh on 401.
   */
  upload<R>(
    path: string,
    form: FormData,
    onProgress?: (p: UploadProgress) => void,
    signal?: AbortSignal,
    query?: Query,
  ): Promise<R> {
    const run = async (retry: boolean): Promise<R> => {
      if (!this.accessToken && this.storage.get()) await this.refresh();
      const used = this.accessToken;
      const result = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", this.url(path, query));
        if (used) xhr.setRequestHeader("Authorization", `Bearer ${used}`);
        xhr.upload.onprogress = (e) => onProgress?.({ loaded: e.loaded, total: e.lengthComputable ? e.total : 0 });
        xhr.onload = () => {
          let body: unknown = xhr.responseText;
          try {
            body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
          } catch {
            /* not JSON */
          }
          resolve({ status: xhr.status, body });
        };
        xhr.onerror = () => reject(new ApiError(0, "Network error during upload"));
        xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
        signal?.addEventListener("abort", () => xhr.abort(), { once: true });
        xhr.send(form);
      });
      if (result.status === 401 && retry) {
        const ok = this.accessToken && this.accessToken !== used ? true : await this.refresh();
        if (ok) return run(false);
      }
      if (result.status < 200 || result.status >= 300) {
        const detail = result.body && typeof result.body === "object" && "detail" in result.body ? (result.body as { detail: unknown }).detail : result.body;
        throw new ApiError(result.status, detail);
      }
      return result.body as R;
    };
    return run(true);
  }
}

async function readDetail(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return res.statusText || null;
  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === "object" && "detail" in body) return (body as { detail: unknown }).detail;
    return body;
  } catch {
    return text;
  }
}

export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) return decodeURIComponent(star[1]);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1] : null;
}

// -- Singleton + endpoint helpers ----------------------------------------------------------

export const client = new ApiClient();

const enc = encodeURIComponent;

export const api = {
  auth: {
    signup: (body: T.SignupRequest) => client.request<{ tenant_id: string; user_id: string }>("/v1/auth/signup", { method: "POST", json: body, auth: false }),
    login: (body: T.LoginRequest) => client.request<T.TokenPair>("/v1/auth/login", { method: "POST", json: body, auth: false }),
    logout: (refresh_token: string) => client.request<void>("/v1/auth/logout", { method: "POST", json: { refresh_token }, auth: false }),
    me: () => client.get<T.Me>("/v1/auth/me"),
    mfaSetup: () => client.post<{ otpauth_uri: string }>("/v1/auth/mfa/setup"),
    mfaActivate: (code: string) => client.post<void>("/v1/auth/mfa/activate", { code }),
  },

  tenant: {
    get: () => client.get<T.Tenant>("/v1/tenant"),
    patch: (body: Partial<Pick<T.Tenant, "name" | "require_mfa" | "quotas">>) => client.patch<T.Tenant>("/v1/tenant", body),
    remove: (confirm: string) => client.del<Record<string, unknown>>("/v1/tenant", { confirm }),
    users: () => client.get<T.TenantUser[]>("/v1/tenant/users"),
    createUser: (body: { email: string; role: T.Role; password: string; name?: string }) => client.post<T.TenantUser>("/v1/tenant/users", body),
    patchUser: (id: string, body: { role?: T.Role; disabled?: boolean }) => client.patch<T.TenantUser>(`/v1/tenant/users/${enc(id)}`, body),
    apiKeys: () => client.get<T.ApiKey[]>("/v1/tenant/api-keys"),
    createApiKey: (body: T.ApiKeyCreate) => client.post<T.ApiKeyWithSecret>("/v1/tenant/api-keys", body),
    rotateApiKey: (id: string) => client.post<T.ApiKeyWithSecret>(`/v1/tenant/api-keys/${enc(id)}/rotate`),
    revokeApiKey: (id: string) => client.del(`/v1/tenant/api-keys/${enc(id)}`),
    llmConfig: () => client.get<T.LLMConfig>("/v1/tenant/llm-config"),
    putLlmConfig: (body: T.LLMConfig) => client.put<T.LLMConfig>("/v1/tenant/llm-config", body),
    secrets: () => client.get<{ names: string[] }>("/v1/tenant/secrets"),
    putSecret: (name: string, value: string) => client.put<void>(`/v1/tenant/secrets/${enc(name)}`, { value }),
    deleteSecret: (name: string) => client.del(`/v1/tenant/secrets/${enc(name)}`),
    llmUsage: () => client.get<T.LLMUsage>("/v1/tenant/llm-usage"),
    usage: (since?: string) => client.get<T.Usage>("/v1/tenant/usage", { since }),
    audit: (action?: string) => client.get<T.AuditEntry[]>("/v1/tenant/audit", { action }),
    verifyAudit: () => client.get<{ valid: boolean }>("/v1/tenant/audit/verify"),
    requestExport: () => client.post<T.Job>("/v1/tenant/exports"),
    downloadExport: (jobId: string) => client.download(`/v1/tenant/exports/${enc(jobId)}`),
  },

  schemas: {
    parse: (body: { format: T.SchemaFormat; content: string; current?: T.Schema }) => client.post<T.ParseResponse>("/v1/schemas/parse", body),
    validate: (schema: T.Schema) => client.post<{ valid: boolean; issues: T.SchemaIssue[] }>("/v1/schemas/validate", schema),
  },

  generate: {
    preview: (schema: T.Schema, options: T.GenerationOptions) => client.post<T.GeneratePreview>("/v1/generate/preview", { schema, options }),
    /** Returns a file, a DatasetRecord (save_as) or a 202 Job. */
    run: async (
      schema: T.Schema,
      options: T.GenerationOptions,
      format: T.ExportFormat,
      save_as?: string,
    ): Promise<{ kind: "file"; blob: Blob; filename: string } | { kind: "dataset"; dataset: T.DatasetRecord } | { kind: "job"; job: T.Job }> => {
      const res = await client.raw("/v1/generate", { method: "POST", json: { schema, options, format, save_as: save_as || undefined } });
      const type = res.headers.get("content-type") ?? "";
      if (res.status === 202) return { kind: "job", job: (await res.json()) as T.Job };
      if (save_as && type.includes("application/json")) return { kind: "dataset", dataset: (await res.json()) as T.DatasetRecord };
      return {
        kind: "file",
        blob: await res.blob(),
        filename: filenameFromDisposition(res.headers.get("content-disposition")) ?? `sample-data.${format}`,
      };
    },
  },

  datasets: {
    list: () => client.get<T.DatasetRecord[]>("/v1/datasets"),
    get: (id: string, version?: number) => client.get<T.DatasetRecord>(`/v1/datasets/${enc(id)}`, { version }),
    versions: (id: string) => client.get<T.DatasetRecord[]>(`/v1/datasets/${enc(id)}/versions`),
    remove: (id: string) => client.del(`/v1/datasets/${enc(id)}`),
    upload: (file: File, onProgress?: (p: UploadProgress) => void, signal?: AbortSignal) => {
      const form = new FormData();
      form.append("file", file, file.name);
      return client.upload<T.UploadResponse>("/v1/datasets", form, onProgress, signal);
    },
    putSchema: (id: string, schema: T.Schema) => client.put<T.DatasetRecord>(`/v1/datasets/${enc(id)}/schema`, schema),
    profile: (id: string, version?: number) => client.get<T.DatasetProfile>(`/v1/datasets/${enc(id)}/profile`, { version }),
    query: (id: string, sql: string, row_limit = 1000, version?: number) =>
      client.post<T.QueryResult>(`/v1/datasets/${enc(id)}/query`, { sql, row_limit }, { version }),
    suggestions: (id: string, question?: string) => client.post<T.Suggestion[]>(`/v1/datasets/${enc(id)}/suggestions`, { question: question || null }),
  },

  pipelines: {
    create: (body: { dataset_id: string; name: string; steps: T.PipelineStep[] }) => client.post<T.Pipeline>("/v1/pipelines", body),
    list: (dataset_id?: string) => client.get<T.Pipeline[]>("/v1/pipelines", { dataset_id }),
    templates: () => client.get<T.Pipeline[]>("/v1/pipelines/templates"),
    fromTemplate: (template_id: string, dataset_id: string, name?: string) =>
      client.post<T.Pipeline>("/v1/pipelines/from-template", { template_id, dataset_id, name }),
    get: (id: string) => client.get<T.Pipeline>(`/v1/pipelines/${enc(id)}`),
    addStep: (id: string, step: T.PipelineStep) => client.post<T.Pipeline>(`/v1/pipelines/${enc(id)}/steps`, { step }),
    undo: (id: string) => client.post<T.Pipeline>(`/v1/pipelines/${enc(id)}/undo`),
    redo: (id: string) => client.post<T.Pipeline>(`/v1/pipelines/${enc(id)}/redo`),
    preview: (id: string, step?: T.PipelineStep, rows = 50) => client.post<T.PipelinePreview>(`/v1/pipelines/${enc(id)}/preview`, { step, rows }),
    saveTemplate: (id: string, name: string) => client.post<T.Pipeline>(`/v1/pipelines/${enc(id)}/template`, { name }),
    apply: (id: string) => client.post<T.Job>(`/v1/pipelines/${enc(id)}/apply`),
  },

  jobs: {
    list: (status?: string) => client.get<T.Job[]>("/v1/jobs", { status }),
    get: (id: string) => client.get<T.Job>(`/v1/jobs/${enc(id)}`),
    cancel: (id: string) => client.post<T.Job>(`/v1/jobs/${enc(id)}/cancel`),
  },

  notifications: {
    list: (unread_only = false) => client.get<T.Notification[]>("/v1/notifications", { unread_only }),
    markRead: (id: string) => client.post<void>(`/v1/notifications/${enc(id)}/read`),
  },

  training: {
    algorithms: () => client.get<T.Algorithm[]>("/v1/algorithms"),
    detect: (dataset_id: string, target: string) => client.post<T.DetectResponse>("/v1/experiments/detect", { dataset_id, target }),
    create: (body: T.ExperimentCreate) => client.post<{ experiment: T.Experiment; job: T.Job }>("/v1/experiments", body),
    list: () => client.get<T.Experiment[]>("/v1/experiments"),
    get: (id: string) => client.get<T.ExperimentDetail>(`/v1/experiments/${enc(id)}`),
    run: (id: string) => client.get<T.Run>(`/v1/runs/${enc(id)}`),
    compare: (runIds: string[]) => client.get<T.CompareResponse>("/v1/experiments/compare", { run_ids: runIds.join(",") }),
    explain: (runId: string, instances: Record<string, unknown>[]) => client.post<T.ExplainResponse>(`/v1/runs/${enc(runId)}/explain`, { instances }),
  },

  models: {
    register: (body: { name: string; run_id: string; description?: string }) => client.post<T.ModelDetail | T.RegisteredModel>("/v1/models", body),
    list: () => client.get<T.RegisteredModel[]>("/v1/models"),
    get: (id: string) => client.get<T.ModelDetail>(`/v1/models/${enc(id)}`),
    setStage: (id: string, version: number, stage: T.Stage) => client.post<T.ModelVersion>(`/v1/models/${enc(id)}/versions/${version}/stage`, { stage }),
  },

  endpoints: {
    create: (body: T.EndpointCreate) => client.post<T.ServingEndpoint>("/v1/endpoints", body),
    list: () => client.get<T.ServingEndpoint[]>("/v1/endpoints"),
    get: (name: string) => client.get<T.ServingEndpoint>(`/v1/endpoints/${enc(name)}`),
    patch: (name: string, body: Partial<T.EndpointCreate>) => client.patch<T.ServingEndpoint>(`/v1/endpoints/${enc(name)}`, body),
    remove: (name: string) => client.del(`/v1/endpoints/${enc(name)}`),
    predict: (name: string, instances: Record<string, unknown>[], explain = false) =>
      client.post<T.PredictResponse>(`/v1/endpoints/${enc(name)}/predict`, { instances, explain }),
    batchFile: (name: string, file: File, onProgress?: (p: UploadProgress) => void) => {
      const form = new FormData();
      form.append("file", file, file.name);
      return client.upload<T.Job>(`/v1/endpoints/${enc(name)}/batch`, form, onProgress);
    },
    batchDataset: (name: string, dataset_id: string) => client.post<T.Job>(`/v1/endpoints/${enc(name)}/batch`, { dataset_id }),
    batchResult: (name: string, jobId: string) => client.download(`/v1/endpoints/${enc(name)}/batch/${enc(jobId)}`),
    openapi: (name: string) => client.get<Record<string, unknown>>(`/v1/endpoints/${enc(name)}/openapi.json`),
    openapiUrl: (name: string) => client.url(`/v1/endpoints/${enc(name)}/openapi.json`),
    metrics: (name: string) => client.get<T.EndpointMetrics>(`/v1/endpoints/${enc(name)}/metrics`),
  },

  analytics: {
    create: (body: T.AnalyticCreate) => client.post<T.Analytic>("/v1/analytics", body),
    list: () => client.get<T.Analytic[]>("/v1/analytics"),
    get: (id: string) => client.get<T.Analytic>(`/v1/analytics/${enc(id)}`),
    remove: (id: string) => client.del(`/v1/analytics/${enc(id)}`),
    run: (id: string, params: Record<string, unknown>) => client.post<T.TabularResult>(`/v1/analytics/${enc(id)}/run`, { params }),
  },

  dashboards: {
    create: (name: string, spec: T.DashboardSpec) => client.post<T.Dashboard>("/v1/dashboards", { name, spec }),
    list: (archived?: boolean) => client.get<T.Dashboard[]>("/v1/dashboards", { archived }),
    get: (id: string) => client.get<T.Dashboard>(`/v1/dashboards/${enc(id)}`),
    update: (id: string, body: { name?: string; spec?: T.DashboardSpec }) => client.put<T.Dashboard>(`/v1/dashboards/${enc(id)}`, body),
    remove: (id: string) => client.del(`/v1/dashboards/${enc(id)}`),
    clone: (id: string) => client.post<T.Dashboard>(`/v1/dashboards/${enc(id)}/clone`),
    archive: (id: string) => client.post<T.Dashboard>(`/v1/dashboards/${enc(id)}/archive`),
    share: (id: string, user_id: string, role: "editor" | "viewer") => client.post<unknown>(`/v1/dashboards/${enc(id)}/share`, { user_id, role }),
    widgetData: (id: string, widgetId: string, filters: Record<string, T.FilterValue>, signal?: AbortSignal) =>
      client.request<T.TabularResult>(`/v1/dashboards/${enc(id)}/widgets/${enc(widgetId)}/data`, { method: "POST", json: { filters }, signal }),
    export: (id: string, format: "html" | "json") => client.download(`/v1/dashboards/${enc(id)}/export`, { query: { format } }),
    templates: () => client.get<T.DashboardTemplate[]>("/v1/dashboards/templates"),
  },

  webhooks: {
    create: (url: string, events: string[]) => client.post<{ id: string; secret: string }>("/v1/webhooks", { url, events }),
    list: () => client.get<T.Webhook[]>("/v1/webhooks"),
    remove: (id: string) => client.del(`/v1/webhooks/${enc(id)}`),
    deliveries: (id: string) => client.get<T.WebhookDelivery[]>(`/v1/webhooks/${enc(id)}/deliveries`),
    retry: (deliveryId: string) => client.post<unknown>(`/v1/webhooks/deliveries/${enc(deliveryId)}/retry`),
  },
};

export type Api = typeof api;
