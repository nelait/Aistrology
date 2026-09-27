/**
 * Transport: authentication, token refresh, timeouts, retries with backoff, and error mapping.
 */

import {
  AnalyticsPlatformError,
  AuthenticationError,
  NetworkError,
  TimeoutError,
  createApiError,
  parseRetryAfter,
} from "./errors.js";
import { parseSSE, type ServerSentEvent } from "./sse.js";
import type { ClientCredentialsToken, TokenPair } from "./types.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Tokens {
  accessToken?: string | undefined;
  refreshToken?: string | undefined;
}

export interface ClientOptions {
  /** API origin, e.g. `https://analytics.example.com`. A trailing slash is ignored. */
  baseUrl: string;
  /** An API key (`ap_live_…`), sent as `X-API-Key`. Takes precedence over user tokens. */
  apiKey?: string;
  /** A user access token (from `auth.login`). */
  accessToken?: string;
  /** A user refresh token; enables automatic refresh on 401. */
  refreshToken?: string;
  /** Called after login and after every refresh with the new pair, so callers can persist it. */
  onTokens?: (tokens: TokenPair) => void | Promise<void>;
  /**
   * OAuth 2.0 client credentials (MGT-004a): the client fetches access tokens from `POST /oauth/token`
   * itself, renews them shortly before they expire and once more on a 401. Ignored when `apiKey` is set.
   */
  clientId?: string;
  clientSecret?: string;
  /** Optional scopes to request (narrowing the OAuth client's role). */
  scope?: string | string[];
  /** Custom fetch implementation (defaults to the global `fetch`). */
  fetch?: FetchLike;
  /** Per-attempt timeout in milliseconds (default 60 000). `0` disables it. */
  timeoutMs?: number;
  /** Retries after the first attempt for retryable failures (default 2). */
  maxRetries?: number;
  /** Base delay for exponential backoff (default 500 ms). */
  retryBaseDelayMs?: number;
  /** Upper bound for a single backoff or `Retry-After` wait (default 30 000 ms). */
  maxRetryDelayMs?: number;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
}

/** Options accepted by every resource method. */
export interface CallOptions {
  signal?: AbortSignal;
  /** Overrides the client's timeout for this call. */
  timeoutMs?: number;
  /** Overrides the client's retry count for this call. */
  maxRetries?: number;
  headers?: Record<string, string>;
}

export type ResponseType = "json" | "text" | "blob" | "arrayBuffer" | "response";

export interface RequestSpec extends CallOptions {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | null | undefined> | undefined;
  /** JSON body. */
  body?: unknown;
  /** Pre-encoded body (FormData, Blob, ...); sent as-is. Must be re-sendable for retries. */
  rawBody?: BodyInit;
  responseType?: ResponseType;
  /** Send credentials (default true). */
  auth?: boolean;
  /**
   * Whether the request can be repeated safely, so 5xx responses and timeouts are retried. Defaults to
   * true for GET/PUT/DELETE and false otherwise (then only 429/503 are retried).
   */
  idempotent?: boolean;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
/** A POST/PATCH may already have taken effect, so only retry when the server says it did not. */
const RETRYABLE_UNSAFE_STATUS = new Set([429, 503]);
const IDEMPOTENT = new Set<HttpMethod>(["GET", "PUT", "DELETE"]);
/** Renew client-credentials tokens this long before they expire. */
const TOKEN_RENEWAL_MARGIN_MS = 30_000;

export class HttpClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private accessToken: string | undefined;
  private refreshToken: string | undefined;
  private readonly onTokens: ClientOptions["onTokens"];
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly defaultHeaders: Record<string, string>;
  private refreshing: Promise<TokenPair> | null = null;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly scope: string | undefined;
  private tokenExpiresAt = 0;
  private fetchingToken: Promise<ClientCredentialsToken> | null = null;

  constructor(options: ClientOptions) {
    if (!options || !options.baseUrl) throw new AnalyticsPlatformError("baseUrl is required");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    this.onTokens = options.onTokens;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.scope = Array.isArray(options.scope) ? options.scope.join(" ") : options.scope;
    const f = options.fetch ?? (typeof fetch === "function" ? fetch : undefined);
    if (!f) throw new AnalyticsPlatformError("no fetch implementation available; pass options.fetch");
    // Never call fetch as a method of this object (browsers throw "Illegal invocation").
    this.fetchImpl = (input, init) => f(input, init);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.defaultHeaders = { ...(options.headers ?? {}) };
  }

  // -- tokens --------------------------------------------------------------------------------

  getTokens(): Tokens {
    return { accessToken: this.accessToken, refreshToken: this.refreshToken };
  }

  setTokens(tokens: Tokens): void {
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
  }

