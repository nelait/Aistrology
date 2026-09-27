# @analytics-platform/sdk

TypeScript/JavaScript SDK for the Analytics Platform REST API (v1). It covers requirements SDK-001, SDK-007 and SDK-008.

- It runs in browsers and in Node 18+. It has no runtime dependencies and uses the global `fetch`, or a `fetch` you inject.
- It ships ESM and CJS builds with bundled `.d.ts` files. Request and response models are fully typed.
- It handles authentication, token refresh, retries, timeouts and typed errors for you.

## Install

```bash
npm install @analytics-platform/sdk
```

## Quick start: predict with an API key

```ts
import { AnalyticsPlatform } from "@analytics-platform/sdk";

const ap = new AnalyticsPlatform({
  baseUrl: "https://analytics.example.com",
  apiKey: process.env.AP_API_KEY, // "ap_live_…", sent as X-API-Key
});

const res = await ap.endpoints.predict<string>("churn", [{ tenure: 3, plan: "pro", monthly: 40 }]);
console.log(res.predictions[0], res.probabilities?.[0], res.model_version);

// Add SHAP explanations per instance:
const explained = await ap.endpoints.predict("churn", [{ tenure: 3, plan: "pro", monthly: 40 }], { explain: true });
console.log(explained.shap);
```

## Log in, upload, train and deploy

```ts
import { AnalyticsPlatform, AuthenticationError } from "@analytics-platform/sdk";

const ap = new AnalyticsPlatform({
  baseUrl: "https://analytics.example.com",
  // Persist tokens so the session survives reloads (refresh tokens rotate on every use).
  onTokens: (t) => localStorage.setItem("ap_refresh", t.refresh_token),
});

try {
  await ap.auth.login({ email: "ana@acme.com", password, totp });
} catch (e) {
  if (e instanceof AuthenticationError && e.code === "mfa_required") {
    /* ask for the TOTP code and retry */
  }
  throw e;
}

// 1. Upload a file (File/Blob, Uint8Array/ArrayBuffer, or a string) and confirm the inferred schema.
const { dataset, inference } = await ap.datasets.upload(fileInput.files[0]); // or (csvString, { filename: "churn.csv" })
await ap.datasets.confirmSchema(dataset.id, inference!.schema);
const profile = await ap.datasets.profile(dataset.id);
const top = await ap.datasets.query(dataset.id, "select plan, count(*) n from data group by plan");

// 2. Optionally clean the data. Pipelines take typed steps discriminated by `op`.
const pipeline = await ap.pipelines.create({
  dataset_id: dataset.id,
  name: "clean",
  steps: [{ op: "fill_missing", columns: ["monthly"], strategy: "median" }, { op: "deduplicate" }],
});
await ap.jobs.wait((await ap.pipelines.apply(pipeline.id)).id);

// 3. Train. The call returns the experiment and its training job.
const { experiment, job } = await ap.experiments.create({
  name: "churn v1",
  dataset_id: dataset.id,
  target: "churn",
  automl: { enabled: true, strategy: "tpe", n_trials: 20 },
});
await ap.jobs.wait(job.id, {
  intervalMs: 2000,
  timeoutMs: 15 * 60_000,
  onProgress: (j) => console.log(j.status, Math.round(j.progress * 100) + "%", j.message),
});
const { runs } = await ap.experiments.get(experiment.id);
const best = runs.find((r) => r.status === "succeeded")!;

// 4. Register the model, promote it and deploy it.
const version = await ap.models.register({ name: "churn", run_id: best.id });
await ap.models.setStage(version.model_id, version.version, "production");
const endpoint = await ap.endpoints.deploy({ name: "churn", model_id: version.model_id, version: version.version });

// 5. Serve predictions, in real time or as a batch.
await ap.endpoints.predict("churn", [{ tenure: 3, plan: "pro", monthly: 40 }]);
const batch = await ap.endpoints.batch("churn", { datasetId: dataset.id });
await ap.jobs.wait(batch.id);
const csv: Blob = await ap.endpoints.batchResult("churn", batch.id); // or { as: "arrayBuffer" | "text" }
```

