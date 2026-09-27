import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  ConflictError,
  PredictionSocket,
  RateLimitError,
  ServerError,
  parseSSE,
  toWebSocketUrl,
  type WebSocketLike,
} from "../src/index.js";
import { client, json, mockFetch, type Call } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const encoder = new TextEncoder();

/** A text/event-stream Response whose body arrives in the given chunks. */
function sse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("OAuth client credentials", () => {
  it("fetches a token with a form-encoded grant, caches it and renews it before expiry", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let issued = 0;
    const { fetch, calls } = mockFetch((call: Call) => {
      if (call.url.endsWith("/oauth/token")) {
        issued++;
        return json({ access_token: `tok${issued}`, token_type: "bearer", expires_in: 900 });
      }
      return json({ auth: call.headers.authorization });
    });
    const ap = client(fetch, { clientId: "apc_1", clientSecret: "s3cret", scope: ["endpoints.predict", "data.read"] });
    expect(await ap.auth.me()).toEqual({ auth: "Bearer tok1" });
    expect(await ap.auth.me()).toEqual({ auth: "Bearer tok1" });
    const tokenCall = calls[0]!;
    expect(tokenCall.method).toBe("POST");
    expect(tokenCall.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(tokenCall.body)))).toEqual({
      grant_type: "client_credentials",
      client_id: "apc_1",
      client_secret: "s3cret",
      scope: "endpoints.predict data.read",
    });
    expect(tokenCall.headers.authorization).toBeUndefined();
    now += 880_000; // inside the 30 s renewal margin
    expect(await ap.auth.me()).toEqual({ auth: "Bearer tok2" });
    expect(issued).toBe(2);
  });

  it("shares one token request between concurrent calls and refetches once on 401", async () => {
    let issued = 0;
    let valid = "tok1";
    const { fetch } = mockFetch(async (call: Call) => {
      if (call.url.endsWith("/oauth/token")) {
        issued++;
        return json({ access_token: `tok${issued}`, expires_in: 900 });
      }
      return call.headers.authorization === `Bearer ${valid}` ? json([]) : json({ detail: "revoked" }, 401);
    });
    const ap = client(fetch, { clientId: "a", clientSecret: "b" });
    await Promise.all([ap.datasets.list(), ap.datasets.list(), ap.jobs.list()]);
    expect(issued).toBe(1);
    valid = "tok2";
    await expect(ap.datasets.list()).resolves.toEqual([]);
    expect(issued).toBe(2);
  });

  it("maps RFC 6749 errors to AuthenticationError with a code", async () => {
    const { fetch } = mockFetch([json({ error: "invalid_client", error_description: "unknown client" }, 401)]);
    const err = await client(fetch, { clientId: "a", clientSecret: "bad" }).auth.me().catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.code).toBe("invalid_client");
    expect(err.message).toContain("unknown client");
  });

  it("prefers an API key when both are configured", async () => {
    const { fetch, calls } = mockFetch([json([])]);
    await client(fetch, { apiKey: "ap_live_x", clientId: "a", clientSecret: "b" }).datasets.list();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["x-api-key"]).toBe("ap_live_x");
  });
});

describe("SSE streaming predictions", () => {
  it("parses events split across chunks, CRLF, comments and multi-line data", async () => {
    const text = ': ping\r\nevent: start\r\ndata: {"total":\r\ndata: 2}\r\n\r\nevent: done\ndata: {"total": 2}\n\ndata: plain';
    const chunks = [text.slice(0, 7), text.slice(7, 19), text.slice(19, 40), text.slice(40)];
    const events = await collect(parseSSE(sse(chunks).body!));
    expect(events).toEqual([
      { event: "start", data: { total: 2 } },
      { event: "done", data: { total: 2 } },
      { event: "message", data: "plain" },
    ]);
  });

  it("yields start, prediction and done events", async () => {
    const { fetch, calls } = mockFetch([
      sse([
        ev("start", { endpoint: "churn", total: 3, chunk_size: 2 }),
        ev("prediction", { offset: 0, count: 2, predictions: ["no", "yes"], model_version: {} }).slice(0, 25),
        ev("prediction", { offset: 0, count: 2, predictions: ["no", "yes"], model_version: {} }).slice(25),
        ev("prediction", { offset: 2, count: 1, predictions: ["no"], model_version: {} }),
        ev("done", { total: 3 }),
      ]),
    ]);
    const events = await collect(client(fetch, { apiKey: "k" }).endpoints.predictStream("churn", { instances: [{}, {}, {}], chunk_size: 2 }));
    expect(events.map((e) => e.event)).toEqual(["start", "prediction", "prediction", "done"]);
    const preds = events.flatMap((e) => (e.event === "prediction" ? e.data.predictions : []));
    expect(preds).toEqual(["no", "yes", "no"]);
    expect(calls[0]!.url).toBe("https://api.test/v1/endpoints/churn/predict/stream");
    expect(calls[0]!.headers.accept).toBe("text/event-stream");
    expect(calls[0]!.body).toEqual({ explain: false, instances: [{}, {}, {}], chunk_size: 2 });
  });

  it("throws a typed error for an error event", async () => {
    const { fetch } = mockFetch([sse([ev("start", { total: 4 }), ev("error", { status: 429, detail: "rate limit exceeded", offset: 1 })])]);
    const seen: string[] = [];
    const err = await (async () => {
      for await (const e of client(fetch, { apiKey: "k" }).endpoints.predictStream("m", { instances: [{}], chunk_size: 1 })) seen.push(e.event);
    })().catch((e) => e);
    expect(seen).toEqual(["start"]);
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it("retries 429 before the stream starts and cancels the body when the consumer stops early", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(ev("start", {}) + ev("forecast", { step: 1 })));
      },
      cancel,
    });
    const { fetch, calls } = mockFetch([
      json({ detail: "too many concurrent streams" }, 429, { "retry-after": "1" }),
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    ]);
    const stream = client(fetch, { apiKey: "k" }).endpoints.predictStream("sales", { horizon: 3 });
    const first = stream.next();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await first).value).toEqual({ event: "start", data: {} });
    await stream.return(undefined);
    expect(calls).toHaveLength(2);
    expect(cancel).toHaveBeenCalled();
  });
});