  /** Store a freshly issued pair and notify `onTokens`. */
  async acceptTokens(pair: TokenPair): Promise<void> {
    this.accessToken = pair.access_token;
    this.refreshToken = pair.refresh_token;
    if (this.onTokens) await this.onTokens(pair);
  }

  /**
   * Exchange the refresh token for a new pair. Concurrent callers share one in-flight request,
   * because refresh tokens are single-use: a second request with the same token would fail.
   */
  refresh(): Promise<TokenPair> {
    if (this.refreshing) return this.refreshing;
    const refreshToken = this.refreshToken;
    if (!refreshToken) return Promise.reject(new AnalyticsPlatformError("no refresh token available"));
    const run = async (): Promise<TokenPair> => {
      try {
        const pair = await this.request<TokenPair>({
          method: "POST",
          path: "/v1/auth/refresh",
          body: { refresh_token: refreshToken },
          auth: false,
        });
        await this.acceptTokens(pair);
        return pair;
      } catch (err) {
        // The refresh token was rejected (expired, reused or revoked): drop the session.
        if (err instanceof AuthenticationError && this.refreshToken === refreshToken) {
          this.accessToken = undefined;
          this.refreshToken = undefined;
        }
        throw err;
      }
    };
    const p = run().finally(() => {
      if (this.refreshing === p) this.refreshing = null;
    });
    this.refreshing = p;
    return p;
  }

  /** True when the client authenticates with OAuth client credentials. */
  get usesClientCredentials(): boolean {
    return !this.apiKey && !!this.clientId && !!this.clientSecret;
  }

