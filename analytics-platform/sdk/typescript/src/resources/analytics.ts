import type {
  Analytic,
  AnalyticCreate,
  DatasetAliases,
  JoinCandidate,
  MultiDatasetSuggestions,
  QueryResult,
  RunAnalyticRequest,
  SuggestionFeedback,
  SuggestionPreferences,
} from "../types.js";
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

  // -- multi-dataset analytics (LLM-008) and suggestion feedback (LLM-009) --

  /** SQL across 1-5 datasets, each loaded as a table named by its alias. */
  query(datasets: DatasetAliases, sql: string, params: { rowLimit?: number } = {}, options?: CallOptions): Promise<QueryResult> {
    const body: Record<string, unknown> = { datasets, sql };
    if (params.rowLimit !== undefined) body.row_limit = params.rowLimit;
    return this.http.request({ method: "POST", path: "/v1/analytics/query", body, ...options });
  }

  /** Cross-dataset suggestions (validated and previewed) plus join candidates, for 2-5 datasets. */
  suggestions(datasets: DatasetAliases, params: { question?: string } = {}, options?: CallOptions): Promise<MultiDatasetSuggestions> {
    const body: Record<string, unknown> = { datasets };
    if (params.question !== undefined) body.question = params.question;
    return this.http.request({ method: "POST", path: "/v1/analytics/suggestions", body, ...options });
  }

  /** Just the join candidates between the datasets. */
  async joinSuggestions(datasets: DatasetAliases, options?: CallOptions): Promise<JoinCandidate[]> {
    return (await this.suggestions(datasets, {}, options)).join_candidates;
  }

  /** Record whether a suggestion was useful (per dataset). */
  suggestionFeedback(datasetId: string, body: SuggestionFeedback, options?: CallOptions): Promise<SuggestionPreferences> {
    return this.http.request({ method: "POST", path: `/v1/datasets/${seg(datasetId)}/suggestions/feedback`, body, ...options });
  }

  suggestionPreferences(options?: CallOptions): Promise<SuggestionPreferences> {
    return this.http.request({ method: "GET", path: "/v1/suggestions/preferences", ...options });
  }

  /** Admin only. */
  resetSuggestionPreferences(options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: "/v1/suggestions/preferences", ...options });
  }

  /** Run a saved analytic; parameters are bound to `:name` placeholders. */
  run(analyticId: string, body: RunAnalyticRequest = {}, options?: CallOptions): Promise<QueryResult> {
    return this.http.request({ method: "POST", path: `/v1/analytics/${seg(analyticId)}/run`, body, ...options });
  }
}
