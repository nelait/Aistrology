import { AnalyticsPlatformError, createApiError } from "../errors.js";
import type {
  AnomalyResponse,
  CanaryRollout,
  CanaryStart,
  DriftReport,
  Endpoint,
  EndpointCreate,
  EndpointMetrics,
  EndpointPatch,
  ForecastRequest,
  ForecastResponse,
  Job,
  PredictOptions,
  PredictResponse,
  PredictStreamEvent,
  Row,
  StreamPredictRequest,
  StreamToken,
} from "../types.js";
import { PredictionSocket, toWebSocketUrl, type WebSocketConstructor } from "../websocket.js";
import { Resource, nameOf, seg, toBlob, type CallOptions, type UploadInput } from "./base.js";

export interface ConnectOptions extends CallOptions {
  /** WebSocket implementation; defaults to the global `WebSocket` (browsers, Node 22+). */
  WebSocket?: WebSocketConstructor;
}

export type BatchInput =
  /** Score a stored dataset. */
  | { datasetId: string }
  /** Score an uploaded CSV. */
  | { file: UploadInput; filename?: string };

export class EndpointsResource extends Resource {
  /** Deploy a registered model version (or an A/B split via `routes`). */
  deploy(body: EndpointCreate, options?: CallOptions): Promise<Endpoint> {
    return this.http.request({ method: "POST", path: "/v1/endpoints", body, ...options });
  }

  list(options?: CallOptions): Promise<Endpoint[]> {
    return this.http.request({ method: "GET", path: "/v1/endpoints", ...options });
  }

  get(name: string, options?: CallOptions): Promise<Endpoint> {
    return this.http.request({ method: "GET", path: `/v1/endpoints/${seg(name)}`, ...options });
  }

  /** Change routes (traffic split) or settings, or pause with `{status: "paused"}`. */
  update(name: string, body: EndpointPatch, options?: CallOptions): Promise<Endpoint> {
    return this.http.request({ method: "PATCH", path: `/v1/endpoints/${seg(name)}`, body, ...options });
  }

