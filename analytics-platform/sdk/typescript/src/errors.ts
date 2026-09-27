/**
 * Error hierarchy.
 *
 * AnalyticsPlatformError          every error the SDK throws
 * ├── ApiError                    the server answered with a non-2xx status
 * │   ├── AuthenticationError     401
 * │   ├── ForbiddenError          403
 * │   ├── NotFoundError           404
 * │   ├── ConflictError           409
 * │   ├── ValidationError         422
 * │   ├── RateLimitError          429
 * │   └── ServerError             5xx
 * ├── TimeoutError                the client-side timeout elapsed
 * ├── NetworkError                no response (DNS, connection reset, CORS, ...)
 * └── JobFailedError              jobs.wait() saw a job end as failed or cancelled
 */

import type { Job } from "./types.js";

export class AnalyticsPlatformError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface ApiErrorInit {
  status: number;
  detail: unknown;
  body?: unknown;
  headers?: Headers;
  method?: string;
  url?: string;
}

/** A non-2xx response. `detail` is the FastAPI `detail` field (string, object or validation-issue list). */
export class ApiError extends AnalyticsPlatformError {
  readonly status: number;
  /** Machine-readable code from `detail.code` when the server sends one (e.g. `mfa_required`). */
  readonly code: string | undefined;
  readonly detail: unknown;
  /** The whole parsed response body. */
  readonly body: unknown;
  readonly headers: Headers | undefined;
  readonly method: string | undefined;
  readonly url: string | undefined;

  constructor(init: ApiErrorInit) {
    super(`${init.status}: ${describeDetail(init.detail)}`);
    this.status = init.status;
    this.detail = init.detail;
    this.body = init.body;
    this.headers = init.headers;
    this.method = init.method;
    this.url = init.url;
    this.code = extractCode(init.detail);
  }
}

/** 401: missing, invalid or expired credentials. `code` is e.g. `invalid_credentials`, `mfa_required`, `locked`. */
export class AuthenticationError extends ApiError {}
/** 403: the caller lacks the permission for this operation. */
export class ForbiddenError extends ApiError {}
/** 404 */
export class NotFoundError extends ApiError {}
/** 409: the resource is in the wrong state (e.g. job not finished, schema not confirmed). */
export class ConflictError extends ApiError {}

export interface ValidationIssue {
  loc?: (string | number)[];
  msg?: string;
  type?: string;
  path?: string;
  message?: string;
  severity?: string;
  [key: string]: unknown;
}

/** 422: the request body or parameters were rejected. */
export class ValidationError extends ApiError {
  /** Individual issues when the server returned a list (pydantic errors or schema issues). */
  get issues(): ValidationIssue[] {
    const d = this.detail;
    if (Array.isArray(d)) return d as ValidationIssue[];
    if (d && typeof d === "object" && Array.isArray((d as { issues?: unknown }).issues)) {
      return (d as { issues: ValidationIssue[] }).issues;
    }
    return [];
  }
}

/** 429: rate limit exceeded. `retryAfterMs` comes from the `Retry-After` header. */
export class RateLimitError extends ApiError {
  readonly retryAfterMs: number | undefined;
  constructor(init: ApiErrorInit) {
    super(init);
    this.retryAfterMs = parseRetryAfter(init.headers?.get("retry-after") ?? null);
  }
}

/** 5xx */
export class ServerError extends ApiError {}

/** The request did not complete within `timeoutMs`. */
export class TimeoutError extends AnalyticsPlatformError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, message?: string) {
    super(message ?? `request timed out after ${timeoutMs} ms`);
    this.timeoutMs = timeoutMs;
  }
}

/** No HTTP response was received (connection refused/reset, DNS, CORS, offline). */
export class NetworkError extends AnalyticsPlatformError {}

/** Raised by `jobs.wait()` when a job ends as `failed` or `cancelled`. */
export class JobFailedError extends AnalyticsPlatformError {
  readonly job: Job;
  constructor(job: Job) {
    super(`job ${job.id} ${job.status}${job.error ? `: ${job.error}` : ""}`);
    this.job = job;
  }
}

/** Build the right `ApiError` subclass for a status code. */
export function createApiError(init: ApiErrorInit): ApiError {
  const { status } = init;
  if (status === 401) return new AuthenticationError(init);
  if (status === 403) return new ForbiddenError(init);
  if (status === 404) return new NotFoundError(init);
  if (status === 409) return new ConflictError(init);
  if (status === 422) return new ValidationError(init);
  if (status === 429) return new RateLimitError(init);
  if (status >= 500) return new ServerError(init);
  return new ApiError(init);
}

function extractCode(detail: unknown): string | undefined {
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const code = (detail as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function describeDetail(detail: unknown): string {
  if (detail == null) return "request failed";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return (
      detail
        .map((d) => {
          if (d && typeof d === "object") {
            const o = d as ValidationIssue;
            const where = o.loc ? o.loc.join(".") : o.path;
            const msg = o.msg ?? o.message ?? JSON.stringify(o);
            return where ? `${where}: ${msg}` : msg;
          }
          return String(d);
        })
        .join("; ") || "validation failed"
    );
  }
  if (typeof detail === "object") {
    const msg = (detail as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
    try {
      return JSON.stringify(detail);
    } catch {
      return "request failed";
    }
  }
  return String(detail);
}

/** Parse a `Retry-After` header (delta-seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.max(0, Math.round(Number(trimmed) * 1000));
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}
