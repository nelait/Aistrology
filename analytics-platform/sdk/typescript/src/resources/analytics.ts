import type { Analytic, AnalyticCreate, QueryResult, RunAnalyticRequest } from "../types.js";
import { Resource, seg, type CallOptions } from "./base.js";

export class AnalyticsResource extends Resource {
  create(body: AnalyticCreate, options?: CallOptions): Promise<Analytic> {
    return this.http.request({ method: "POST", path: "/v1/analytics", body, ...options });
  }

  list(params: { datasetId?: string } = {}, options?: CallOptions): Promise<Analytic[]> {
    return this.http.request({ method: "GET", path: "/v1/analytics", query: { dataset_id: params.datasetId }, ...options });
  }

  get(analyticId: string, options?: CallOptions): Promise<Analytic> {
    return this.http.request({ method: "GET", path: `/v1/analytics/${seg(analyticId)}`, ...options });
  }

  delete(analyticId: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: `/v1/analytics/${seg(analyticId)}`, ...options });
  }

  /** Run a saved analytic; parameters are bound to `:name` placeholders. */
  run(analyticId: string, body: RunAnalyticRequest = {}, options?: CallOptions): Promise<QueryResult> {
    return this.http.request({ method: "POST", path: `/v1/analytics/${seg(analyticId)}/run`, body, ...options });
  }
}