To restore a session later, call `new AnalyticsPlatform({ baseUrl, refreshToken: saved, onTokens })`. The first request exchanges the refresh token for a new pair.

## Machine to machine: OAuth 2.0 client credentials

Register a client once (an admin, or a user with `endpoints.deploy`) and keep the secret in your secret manager:

```ts
const { client_id, client_secret } = await admin.tenant.oauthClients.create({ name: "scoring", role: "analyst", scopes: ["endpoints.predict"] });
```

A service then authenticates with the pair. The SDK posts the form-encoded grant to `/oauth/token`, caches the token, renews it 30 s before it expires, and fetches a new one once if a call returns 401 (for example after the client was revoked and re-created). Concurrent calls share one token request.

```ts
const ap = new AnalyticsPlatform({ baseUrl, clientId: process.env.AP_CLIENT_ID, clientSecret: process.env.AP_CLIENT_SECRET, scope: ["endpoints.predict"] });
await ap.endpoints.predict("churn", rows);
```

RFC 6749 errors become `AuthenticationError` (or `ValidationError` / `RateLimitError`), with `code` set to `invalid_client`, `invalid_scope`, and so on.

## Streaming predictions (Server-Sent Events)

`predictStream` reads the `text/event-stream` body through `fetch`'s `ReadableStream`, so it works in browsers, Node 18+ and edge runtimes:

```ts
const controller = new AbortController();
for await (const ev of ap.endpoints.predictStream("churn", { instances: rows, chunk_size: 500 }, { signal: controller.signal })) {
  if (ev.event === "start") console.log("total", ev.data.total);
  if (ev.event === "prediction") render(ev.data.offset, ev.data.predictions);
  if (ev.event === "forecast") plot(ev.data.timestamp, ev.data.prediction, ev.data.lower, ev.data.upper); // forecasting endpoints
}
```

- Until the stream starts, the usual rules apply: authentication, refresh, and retries on 429/503 (for example "too many concurrent streams", which comes with `Retry-After`).
- An `error` event mid-stream throws the matching typed error. For example, a chunk refused by the rate limiter throws `RateLimitError`.
- Breaking out of the loop, or aborting the signal, cancels the HTTP body.
- `parseSSE(readableStream)` is exported for other event streams.

## WebSocket predictions

`connect` asks for a single-use stream token (valid 60 s), opens `wss://…/v1/endpoints/{name}/ws?token=…` and waits for the server's `ready` message. Replies are matched to requests by `id`, so several predictions can be in flight at once.

```ts
const socket = await ap.endpoints.connect("churn"); // global WebSocket (browsers, Node 22+), or { WebSocket: WsFromTheWsPackage }
const out = await socket.predict({ instances: [{ tenure: 3, plan: "pro" }] });
socket.close();
```

Per-message errors reject that `predict` with the typed error. Connection-level failures (close codes 4401, 4403, 4404, 4429) reject `ready` and any pending calls.

## Large files: resumable uploads

Files above 100 MB go through the resumable protocol automatically: `upload` with `method: "resumable"`, or `uploadResumable` directly. The SDK declares the file (`POST /v1/datasets/uploads`) and sends parts with `Upload-Offset`. After a network error, timeout, 5xx or 409 offset mismatch, it asks the server for its offset and continues from there. Completion (`POST …/complete`) is idempotent and is retried.

```ts
const { dataset } = await ap.datasets.uploadResumable(file, {
  sha256: true,                        // computed with WebCrypto and verified by the server; or pass the hex digest
  partSize: 8 * 1024 * 1024,           // capped by the server's part_max_bytes (32 MB by default)
  onProgress: (sent, total) => bar.update(sent / total),
});
// Resume after an app restart: uploadResumable(file, { uploadId }), uploadStatus(uploadId) and abortUpload(uploadId).
```

## Canary rollouts and drift

```ts
await ap.endpoints.startCanary("churn", { model_version_id: v2.model_version_id, steps: [5, 25, 50, 100], max_error_rate: 0.02 });
const rollout = await ap.endpoints.canary("churn");   // status, weight, history, live canary vs baseline stats
await ap.endpoints.promoteCanary("churn");             // or abortCanary
const drift = await ap.endpoints.drift("churn", { hours: 24 }); // PSI per feature and for predictions
await ap.endpoints.checkDrift("churn");                // job that raises endpoint.threshold alerts
```

