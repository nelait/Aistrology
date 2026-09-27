import type { Endpoint, EndpointCreate, EndpointMetrics, EndpointPatch, Job, PredictOptions, PredictResponse, Row } from "../types.js";
import { Resource, nameOf, seg, toBlob, type CallOptions, type UploadInput } from "./base.js";

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
