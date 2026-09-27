import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobFailedError, TimeoutError, type Job } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const job = (status: Job["status"], progress: number, extra: Partial<Job> = {}): Job => ({
  id: "job-1",
  type: "training.run",
  status,
  progress,
  message: null,
  params: {},
  result: null,
  error: null,
  attempts: 1,
  created_by: "u1",
  created_at: "2026-01-01T00:00:00Z",
  started_at: null,
  finished_at: null,
  ...extra,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("jobs.wait", () => {
  it("polls until the job succeeds and reports progress", async () => {
    const { fetch, calls } = mockFetch([
      json(job("queued", 0)),
      json(job("running", 0.5)),
      json(job("succeeded", 1, { result: { run_id: "r1" } })),
    ]);
    const onProgress = vi.fn();
    const promise = client(fetch, { accessToken: "t" }).jobs.wait<{ run_id: string }>("job-1", { intervalMs: 200, onProgress });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    const done = await promise;
    expect(done.status).toBe("succeeded");
    expect(done.result?.run_id).toBe("r1");
    expect(onProgress.mock.calls.map(([j]) => j.progress)).toEqual([0, 0.5, 1]);
    expect(calls.every((c) => c.url === "https://api.test/v1/jobs/job-1" && c.method === "GET")).toBe(true);
  });

  it("rejects with JobFailedError when the job fails", async () => {
    const { fetch } = mockFetch([json(job("failed", 0.3, { error: "target has one class" }))]);
    const err = await client(fetch).jobs.wait("job-1").catch((e) => e);
    expect(err).toBeInstanceOf(JobFailedError);
    expect(err.job.error).toBe("target has one class");
    expect(err.message).toContain("target has one class");
  });

  it("returns failed jobs when throwOnFailure is false", async () => {
    const { fetch } = mockFetch([json(job("cancelled", 0.1))]);
    const out = await client(fetch).jobs.wait("job-1", { throwOnFailure: false });
    expect(out.status).toBe("cancelled");
  });

  it("rejects with TimeoutError after timeoutMs", async () => {
    const { fetch, calls } = mockFetch(() => json(job("running", 0.2)));
    const promise = client(fetch).jobs.wait("job-1", { intervalMs: 1000, timeoutMs: 2500 });
    const assertion = expect(promise).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it("list and cancel hit the right endpoints", async () => {
    const { fetch, calls } = mockFetch([json([job("queued", 0)]), json(job("cancelled", 0))]);
    const ap = client(fetch);
    await ap.jobs.list({ status: "queued" });
    await ap.jobs.cancel("job-1");
    expect(calls[0]!.url).toBe("https://api.test/v1/jobs?status=queued");
    expect(calls[1]).toMatchObject({ url: "https://api.test/v1/jobs/job-1/cancel", method: "POST" });
  });
});