## Verifying webhooks

Deliveries carry the header `X-AP-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`. Always verify against the **raw** request body. The check uses WebCrypto, so it works in Node, in browsers and in edge runtimes.

```ts
import express from "express";
import { verifyWebhookSignature } from "@analytics-platform/sdk";

const app = express();
app.post("/hooks/analytics", express.raw({ type: "application/json" }), async (req, res) => {
  const ok = await verifyWebhookSignature(
    process.env.AP_WEBHOOK_SECRET!, // the `secret` returned once by ap.webhooks.create(...)
    req.body,                       // Buffer / Uint8Array / string: the raw bytes
    req.header("X-AP-Signature"),
    300,                            // tolerance in seconds (replay protection)
  );
  if (!ok) return res.sendStatus(400);
  const event = JSON.parse(req.body.toString("utf8"));
  // ...
  res.sendStatus(204);
});
```

## Client options

| Option | Default | Notes |
|---|---|---|
| `baseUrl` | required | API origin. |
| `apiKey` | none | Sent as `X-API-Key`. Takes precedence over user tokens and client credentials. |
| `clientId`, `clientSecret`, `scope` | none | OAuth 2.0 client credentials: tokens are fetched from `/oauth/token` and renewed automatically. |
| `accessToken`, `refreshToken` | none | User session. On a 401 the client refreshes automatically. |
| `onTokens(pair)` | none | Called after login and after every refresh. |
| `fetch` | global `fetch` | Inject your own fetch, for example for proxies, tests or older runtimes. |
| `timeoutMs` | `60000` | Applies to each attempt. `0` disables it. Individual calls can override it. |
| `maxRetries` | `2` | Individual calls can override it. |
| `retryBaseDelayMs` / `maxRetryDelayMs` | `500` / `30000` | Backoff tuning. |
| `headers` | none | Extra headers sent on every request. |

Every method also accepts per-call options as its last argument: `{ signal, timeoutMs, maxRetries, headers }`.

## Transparent behaviour

**Authentication:**
- An API key is sent as `X-API-Key`.
- A user access token is sent as `Authorization: Bearer`.
- On a 401 the client calls `/v1/auth/refresh` once and replays the request.
- Concurrent 401s share a single in-flight refresh, because refresh tokens are single-use and rotate.
- If the refresh token is rejected, the session is cleared and an `AuthenticationError` is thrown.

**Retries:**
- Retries use exponential backoff with jitter. The wait is a random value between `d/2` and `d`, where `d = base·2^n`, capped at `maxRetryDelayMs`.
- A `Retry-After` header is respected when the server sends one.
- GET, PUT and DELETE are retried on 408, 429, 5xx and network errors.
- POST and PATCH are retried only on 429 and 503, or when no response arrived at all, so a request is never repeated after it may have taken effect. Timed-out POST and PATCH requests are not retried. `predict` is a POST and follows this rule. Pass `idempotent: true` to `ap.http.request` for other side-effect-free POSTs.
- Resumable upload parts are resent from the server's offset, and token requests are retried like reads.
- Other 4xx responses are never retried.

**Errors:** every error extends `AnalyticsPlatformError`.

| Class | When |
|---|---|
| `ApiError` | Any non-2xx response. Has `status`, `code` (taken from `detail.code`), `detail`, `body` and `headers`. |
| `AuthenticationError` | 401 |
| `ForbiddenError` | 403 |
| `NotFoundError` | 404 |
| `ConflictError` | 409 |
| `ValidationError` | 422. `.issues` holds the individual problems. |
| `RateLimitError` | 429. `.retryAfterMs` holds the server's wait. |
| `ServerError` | 5xx |
| `TimeoutError` | The client-side timeout expired, or `jobs.wait` ran out of time. |
| `NetworkError` | No response was received. |
| `JobFailedError` | Thrown by `jobs.wait` when a job fails or is cancelled. `.job` holds the job. |