  /** Fetch a client-credentials token now (normally automatic). Concurrent callers share one request. */
  clientCredentialsToken(): Promise<ClientCredentialsToken> {
    if (this.fetchingToken) return this.fetchingToken;
    if (!this.clientId || !this.clientSecret) {
      return Promise.reject(new AnalyticsPlatformError("clientId and clientSecret are required for the client credentials grant"));
    }
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: this.clientId, client_secret: this.clientSecret });
    if (this.scope) form.set("scope", this.scope);
    const run = async (): Promise<ClientCredentialsToken> => {
      try {
        const token = await this.request<ClientCredentialsToken>({
          method: "POST",
          path: "/oauth/token",
          rawBody: form.toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          auth: false,
          // Issuing a token has no side effects.
          idempotent: true,
        });
        this.accessToken = token.access_token;
        this.tokenExpiresAt = Date.now() + (token.expires_in ?? 900) * 1000;
        return token;
      } catch (err) {
        this.accessToken = undefined;
        this.tokenExpiresAt = 0;
        throw err;
      }
    };
    const p = run().finally(() => {
      if (this.fetchingToken === p) this.fetchingToken = null;
    });
    this.fetchingToken = p;
    return p;
  }

  private usesUserTokens(spec: RequestSpec): boolean {
    return spec.auth !== false && !this.apiKey && !this.usesClientCredentials;
  }

  private authHeaders(spec: RequestSpec): { headers: Record<string, string>; token: string | undefined } {
    if (spec.auth === false) return { headers: {}, token: undefined };
    if (this.apiKey) return { headers: { "X-API-Key": this.apiKey }, token: undefined };
    if (this.accessToken) return { headers: { Authorization: `Bearer ${this.accessToken}` }, token: this.accessToken };
    return { headers: {}, token: undefined };
  }

  // -- requests ------------------------------------------------------------------------------

  url(path: string, query?: RequestSpec["query"]): string {
    let url = this.baseUrl + (path.startsWith("/") ? path : `/${path}`);
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) params.append(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    }
    return url;
  }

  async request<T>(spec: RequestSpec): Promise<T> {
    const response = await this.send(spec);
    return (await this.parse(response, spec.responseType ?? "json")) as T;
  }

  /** Run the request with auth, refresh, timeouts and retries; resolve with the successful Response. */
  async send(spec: RequestSpec): Promise<Response> {
    const maxRetries = Math.max(0, spec.maxRetries ?? this.maxRetries);
    const timeoutMs = spec.timeoutMs ?? this.timeoutMs;
    const url = this.url(spec.path, spec.query);
    let refreshed = false;
    let attempt = 0;

    const idempotent = spec.idempotent ?? IDEMPOTENT.has(spec.method);
    const clientCredentials = spec.auth !== false && this.usesClientCredentials;

    // A session that only has a refresh token (e.g. restored from storage) refreshes first.
    if (this.usesUserTokens(spec) && !this.accessToken && this.refreshToken) {
      await this.refresh();
      refreshed = true;
    }

    for (;;) {
      throwIfAborted(spec.signal);
      if (clientCredentials && (!this.accessToken || Date.now() >= this.tokenExpiresAt - TOKEN_RENEWAL_MARGIN_MS)) {
        await this.clientCredentialsToken();
      }
      const { headers: authHeaders, token: sentToken } = this.authHeaders(spec);
      const headers: Record<string, string> = { Accept: "application/json", ...this.defaultHeaders, ...authHeaders, ...(spec.headers ?? {}) };
      let body: BodyInit | undefined;
      if (spec.rawBody !== undefined) {
        body = spec.rawBody;
      } else if (spec.body !== undefined) {
        body = JSON.stringify(spec.body);
        headers["Content-Type"] = "application/json";
      }

      let response: Response;
      try {
        response = await this.fetchWithTimeout(url, { method: spec.method, headers, body }, timeoutMs, spec.signal);
      } catch (err) {
        if (isAbort(err, spec.signal)) throw err;
        // Timeouts are ambiguous for unsafe methods (the server may have acted); a failure with no
        // response at all (connection refused/reset) is retried for every method.
        const retryable = err instanceof TimeoutError ? idempotent : true;
        if (retryable && attempt < maxRetries) {
          await sleep(this.backoff(attempt), spec.signal);
          attempt++;
          continue;
        }
        if (err instanceof AnalyticsPlatformError) throw err;
        throw new NetworkError(`${spec.method} ${url} failed: ${errorMessage(err)}`, { cause: err });
      }

      if (response.ok) return response;

      // 401 with client credentials: the token may have been revoked or the key rotated; fetch a new one once.
      if (response.status === 401 && clientCredentials && !refreshed) {
        refreshed = true;
        await discard(response);
        if (this.accessToken === sentToken) this.accessToken = undefined;
        continue;
      }

      // 401 with user tokens: refresh once, then replay the request.
      if (response.status === 401 && this.usesUserTokens(spec) && !refreshed && (this.refreshToken || this.accessToken !== sentToken)) {
        refreshed = true;
        await discard(response);
        // Another request may already have refreshed while this one was in flight.
        if (this.accessToken === sentToken) await this.refresh();
        continue;
      }

      const retryable = idempotent
        ? RETRYABLE_STATUS.has(response.status)
        : RETRYABLE_UNSAFE_STATUS.has(response.status);
      if (retryable && attempt < maxRetries) {
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        await discard(response);
        await sleep(retryAfter !== undefined ? Math.min(retryAfter, this.maxRetryDelayMs) : this.backoff(attempt), spec.signal);
        attempt++;
        continue;
      }

      throw await this.toError(response, spec.method, url);
    }
  }

  /**
   * Send the request and iterate over its `text/event-stream` body. Auth, refresh and retries apply until
   * the response starts; aborting `spec.signal` cancels the stream.
   */
  async *events(spec: RequestSpec): AsyncGenerator<ServerSentEvent, void, undefined> {
    const response = await this.send({ ...spec, headers: { Accept: "text/event-stream", ...(spec.headers ?? {}) } });
    if (!response.body) return;
    yield* parseSSE(response.body, spec.signal);
  }

  /** Exponential backoff with jitter: a random delay in [d/2, d], d = base * 2^attempt, capped. */
  private backoff(attempt: number): number {
    const d = Math.min(this.maxRetryDelayMs, this.retryBaseDelayMs * 2 ** attempt);
    return Math.round(d / 2 + Math.random() * (d / 2));
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    if (!timeoutMs && !signal) return this.fetchImpl(url, init);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort(new TimeoutError(timeoutMs));
          }, timeoutMs)
        : undefined;
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (timedOut) throw new TimeoutError(timeoutMs);
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async parse(response: Response, type: ResponseType): Promise<unknown> {
    switch (type) {
      case "response":
        return response;
      case "blob":
        return response.blob();
      case "arrayBuffer":
        return response.arrayBuffer();
      case "text":
        return response.text();
      default: {
        if (response.status === 204) return undefined;
        const text = await response.text();
        if (!text) return undefined;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
    }
  }

  private async toError(response: Response, method: string, url: string) {
    let body: unknown;
    try {
      const text = await response.text();
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
    } catch {
      body = undefined;
    }
    let detail = body && typeof body === "object" && !Array.isArray(body) && "detail" in body ? (body as { detail: unknown }).detail : body;
    // RFC 6749 errors from /oauth/token: {error, error_description}.
    if (detail && typeof detail === "object" && !Array.isArray(detail) && typeof (detail as { error?: unknown }).error === "string") {
      const oauth = detail as { error: string; error_description?: string };
      detail = { code: oauth.error, message: oauth.error_description ?? oauth.error };
    }
    return createApiError({ status: response.status, detail: detail ?? response.statusText, body, headers: response.headers, method, url });
  }
}

// -- helpers ---------------------------------------------------------------------------------

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted && !(err instanceof TimeoutError);
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* ignore */
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