class FakeSocket implements WebSocketLike {
  static last: FakeSocket;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  private listeners: Record<string, ((e: any) => void)[]> = {};
  constructor(readonly url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => this.emit("message", { data: JSON.stringify({ type: "ready", endpoint: "churn" }) }));
  }
  addEventListener(type: string, fn: (e: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string, e: unknown) {
    for (const fn of this.listeners[type] ?? []) fn(e);
  }
  send(data: string) {
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    const reply = msg.instances ? { id: msg.id, predictions: ["yes"], model_version: {} } : { id: msg.id, error: { status: 422, detail: "instances required" } };
    queueMicrotask(() => this.emit("message", { data: JSON.stringify(reply) }));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.emit("close", { code });
  }
}

describe("WebSocket predictions", () => {
  it("connects with a stream token and correlates replies by id", async () => {
    const { fetch, calls } = mockFetch([json({ token: "t0k", expires_in: 60, url: "/v1/endpoints/churn/ws?token=t0k" })]);
    const socket = await client(fetch, { apiKey: "k" }).endpoints.connect("churn", { WebSocket: FakeSocket });
    expect(calls[0]!.url).toBe("https://api.test/v1/endpoints/churn/stream-token");
    expect(FakeSocket.last.url).toBe("wss://api.test/v1/endpoints/churn/ws?token=t0k");
    const [a, b] = await Promise.all([socket.predict({ instances: [{ x: 1 }] }), socket.predict({ horizon: 3 }).catch((e) => e)]);
    expect(a.predictions).toEqual(["yes"]);
    expect(b.status).toBe(422);
    expect(FakeSocket.last.sent.map((m) => m.id)).toEqual(["1", "2"]);
    socket.close();
    await expect(socket.predict({ instances: [{}] })).rejects.toThrow(/closed/);
  });

  it("rejects ready with the server's auth error", async () => {
    const listeners: Record<string, ((e: any) => void)[]> = {};
    const ws: WebSocketLike = {
      readyState: 1,
      send: () => undefined,
      close: () => undefined,
      addEventListener: (t, fn) => void (listeners[t] ??= []).push(fn),
    };
    const socket = new PredictionSocket(ws, "churn");
    listeners.message!.forEach((fn) => fn({ data: JSON.stringify({ error: { status: 401, detail: "token expired" } }) }));
    listeners.close!.forEach((fn) => fn({ code: 4401 }));
    const err = await socket.ready.catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
  });

  it("builds ws URLs", () => {
    expect(toWebSocketUrl("http://localhost:8000", "/v1/x")).toBe("ws://localhost:8000/v1/x");
    expect(toWebSocketUrl("https://a.b", "v1/x")).toBe("wss://a.b/v1/x");
  });
});