## Resources

| Namespace | Methods |
|---|---|
| `auth` | `signup`, `login`, `refresh`, `logout`, `me`, `mfaSetup`, `mfaActivate` |
| `projects` | `list`, `create`, `addMember`, `removeMember`, `addTeam`, `removeTeam` |
| `teams` | `create`, `list`, `get`, `delete`, `addMember`, `removeMember` |
| `tenant` | `get`, `update`, `delete`, `usage`, `llmUsage`, plus the sub-namespaces below |
| `tenant.users` | `list`, `create`, `update` |
| `tenant.apiKeys` | `list`, `create`, `rotate`, `revoke` |
| `tenant.llmConfig` | `get`, `put` |
| `tenant.secrets` | `list`, `put`, `delete` |
| `tenant.audit` | `list`, `verify` |
| `tenant.exports` | `create`, `download` |
| `tenant.oauthClients` | `list`, `create`, `revoke` |
| `tenant.retention` | `get`, `update` (merges with the current policy), `apply` |
| `schemas` | `parse`, `validate`, `preview`, `generate` (returns `{kind: "file" \| "dataset" \| "job"}`), and schema history: `save`, `list`, `get`, `versions`, `version`, `diff`, `diffSchemas` |
| `datasets` | `upload` (with `projectId`; resumable above 100 MB), `uploadResumable`, `uploadStatus`, `abortUpload`, `list({projectId})`, `get`, `versions`, `addVersion` (`mode: append \| replace`), `delete`, `confirmSchema`, `profile`, `advancedProfile`, `annotations`, `setAnnotations`, `projection`, `query`, `suggestions`, `suggestionFeedback` |
| `streams` | `create`, `get` (buffer status), `send(datasetId, records)`, `compact` |
| `connectors` | `create`, `list`, `get`, `delete`, `import`, `allowlist`, `setAllowlist` |
| `schedules` | `types`, `create`, `list`, `get`, `update`, `pause`, `resume`, `delete`, `runNow` |
| `pipelines` | `create`, `list`, `templates`, `fromTemplate`, `get`, `addStep`, `undo`, `redo`, `preview`, `saveTemplate`, `apply` |
| `jobs` | `list`, `get`, `cancel`, `wait(jobId, {intervalMs, timeoutMs, onProgress, throwOnFailure, signal})` |
| `notifications` | `list`, `markRead`, `preferences`, `setPreferences` |
| `experiments` | `algorithms`, `detect`, `create`, `list`, `get`, `compare`, `getRun`, `explain`, `explanationText`, `fairness`, `projection`, `onnx` |
| `trainingTemplates` | `list`, `create`, `get`, `update`, `delete`, `apply` |
| `models` | `register`, `upload` (custom ONNX), `list`, `get`, `setStage` |
| `endpoints` | `deploy`, `list`, `get`, `update`, `delete`, `predict`, `detectAnomalies`, `forecast`, `predictStream` (SSE), `streamToken`, `connect` (WebSocket), `batch`, `batchResult`, `openapi`, `metrics`, `startCanary`, `canary`, `promoteCanary`, `abortCanary`, `evaluateCanaries`, `drift`, `checkDrift`, `checkAllDrift` |
| `analytics` | `create`, `list`, `get`, `delete`, `run`, `query` (multi-dataset SQL), `suggestions`, `joinSuggestions`, `suggestionFeedback`, `suggestionPreferences`, `resetSuggestionPreferences` |
| `dashboards` | `create`, `list`, `get`, `update`, `delete`, `clone`, `archive`, `share`, `widgetData`, `export`, `embedToken`, `getEmbedded`, `embeddedWidgetData`, `templates`, `fromTemplate` |
| `comments` | `list`, `create`, `reply`, `update`, `resolve`, `delete` |
| `webhooks` | `create`, `list`, `delete`, `deliveries`, `retryDelivery`, `verifySignature` |

For endpoints the SDK does not wrap, use `ap.http.request({ method, path, query, body })`. It gets the same authentication, retries and error handling.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsup → dist/index.{js,cjs,d.ts,d.cts}
```