  delete(name: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: `/v1/endpoints/${seg(name)}`, ...options });
  }

  /** Real-time inference. Works with an API key or a user token. */
  predict<TPrediction = unknown>(
    name: string,
    instances: Row[],
    predictOptions: PredictOptions = {},
    options?: CallOptions,
  ): Promise<PredictResponse<TPrediction>> {
    return this.http.request({
      method: "POST",
      path: `/v1/endpoints/${seg(name)}/predict`,
      body: { instances, explain: predictOptions.explain ?? false },
      ...options,
    });
  }

  /** Predict on an anomaly-detection endpoint: `predictions: [{is_anomaly, score}]` plus `threshold`. */
  detectAnomalies(name: string, instances: Row[], options?: CallOptions): Promise<AnomalyResponse> {
    return this.http.request({
      method: "POST",
      path: `/v1/endpoints/${seg(name)}/predict`,
      body: { instances, explain: false },
      ...options,
    });
  }

  /** Forecast `horizon` steps on a forecasting endpoint, optionally refitting with recent `history`. */
  forecast(name: string, request: ForecastRequest = {}, options?: CallOptions): Promise<ForecastResponse> {
    return this.http.request({ method: "POST", path: `/v1/endpoints/${seg(name)}/predict`, body: { ...request, explain: false }, ...options });
  }

  /**
   * Streaming inference over Server-Sent Events (API-006): `start`, one `prediction` per chunk (or one
   * `forecast` per horizon step), then `done`. An `error` event rejects with the matching typed error.
   *
   * ```ts
   * for await (const ev of ap.endpoints.predictStream("churn", { instances: rows, chunk_size: 500 })) {
   *   if (ev.event === "prediction") render(ev.data.offset, ev.data.predictions);
   * }
   * ```
   */
  async *predictStream(name: string, request: StreamPredictRequest, options: CallOptions = {}): AsyncGenerator<PredictStreamEvent, void, undefined> {
    const path = `/v1/endpoints/${seg(name)}/predict/stream`;
    const events = this.http.events({ method: "POST", path, body: { explain: false, ...request }, ...options });
    for await (const ev of events) {
      if (ev.event === "error") {
        const data = (ev.data && typeof ev.data === "object" ? ev.data : { status: 500, detail: ev.data }) as { status?: number; detail?: unknown };
        throw createApiError({ status: data.status ?? 500, detail: data.detail ?? "stream failed", body: ev.data, method: "POST", url: this.http.url(path) });
      }
      yield ev as PredictStreamEvent;
    }
  }

  /** A single-use token (60 s) for the WebSocket endpoint. */
  streamToken(name: string, options?: CallOptions): Promise<StreamToken> {
    return this.http.request({ method: "POST", path: `/v1/endpoints/${seg(name)}/stream-token`, ...options });
  }

  /**
   * Open a WebSocket for low-latency predictions, authenticated with a fresh stream token (so no
   * credentials end up in the URL for longer than a minute).
   *
   * ```ts
   * const socket = await ap.endpoints.connect("churn");
   * const out = await socket.predict({ instances: [{ tenure: 3 }] });
   * socket.close();
   * ```
   */
  async connect(name: string, options: ConnectOptions = {}): Promise<PredictionSocket> {
    const { WebSocket: ctor, ...call } = options;
    const Impl = ctor ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (!Impl) throw new AnalyticsPlatformError("no WebSocket implementation available; pass options.WebSocket");
    const token = await this.streamToken(name, call);
    const socket = new PredictionSocket(new Impl(toWebSocketUrl(this.http.baseUrl, token.url)), name);
    await socket.ready;
    return socket;
  }

  // -- canary rollouts (API-009) --

  /** Start a canary rollout of `model_version_id`; the candidate gets `steps[0]` % of traffic. */
  startCanary(name: string, body: CanaryStart, options?: CallOptions): Promise<CanaryRollout> {
    return this.http.request({ method: "POST", path: `/v1/endpoints/${seg(name)}/canary`, body, ...options });
  }

  /** The latest rollout, with live canary/baseline stats while running. */
  canary(name: string, options?: CallOptions): Promise<CanaryRollout> {
    return this.http.request({ method: "GET", path: `/v1/endpoints/${seg(name)}/canary`, ...options });
  }

  promoteCanary(name: string, options?: CallOptions): Promise<CanaryRollout> {
    return this.http.request({ method: "POST", path: `/v1/endpoints/${seg(name)}/canary/promote`, ...options });
  }

  abortCanary(name: string, options?: CallOptions): Promise<CanaryRollout> {
    return this.http.request({ method: "POST", path: `/v1/endpoints/${seg(name)}/canary/abort`, ...options });
  }

  /** Evaluate every due rollout step (point a scheduler at it). */
  evaluateCanaries(options?: CallOptions): Promise<Job> {
    return this.http.request({ method: "POST", path: "/v1/endpoints/canary-steps", ...options });
  }

  // -- drift (API-011) --

  /** Population stability per feature and for predictions over the last `hours` (default 24). */
  drift(name: string, params: { hours?: number } = {}, options?: CallOptions): Promise<DriftReport> {
    return this.http.request({ method: "GET", path: `/v1/endpoints/${seg(name)}/drift`, query: { hours: params.hours }, ...options });
  }

  /** Queue a drift check that notifies and fires webhooks when the endpoint is in alert. */
  checkDrift(name: string, params: { hours?: number } = {}, options?: CallOptions): Promise<Job> {
    return this.http.request({ method: "POST", path: `/v1/endpoints/${seg(name)}/drift/check`, body: params, ...options });
  }

  /** Queue a drift check of every active endpoint. */
  checkAllDrift(params: { hours?: number } = {}, options?: CallOptions): Promise<Job> {
    return this.http.request({ method: "POST", path: "/v1/endpoints/drift-checks", body: params, ...options });
  }

  /** Start a batch prediction job from a dataset or an uploaded CSV. Fetch the output with `batchResult`. */
  batch(name: string, input: BatchInput, options?: CallOptions): Promise<Job> {
    const path = `/v1/endpoints/${seg(name)}/batch`;
    if ("datasetId" in input) {
      return this.http.request({ method: "POST", path, body: { dataset_id: input.datasetId }, ...options });
    }
    const form = new FormData();
    form.append("file", toBlob(input.file, "text/csv"), input.filename ?? nameOf(input.file) ?? "input.csv");
    return this.http.request({ method: "POST", path, rawBody: form, ...options });
  }

  /** Download the CSV output of a finished batch job (a Blob by default). */
  batchResult(name: string, jobId: string, options?: CallOptions & { as?: "blob" }): Promise<Blob>;
  batchResult(name: string, jobId: string, options: CallOptions & { as: "arrayBuffer" }): Promise<ArrayBuffer>;
  batchResult(name: string, jobId: string, options: CallOptions & { as: "text" }): Promise<string>;
  batchResult(
    name: string,
    jobId: string,
    options: CallOptions & { as?: "blob" | "arrayBuffer" | "text" } = {},
  ): Promise<Blob | ArrayBuffer | string> {
    const { as = "blob", ...call } = options;
    return this.http.request({
      method: "GET",
      path: `/v1/endpoints/${seg(name)}/batch/${seg(jobId)}`,
      responseType: as,
      ...call,
      headers: { Accept: "text/csv, */*", ...(call.headers ?? {}) },
    });
  }

  /** An OpenAPI document for this endpoint, generated from the model signature. */
  openapi(name: string, options?: CallOptions): Promise<Record<string, unknown>> {
    return this.http.request({ method: "GET", path: `/v1/endpoints/${seg(name)}/openapi.json`, ...options });
  }

  /** Request count, errors and latency percentiles over the last `hours` (default 24). */
  metrics(name: string, params: { hours?: number } = {}, options?: CallOptions): Promise<EndpointMetrics> {
    return this.http.request({ method: "GET", path: `/v1/endpoints/${seg(name)}/metrics`, query: { hours: params.hours }, ...options });
  }
}
