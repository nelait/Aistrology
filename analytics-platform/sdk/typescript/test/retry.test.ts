import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkError, RateLimitError, ServerError, TimeoutError, ValidationError } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
  // Deterministic jitter: the backoff is d/2 + random * d/2, so random = 0 gives exactly d/2.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Let pending promise callbacks run without advancing time. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("retries", () => {
  it("retries GET on 5xx with exponential backoff", async () => {
    const { fetch, calls } = mockFetch([json({ detail: "boom" }, 500), json({ detail: "bad gateway" }, 502), json([{ id: "d1" }])]);
    const promise = client(fetch, { retryBaseDelayMs: 100 }).datasets.list();
    await flush();
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // first backoff: 100 * 2^0 / 2 = 50 ms
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(99);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); // second backoff: 100 * 2^1 / 2 = 100 ms
    expect(calls).toHaveLength(3);
    await expect(promise).resolves.toEqual([{ id: "d1" }]);
  });

  it("applies jitter within [d/2, d]", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const { fetch, calls } = mockFetch([json({}, 503), json({})]);
    const promise = client(fetch, { retryBaseDelayMs: 1000 }).auth.me();
    await vi.advanceTimersByTimeAsync(998);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(calls).toHaveLength(2);
    await promise;
  });

  it("respects Retry-After on 429", async () => {
    const { fetch, calls } = mockFetch([json({ detail: "rate limit exceeded" }, 429, { "retry-after": "2" }), json({ ok: 1 })]);
    const promise = client(fetch).jobs.list();
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await expect(promise).resolves.toEqual({ ok: 1 });
  });

  it("gives up after maxRetries and throws the mapped error", async () => {
    const { fetch, calls } = mockFetch([json({ detail: "down" }, 503), json({ detail: "down" }, 503), json({ detail: "down" }, 503)]);
    const promise = client(fetch, { maxRetries: 2 }).datasets.list();
    const assertion = expect(promise).rejects.toBeInstanceOf(ServerError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(calls).toHaveLength(3);
  });

  it("surfaces RateLimitError with retryAfterMs when retries run out", async () => {
    const { fetch } = mockFetch([json({ detail: "rate limit exceeded" }, 429, { "retry-after": "60" })]);
    const err = await client(fetch, { maxRetries: 0 }).datasets.list().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterMs).toBe(60_000);
  });

  it("does not retry other 4xx", async () => {
    const { fetch, calls } = mockFetch([json({ detail: [{ loc: ["body", "sql"], msg: "field required", type: "missing" }] }, 422)]);
    const err = await client(fetch).datasets.query("d1", "select 1").catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(1);
  });

  it("does not retry a POST on 500 (it may have taken effect)", async () => {
    const { fetch, calls } = mockFetch([json({ detail: "boom" }, 500)]);
    const err = await client(fetch).endpoints.predict("churn", [{ a: 1 }]).catch((e) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(1);
  });

  it("retries a POST on 503 and 429", async () => {
    const { fetch, calls } = mockFetch([json({}, 503), json({}, 429), json({ predictions: [1] })]);
    const promise = client(fetch).endpoints.predict("churn", [{ a: 1 }]);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toEqual({ predictions: [1] });
    expect(calls).toHaveLength(3);
  });

  it("retries a POST on network errors (no response received)", async () => {
    const { fetch, calls } = mockFetch([
      () => {
        throw new TypeError("fetch failed");
      },
      json({ predictions: [0] }),
    ]);
    const promise = client(fetch).endpoints.predict("churn", [{ a: 1 }]);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toEqual({ predictions: [0] });
    expect(calls).toHaveLength(2);
  });

  it("wraps persistent network failures in NetworkError", async () => {
    const { fetch } = mockFetch(() => {
      throw new TypeError("ECONNREFUSED");
    });
    const promise = client(fetch, { maxRetries: 1 }).datasets.list();
    const assertion = expect(promise).rejects.toBeInstanceOf(NetworkError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("times out slow requests with TimeoutError", async () => {
    const hang = (call: { init: RequestInit }) =>
      new Promise<Response>((_, reject) => {
        call.init.signal?.addEventListener("abort", () => reject(call.init.signal!.reason));
      });
    const { fetch, calls } = mockFetch(hang);
    const promise = client(fetch, { timeoutMs: 1000, maxRetries: 1 }).datasets.list();
    const assertion = expect(promise).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(1000); // first attempt times out
    await vi.advanceTimersByTimeAsync(50); // backoff
    await vi.advanceTimersByTimeAsync(1000); // second attempt times out
    await assertion;
    expect(calls).toHaveLength(2);
  });

  it("does not retry a timed-out POST", async () => {
    const hang = (call: { init: RequestInit }) =>
      new Promise<Response>((_, reject) => {
        call.init.signal?.addEventListener("abort", () => reject(call.init.signal!.reason));
      });
    const { fetch, calls } = mockFetch(hang);
    const promise = client(fetch, { timeoutMs: 500 }).endpoints.predict("x", [{}]);
    const assertion = expect(promise).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(calls).toHaveLength(1);
  });

  it("stops retrying when the caller aborts", async () => {
    const { fetch, calls } = mockFetch([json({}, 503), json({})]);
    const controller = new AbortController();
    const promise = client(fetch).datasets.list({ signal: controller.signal });
    const assertion = expect(promise).rejects.toThrow();
    await flush();
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
  });
});
