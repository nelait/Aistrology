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
import { toApiSpec } from "./dashboard";

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
    oidcProviders: () => client.request<{ providers: string[] }>("/v1/auth/oidc/providers", { auth: false }),
    oidcAuthorize: (provider: string, redirect_uri: string) =>
      client.request<{ authorization_url: string; state: string }>(`/v1/auth/oidc/${enc(provider)}/authorize`, { auth: false, query: { redirect_uri } }),
    oidcCallback: (provider: string, code: string, state: string) =>
      client.request<T.TokenPair>(`/v1/auth/oidc/${enc(provider)}/callback`, { method: "POST", json: { code, state }, auth: false }),
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
    sso: () => client.get<T.SSOSettings>("/v1/tenant/sso"),
    putSso: (body: T.SSOSettings) => client.put<T.SSOSettings>("/v1/tenant/sso", body),
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
    // SCH-010 schema history
    save: (body: { name: string; schema: T.Schema; project_id?: string; message?: string; source_format?: string }) => client.post<T.SaveSchemaResponse>("/v1/schemas", body),
    list: (project_id?: string) => client.get<T.SavedSchema[]>("/v1/schemas", { project_id }),
    get: (id: string) => client.get<T.SavedSchema>(`/v1/schemas/${enc(id)}`),
    version: (id: string, version: number) => client.get<T.SchemaVersion>(`/v1/schemas/${enc(id)}/versions/${version}`),
    diff: (id: string, from_version?: number, to_version?: number) => client.get<T.SchemaDiff>(`/v1/schemas/${enc(id)}/diff`, { from_version, to_version }),
    diffSchemas: (a: T.Schema, b: T.Schema) => client.post<T.SchemaDiff>("/v1/schemas/diff", { a, b }),
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

  projects: {
    list: () => client.get<T.Project[]>("/v1/projects"),
    create: (body: { name: string; open: boolean; members: string[] }) => client.post<T.Project>("/v1/projects", body),
    addMember: (id: string, user_id: string) => client.post<void>(`/v1/projects/${enc(id)}/members`, { user_id }),
    removeMember: (id: string, userId: string) => client.del(`/v1/projects/${enc(id)}/members/${enc(userId)}`),
  },

  datasets: {
    list: (project_id?: string) => client.get<T.DatasetRecord[]>("/v1/datasets", { project_id }),
    get: (id: string, version?: number) => client.get<T.DatasetRecord>(`/v1/datasets/${enc(id)}`, { version }),
    versions: (id: string) => client.get<T.DatasetRecord[]>(`/v1/datasets/${enc(id)}/versions`),
    remove: (id: string) => client.del(`/v1/datasets/${enc(id)}`),
    upload: (file: File, onProgress?: (p: UploadProgress) => void, signal?: AbortSignal, project_id?: string) => {
      const form = new FormData();
      form.append("file", file, file.name);
      return client.upload<T.UploadResponse>("/v1/datasets", form, onProgress, signal, { project_id });
    },
    putSchema: (id: string, schema: T.Schema) => client.put<T.DatasetRecord>(`/v1/datasets/${enc(id)}/schema`, schema),
    profile: (id: string, version?: number) => client.get<T.DatasetProfile>(`/v1/datasets/${enc(id)}/profile`, { version }),
    query: (id: string, sql: string, row_limit = 1000, version?: number) =>
      client.post<T.QueryResult>(`/v1/datasets/${enc(id)}/query`, { sql, row_limit }, { version }),
    suggestions: (id: string, question?: string) => client.post<T.Suggestion[]>(`/v1/datasets/${enc(id)}/suggestions`, { question: question || null }),
    /** INF-007/008: upload the next version (append or replace) and get the column diff. */
    uploadVersion: (id: string, file: File, mode: "append" | "replace", onProgress?: (p: UploadProgress) => void, signal?: AbortSignal) => {
      const form = new FormData();
      form.append("file", file, file.name);
      return client.upload<T.EvolutionResponse>(`/v1/datasets/${enc(id)}/versions`, form, onProgress, signal, { mode });
    },
    annotations: (id: string, version?: number) => client.get<T.AnnotationsOut>(`/v1/datasets/${enc(id)}/annotations`, { version }),
    putAnnotations: (id: string, body: { columns: Record<string, T.ColumnAnnotation[]>; entity?: string; version?: number; replace?: boolean }) =>
      client.put<T.AnnotationsOut>(`/v1/datasets/${enc(id)}/annotations`, body),
    advancedProfile: (id: string, body: T.AdvancedProfileRequest, opts: { version?: number; table?: string } = {}) =>
      client.post<T.AdvancedProfile>(`/v1/datasets/${enc(id)}/profile/advanced`, body, { version: opts.version, table: opts.table }),
  },

  connectors: {
    list: () => client.get<T.Connector[]>("/v1/connectors"),
    get: (id: string) => client.get<T.Connector>(`/v1/connectors/${enc(id)}`),
    create: (body: T.ConnectorCreate) => client.post<T.Connector>("/v1/connectors", body),
    remove: (id: string) => client.del(`/v1/connectors/${enc(id)}`),
    import: (id: string, body: T.ConnectorImport) => client.post<T.Job>(`/v1/connectors/${enc(id)}/import`, body),
    allowlist: () => client.get<{ hosts: string[] }>("/v1/connectors/allowlist"),
    putAllowlist: (hosts: string[]) => client.put<{ hosts: string[] }>("/v1/connectors/allowlist", { hosts }),
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
    preferences: () => client.get<{ email: string[] }>("/v1/notifications/preferences"),
    putPreferences: (email: string[]) => client.put<{ email: string[] }>("/v1/notifications/preferences", { email }),
  },

  llmAdmin: {
    health: () => client.get<T.LLMHealth>("/v1/tenant/llm-health"),
    putBreaker: (body: T.BreakerConfig) => client.put<T.BreakerConfig>("/v1/tenant/llm-health/breaker", body),
    prompts: () => client.get<T.PromptTemplate[]>("/v1/prompts"),
    prompt: (id: string) => client.get<T.PromptTemplate>(`/v1/prompts/${enc(id)}`),
    createPromptVersion: (id: string, body: { system: string; provider?: string; description?: string }) =>
      client.post<T.PromptVersion>(`/v1/prompts/${enc(id)}/versions`, body),
    setPromptActive: (id: string, version: number, active: boolean) =>
      client.post<void>(`/v1/prompts/${enc(id)}/versions/${version}/${active ? "activate" : "deactivate"}`),
  },

  access: {
    chatDestinations: () => client.get<T.ChatDestination[]>("/v1/tenant/chat-destinations"),
    createChatDestination: (body: { kind: "slack" | "teams"; name: string; url: string; events: string[] }) => client.post<T.ChatDestination>("/v1/tenant/chat-destinations", body),
    deleteChatDestination: (id: string) => client.del(`/v1/tenant/chat-destinations/${enc(id)}`),
    oauthClients: () => client.get<T.OAuthClient[]>("/v1/tenant/oauth-clients"),
    createOAuthClient: (body: { name: string; role: T.Role; scopes: T.PermissionName[] }) => client.post<T.OAuthClientWithSecret>("/v1/tenant/oauth-clients", body),
    revokeOAuthClient: (id: string) => client.del(`/v1/tenant/oauth-clients/${enc(id)}`),
    networkPolicy: () => client.get<T.NetworkPolicy>("/v1/tenant/network-policy"),
    putNetworkPolicy: (body: T.NetworkPolicy) => client.put<T.NetworkPolicy>("/v1/tenant/network-policy", body),
    scimToken: () => client.get<T.ScimTokenStatus>("/v1/tenant/scim-token"),
    createScimToken: () => client.post<{ token: string; base_url: string }>("/v1/tenant/scim-token"),
    revokeScimToken: () => client.del("/v1/tenant/scim-token"),
    teams: () => client.get<T.Team[]>("/v1/teams"),
    createTeam: (body: { name: string; description?: string; members: string[] }) => client.post<T.Team>("/v1/teams", body),
    deleteTeam: (id: string) => client.del(`/v1/teams/${enc(id)}`),
    addTeamMember: (id: string, user_id: string) => client.post<void>(`/v1/teams/${enc(id)}/members`, { user_id }),
    removeTeamMember: (id: string, userId: string) => client.del(`/v1/teams/${enc(id)}/members/${enc(userId)}`),
    grantProject: (projectId: string, team_id: string) => client.post<void>(`/v1/projects/${enc(projectId)}/teams`, { team_id }),
    revokeProject: (projectId: string, teamId: string) => client.del(`/v1/projects/${enc(projectId)}/teams/${enc(teamId)}`),
    sharing: () => client.get<{ public_links_enabled: boolean }>("/v1/tenant/sharing"),
    putSharing: (public_links_enabled: boolean) => client.put<{ public_links_enabled: boolean }>("/v1/tenant/sharing", { public_links_enabled }),
  },

  governance: {
    consents: () => client.get<T.ConsentRecord[]>("/v1/consents"),
    giveConsent: (policy: T.ConsentPolicy, version: string) => client.post<T.ConsentRecord>("/v1/consents", { policy, version }),
    withdrawConsent: (policy: T.ConsentPolicy) => client.del(`/v1/consents/${enc(policy)}`),
    tenantConsents: (policy?: T.ConsentPolicy) => client.get<T.ConsentRecord[]>("/v1/tenant/consents", { policy }),
    consentSettings: () => client.get<T.ConsentSettings>("/v1/tenant/consent-settings"),
    putConsentSettings: (body: { llm_requires_consent: boolean; llm_addendum_version: string }) => client.put<T.ConsentSettings>("/v1/tenant/consent-settings", body),
    costs: (start?: string, end?: string) => client.get<T.CostReport>("/v1/tenant/costs", { start, end }),
  },

  inboundHooks: {
    list: () => client.get<T.InboundHook[]>("/v1/inbound-hooks"),
    create: (body: T.InboundHookCreate) => client.post<T.InboundHookWithSecret>("/v1/inbound-hooks", body),
    remove: (id: string) => client.del(`/v1/inbound-hooks/${enc(id)}`),
  },

  training: {
    algorithms: () => client.get<T.Algorithm[]>("/v1/algorithms"),
    detect: (dataset_id: string, target?: string) => client.post<T.DetectResponse>("/v1/experiments/detect", { dataset_id, target: target || undefined }),
    create: (body: T.ExperimentCreate) => client.post<{ experiment: T.Experiment; job: T.Job }>("/v1/experiments", body),
    list: () => client.get<T.Experiment[]>("/v1/experiments"),
    get: (id: string) => client.get<T.ExperimentDetail>(`/v1/experiments/${enc(id)}`),
    run: (id: string) => client.get<T.Run>(`/v1/runs/${enc(id)}`),
    compare: (runIds: string[]) => client.get<T.CompareResponse>("/v1/experiments/compare", { run_ids: runIds.join(",") }),
    explain: (runId: string, instances: Record<string, unknown>[]) => client.post<T.ExplainResponse>(`/v1/runs/${enc(runId)}/explain`, { instances }),
    /** XAI-005: plain-English explanation from aggregate explanations (LLM). */
    explanationText: (runId: string) => client.post<{ text: string }>(`/v1/runs/${enc(runId)}/explanation-text`),
    /** MDL-NFR-004: 409 {code: "onnx_unsupported", message} when the pipeline can't be converted. */
    onnx: (runId: string) => client.download(`/v1/runs/${enc(runId)}/onnx`),
    templates: () => client.get<T.TrainingTemplate[]>("/v1/training-templates"),
    createTemplate: (body: { name: string; description?: string; config: T.TrainingConfig }) => client.post<T.TrainingTemplate>("/v1/training-templates", body),
    deleteTemplate: (id: string) => client.del(`/v1/training-templates/${enc(id)}`),
    applyTemplate: (id: string, body: { name: string; dataset_id: string; dataset_version?: number; overrides: T.TrainingConfig }) =>
      client.post<{ experiment: T.Experiment; job: T.Job; template_id: string }>(`/v1/training-templates/${enc(id)}/apply`, body),
  },

  models: {
    register: (body: { name: string; run_id: string; description?: string }) => client.post<T.RegisterResponse>("/v1/models", body),
    list: () => client.get<T.RegisteredModel[]>("/v1/models"),
    get: (id: string) => client.get<T.ModelDetail>(`/v1/models/${enc(id)}`),
    setStage: (id: string, version: number, stage: T.Stage) => client.post<T.ModelDetail>(`/v1/models/${enc(id)}/versions/${version}/stage`, { stage }),
  },

  endpoints: {
    create: (body: T.EndpointCreate) => client.post<T.ServingEndpoint>("/v1/endpoints", body),
    list: () => client.get<T.ServingEndpoint[]>("/v1/endpoints"),
    get: (name: string) => client.get<T.ServingEndpoint>(`/v1/endpoints/${enc(name)}`),
    patch: (name: string, body: T.EndpointPatch) => client.patch<T.ServingEndpoint>(`/v1/endpoints/${enc(name)}`, body),
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
    metrics: (name: string, hours = 24) => client.get<T.EndpointMetrics>(`/v1/endpoints/${enc(name)}/metrics`, { hours }),
    /** Forecasting endpoints: `instances` is not needed. */
    forecast: (name: string, body: { horizon?: number; history?: Record<string, unknown>[] }) => client.post<T.ForecastResponse>(`/v1/endpoints/${enc(name)}/predict`, body),
    drift: (name: string, hours = 24) => client.get<T.DriftReport>(`/v1/endpoints/${enc(name)}/drift`, { hours }),
    driftCheck: (name: string, hours = 24) => client.post<T.Job>(`/v1/endpoints/${enc(name)}/drift/check`, { hours }),
  },

  analytics: {
    create: (body: T.AnalyticCreate) => client.post<T.Analytic>("/v1/analytics", body),
    list: () => client.get<T.Analytic[]>("/v1/analytics"),
    get: (id: string) => client.get<T.Analytic>(`/v1/analytics/${enc(id)}`),
    remove: (id: string) => client.del(`/v1/analytics/${enc(id)}`),
    run: (id: string, params: Record<string, unknown>, filters: Record<string, T.FilterValue> = {}) =>
      client.post<T.TabularResult>(`/v1/analytics/${enc(id)}/run`, { params, filters }),
  },

  dashboards: {
    create: (name: string, spec: T.DashboardSpec) => client.post<T.Dashboard>("/v1/dashboards", { name, spec: toApiSpec(spec) }),
    list: (archived?: boolean) => client.get<T.Dashboard[]>("/v1/dashboards", { archived }),
    get: (id: string) => client.get<T.Dashboard>(`/v1/dashboards/${enc(id)}`),
    update: (id: string, body: { name?: string; spec?: T.DashboardSpec }) =>
      client.put<T.Dashboard>(`/v1/dashboards/${enc(id)}`, { ...body, spec: body.spec ? toApiSpec(body.spec) : undefined }),
    remove: (id: string) => client.del(`/v1/dashboards/${enc(id)}`),
    fromTemplate: (template: string, name: string, values: Record<string, string>) => client.post<T.Dashboard>("/v1/dashboards/from-template", { template, name, values }),
    clone: (id: string) => client.post<T.Dashboard>(`/v1/dashboards/${enc(id)}/clone`),
    archive: (id: string, archived = true) => client.post<T.Dashboard>(`/v1/dashboards/${enc(id)}/archive`, undefined, { archived }),
    /** user_id "*" shares with everyone in the organization */
    share: (id: string, user_id: string, role: "editor" | "viewer") => client.post<T.Dashboard>(`/v1/dashboards/${enc(id)}/share`, { user_id, role }),
    widgetData: (id: string, widgetId: string, filters: Record<string, T.FilterValue>, signal?: AbortSignal) =>
      client.request<T.TabularResult>(`/v1/dashboards/${enc(id)}/widgets/${enc(widgetId)}/data`, { method: "POST", json: { filters }, signal }),
    /** DSH-009a interactive HTML snapshot (rendered server-side with the given filters). */
    exportHtml: (id: string, filters: Record<string, T.FilterValue> = {}) => client.download(`/v1/dashboards/${enc(id)}/export`, { method: "POST", json: { filters } }),
    embedToken: (id: string, ttl_minutes = 60) => client.post<{ token: string; expires_in_minutes: number; embed_path: string }>(`/v1/dashboards/${enc(id)}/embed-token`, { ttl_minutes }),
    templates: () => client.get<T.DashboardTemplate[]>("/v1/dashboards/templates"),
    publicLinks: (id: string) => client.get<T.PublicLink[]>(`/v1/dashboards/${enc(id)}/public-links`),
    createPublicLink: (id: string, ttl_hours: number) => client.post<T.PublicLinkWithToken>(`/v1/dashboards/${enc(id)}/public-links`, { ttl_hours }),
    revokePublicLink: (id: string, linkId: string) => client.del(`/v1/dashboards/${enc(id)}/public-links/${enc(linkId)}`),
    /** Anonymous (no credentials) view of a public link. */
    publicView: (token: string) => client.request<T.Dashboard>(`/v1/public/${enc(token)}`, { auth: false }),
    publicWidgetData: (token: string, widgetId: string, filters: Record<string, T.FilterValue>, signal?: AbortSignal) =>
      client.request<T.TabularResult>(`/v1/public/${enc(token)}/widgets/${enc(widgetId)}/data`, { method: "POST", json: { filters }, auth: false, signal }),
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
