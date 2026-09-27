import { vi } from "vitest";
import { AnalyticsPlatform, type ClientOptions } from "../src/index.js";

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  init: RequestInit;
}

export type Handler = (call: Call) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function lowerHeaders(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => (out[k] = v));
  return out;
}

/**
 * A fetch mock. Pass a list of responses/handlers (consumed in order) or a single routing handler.
 * Every call is recorded with parsed JSON body.
 */
export function mockFetch(responses: (Response | Handler)[] | Handler) {
  const calls: Call[] = [];
  const queue = Array.isArray(responses) ? [...responses] : null;
  const fn = vi.fn(async (input: string, init: RequestInit = {}) => {
    let body: unknown = init.body;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: Call = { url: String(input), method: init.method ?? "GET", headers: lowerHeaders(init.headers), body, init };
    calls.push(call);
    let next: Response | Handler | undefined;
    if (queue) {
      next = queue.shift();
      if (!next) throw new Error(`unexpected request ${call.method} ${call.url}`);
    } else {
      next = responses as Handler;
    }
    return typeof next === "function" ? next(call) : next;
  });
  return { fetch: fn, calls };
}

export function client(fetch: ClientOptions["fetch"], options: Partial<ClientOptions> = {}) {
  return new AnalyticsPlatform({ baseUrl: "https://api.test/", fetch, retryBaseDelayMs: 100, ...options });
}

export const tokenPair = (n: number) => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  expires_in: 900,
  token_type: "bearer",
});
