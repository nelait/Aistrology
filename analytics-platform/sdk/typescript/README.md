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
| `apiKey` | none | Sent as `X-API-Key`. Takes precedence over user tokens. |
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
- POST and PATCH are retried only on 429 and 503, or when no response arrived at all, so a request is never repeated after it may have taken effect. Timed-out POST and PATCH requests are not retried.
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
| `tenant` | `get`, `update`, `delete`, `usage`, `llmUsage`, plus the sub-namespaces below |
| `tenant.users` | `list`, `create`, `update` |
| `tenant.apiKeys` | `list`, `create`, `rotate`, `revoke` |
| `tenant.llmConfig` | `get`, `put` |
| `tenant.secrets` | `list`, `put`, `delete` |
| `tenant.audit` | `list`, `verify` |
| `tenant.exports` | `create`, `download` |
| `schemas` | `parse`, `validate`, `preview`, `generate` (returns `{kind: "file" \| "dataset" \| "job"}`) |
| `datasets` | `upload`, `list`, `get`, `versions`, `delete`, `confirmSchema`, `profile`, `query`, `suggestions` |
| `pipelines` | `create`, `list`, `templates`, `fromTemplate`, `get`, `addStep`, `undo`, `redo`, `preview`, `saveTemplate`, `apply` |
| `jobs` | `list`, `get`, `cancel`, `wait(jobId, {intervalMs, timeoutMs, onProgress, throwOnFailure, signal})` |
| `notifications` | `list`, `markRead` |
| `experiments` | `algorithms`, `detect`, `create`, `list`, `get`, `compare`, `getRun`, `explain`, `explanationText` |
| `models` | `register`, `list`, `get`, `setStage` |
| `endpoints` | `deploy`, `list`, `get`, `update`, `delete`, `predict`, `batch`, `batchResult`, `openapi`, `metrics` |
| `analytics` | `create`, `list`, `get`, `delete`, `run` |
| `dashboards` | `create`, `list`, `get`, `update`, `delete`, `clone`, `archive`, `share`, `widgetData`, `export`, `embedToken`, `getEmbedded`, `embeddedWidgetData`, `templates`, `fromTemplate` |
| `webhooks` | `create`, `list`, `delete`, `deliveries`, `retryDelivery`, `verifySignature` |

For endpoints the SDK does not wrap, use `ap.http.request({ method, path, query, body })`. It gets the same authentication, retries and error handling.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsup → dist/index.{js,cjs,d.ts,d.cts}
```