describe("Phase 2/3 resources", () => {
  it("send the documented requests", async () => {
    const { fetch, calls } = mockFetch(() => json({ join_candidates: [{ left_table: "o" }], job_id: "j1" }));
    const ap = client(fetch, { apiKey: "k" });
    const cases: [() => Promise<unknown>, string, string, unknown][] = [
      [() => ap.projects.create({ name: "Risk" }), "POST", "/v1/projects", { open: false, members: [], name: "Risk" }],
      [() => ap.projects.addTeam("p1", "t1"), "POST", "/v1/projects/p1/teams", { team_id: "t1" }],
      [() => ap.teams.removeMember("t1", "u1"), "DELETE", "/v1/teams/t1/members/u1", undefined],
      [
        () => ap.schedules.create({ name: "n", cron: "0 2 * * *", job_type: "dataset.profile", params: { dataset_id: "d1" } }),
        "POST",
        "/v1/schedules",
        { params: { dataset_id: "d1" }, name: "n", cron: "0 2 * * *", job_type: "dataset.profile" },
      ],
      [() => ap.schedules.pause("s1"), "PATCH", "/v1/schedules/s1", { enabled: false }],
      [() => ap.schedules.runNow("s1"), "POST", "/v1/schedules/s1/run", undefined],
      [() => ap.connectors.import("c1", { query: "SELECT 1" }), "POST", "/v1/connectors/c1/import", { query: "SELECT 1" }],
      [() => ap.streams.send("d1", [{ a: 1 }]), "POST", "/v1/streams/d1/records", { records: [{ a: 1 }] }],
      [() => ap.streams.compact("d1"), "POST", "/v1/streams/d1/compact", undefined],
      [() => ap.comments.reply("db1", "c1", "hi"), "POST", "/v1/dashboards/db1/comments", { body: "hi", parent_id: "c1" }],
      [() => ap.comments.resolve("db1", "c1"), "PATCH", "/v1/dashboards/db1/comments/c1", { resolved: true }],
      [() => ap.analytics.query({ o: "d1" }, "SELECT 1", { rowLimit: 5 }), "POST", "/v1/analytics/query", { datasets: { o: "d1" }, sql: "SELECT 1", row_limit: 5 }],
      [
        () => ap.datasets.suggestionFeedback("d1", { accepted: false, suggestion: { chart_type: "bar", category: "descriptive" } }),
        "POST",
        "/v1/datasets/d1/suggestions/feedback",
        { accepted: false, suggestion: { chart_type: "bar", category: "descriptive" } },
      ],
      [() => ap.schemas.save({ name: "s", schema: { name: "s", entities: [] } }), "POST", "/v1/schemas", { name: "s", schema: { name: "s", entities: [] } }],
      [() => ap.datasets.setAnnotations("d1", { columns: { email: ["pii"] } }), "PUT", "/v1/datasets/d1/annotations", { replace: true, columns: { email: ["pii"] } }],
      [() => ap.datasets.advancedProfile("d1", { near_duplicates: { enabled: false } }), "POST", "/v1/datasets/d1/profile/advanced", { near_duplicates: { enabled: false } }],
      [() => ap.trainingTemplates.apply("tt", { name: "e", dataset_id: "d1" }), "POST", "/v1/training-templates/tt/apply", { overrides: {}, name: "e", dataset_id: "d1" }],
      [() => ap.experiments.fairness("r1", { protected: ["plan"] }), "POST", "/v1/runs/r1/fairness", { protected: ["plan"] }],
      [() => ap.endpoints.startCanary("churn", { model_version_id: "mv2", steps: [10, 100] }), "POST", "/v1/endpoints/churn/canary", { model_version_id: "mv2", steps: [10, 100] }],
      [() => ap.endpoints.abortCanary("churn"), "POST", "/v1/endpoints/churn/canary/abort", undefined],
      [() => ap.endpoints.checkDrift("churn", { hours: 48 }), "POST", "/v1/endpoints/churn/drift/check", { hours: 48 }],
      [() => ap.endpoints.forecast("sales", { horizon: 7 }), "POST", "/v1/endpoints/sales/predict", { horizon: 7, explain: false }],
      [() => ap.tenant.oauthClients.create({ name: "etl", role: "analyst" }), "POST", "/v1/tenant/oauth-clients", { name: "etl", role: "analyst" }],
      [() => ap.notifications.setPreferences({ email: ["job.failed"] }), "PUT", "/v1/notifications/preferences", { email: ["job.failed"] }],
    ];
    for (const [call, method, path, body] of cases) {
      await call();
      const last = calls[calls.length - 1]!;
      expect([last.method, new URL(last.url).pathname]).toEqual([method, path]);
      expect(last.body).toEqual(body);
    }
    expect(await ap.analytics.joinSuggestions({ o: "d1", c: "d2" })).toEqual([{ left_table: "o" }]);
    await ap.endpoints.drift("churn", { hours: 6 });
    expect(calls[calls.length - 1]!.url).toBe("https://api.test/v1/endpoints/churn/drift?hours=6");
    await ap.datasets.list({ projectId: "p1" });
    expect(calls[calls.length - 1]!.url).toBe("https://api.test/v1/datasets?project_id=p1");
  });

  it("uploads models and dataset versions as multipart without retrying 5xx", async () => {
    const { fetch, calls } = mockFetch(() => json({ detail: "boom" }, 500));
    const ap = client(fetch, { apiKey: "k" });
    await expect(
      ap.models.upload(new Uint8Array([1, 2, 3]), { name: "m", signature: { problem_type: "regression", features: [] }, datasetId: "d1" }),
    ).rejects.toBeInstanceOf(ServerError);
    const form = calls[0]!.init.body as FormData;
    expect(form.get("name")).toBe("m");
    expect(JSON.parse(String(form.get("signature")))).toEqual({ problem_type: "regression", features: [] });
    expect(form.get("dataset_id")).toBe("d1");
    await expect(ap.datasets.addVersion("d1", "a\n1\n", { filename: "v2.csv", mode: "replace" })).rejects.toBeInstanceOf(ServerError);
    expect(calls[1]!.url).toBe("https://api.test/v1/datasets/d1/versions?mode=replace");
    expect(calls).toHaveLength(2);
  });

  it("downloads ONNX as bytes and maps canary conflicts", async () => {
    const { fetch } = mockFetch([
      new Response(new Uint8Array([8, 1]), { headers: { "content-type": "application/octet-stream" } }),
      json({ detail: "no rollout is running" }, 409),
    ]);
    const ap = client(fetch, { apiKey: "k" });
    expect(new Uint8Array(await ap.experiments.onnx("r1"))).toEqual(new Uint8Array([8, 1]));
    await expect(ap.endpoints.promoteCanary("churn")).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("resumable uploads", () => {
  function uploadServer(partMax: number, failures: string[] = []) {
    let received: Uint8Array = new Uint8Array(0);
    let size = 0;
    const patches: number[] = [];
    const status = () => ({ id: "up1", filename: "f", size, offset: received.length, status: "open", part_max_bytes: partMax, expires_at: "" });
    const handler = async (call: Call) => {
      const path = new URL(call.url).pathname;
      if (call.method === "POST" && path === "/v1/datasets/uploads") {
        size = (call.body as { size: number }).size;
        return json(status(), 201);
      }
      if (call.method === "GET") return json(status());
      if (call.method === "PATCH") {
        const offset = Number(call.headers["upload-offset"]);
        patches.push(offset);
        const part = new Uint8Array(await (call.init.body as Blob).arrayBuffer());
        const action = failures.shift() ?? "ok";
        if (action === "lost") {
          received = concat(received, part);
          return json({ detail: "boom" }, 502);
        }
        if (offset !== received.length) return json({ detail: { message: "offset mismatch", offset: received.length } }, 409);
        received = concat(received, part);
        return json(status());
      }
      if (path.endsWith("/complete")) return json({ dataset: { id: "ds1", bytes: received.length } }, 201);
      return json({ detail: "nope" }, 404);
    };
    return { handler, patches, get received() { return received; }, set preload(b: Uint8Array) { received = b; size = 20; } };
  }

  function concat(a: Uint8Array, b: Uint8Array) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }

  it("uploads in parts and resumes after a lost response", async () => {
    vi.useFakeTimers();
    const server = uploadServer(4, ["ok", "lost"]);
    const { fetch } = mockFetch(server.handler);
    const data = encoder.encode("a,b\n1,2\n3,4\n");
    const progress: number[] = [];
    const promise = client(fetch, { apiKey: "k" }).datasets.uploadResumable(data, { filename: "f.csv", onProgress: (s) => progress.push(s) });
    await vi.advanceTimersByTimeAsync(5_000);
    const out = await promise;
    expect((out.dataset as unknown as { bytes: number }).bytes).toBe(12);
    expect(Array.from(server.received)).toEqual(Array.from(data));
    expect(server.patches).toEqual([0, 4, 8]);
    expect(progress[progress.length - 1]).toBe(12);
  });

  it("resumes an existing session from the server's offset", async () => {
    const server = uploadServer(8);
    const data = new Uint8Array(Array.from({ length: 20 }, (_, i) => i));
    server.preload = data.slice(0, 6);
    const { fetch } = mockFetch(server.handler);
    await client(fetch, { apiKey: "k" }).datasets.uploadResumable(new Blob([data]), { filename: "b.bin", uploadId: "up1", partSize: 5 });
    expect(server.patches).toEqual([6, 11, 16]);
    expect(Array.from(server.received)).toEqual(Array.from(data));
  });

  it("retention.update merges with the current policy", async () => {
    const policy = { llm_bodies_days: 30, llm_metadata_days: 395, audit_days: 395, inference_logs_days: 30 };
    const { fetch, calls } = mockFetch([json(policy), json({ ...policy, inference_logs_days: 14 })]);
    await client(fetch, { apiKey: "k" }).tenant.retention.update({ inference_logs_days: 14 });
    expect(calls[1]!.method).toBe("PUT");
    expect(calls[1]!.body).toEqual({ ...policy, inference_logs_days: 14 });
  });
});
