import type {
  Algorithm,
  DetectRequest,
  DetectResult,
  Experiment,
  ExperimentCreate,
  ExperimentDetail,
  ExperimentWithJob,
  Explanation,
  FairnessReport,
  FairnessRequest,
  Projection,
  ProjectionRequest,
  Row,
  Run,
  RunComparison,
} from "../types.js";
import { Resource, seg, type CallOptions } from "./base.js";

export class ExperimentsResource extends Resource {
  /** Available algorithms and their hyperparameter spaces. */
  algorithms(options?: CallOptions): Promise<Algorithm[]> {
    return this.http.request({ method: "GET", path: "/v1/algorithms", ...options });
  }

  /** Auto-detect the problem type for a target column. */
  detect(body: DetectRequest, options?: CallOptions): Promise<DetectResult> {
    return this.http.request({ method: "POST", path: "/v1/experiments/detect", body, ...options });
  }

  /** Create an experiment and start its training job (`jobs.wait(result.job.id)`). */
  create(body: ExperimentCreate, options?: CallOptions): Promise<ExperimentWithJob> {
    return this.http.request({ method: "POST", path: "/v1/experiments", body, ...options });
  }

  list(options?: CallOptions): Promise<Experiment[]> {
    return this.http.request({ method: "GET", path: "/v1/experiments", ...options });
  }

  /** The experiment, its runs and its training job. */
  get(experimentId: string, options?: CallOptions): Promise<ExperimentDetail> {
    return this.http.request({ method: "GET", path: `/v1/experiments/${seg(experimentId)}`, ...options });
  }

  /** Side-by-side metrics for up to 20 runs, across experiments. */
  compare(runIds: string[], options?: CallOptions): Promise<RunComparison> {
    return this.http.request({ method: "GET", path: "/v1/experiments/compare", query: { run_ids: runIds.join(",") }, ...options });
  }

  /** One run with metrics and evaluation artifacts. */
  getRun(runId: string, options?: CallOptions): Promise<Run> {
    return this.http.request({ method: "GET", path: `/v1/runs/${seg(runId)}`, ...options });
  }

  /** What-if analysis: predictions plus SHAP contributions for arbitrary inputs (1–100 instances). */
  explain(runId: string, instances: Row[], options?: CallOptions): Promise<Explanation> {
    return this.http.request({ method: "POST", path: `/v1/runs/${seg(runId)}/explain`, body: { instances }, ...options });
  }

  /** Group fairness metrics on the run's held-out test set (XAI-004). */
  fairness(runId: string, body: FairnessRequest, options?: CallOptions): Promise<FairnessReport> {
    return this.http.request({ method: "POST", path: `/v1/runs/${seg(runId)}/fairness`, body, ...options });
  }

  /** 2-D projection through the run's fitted preprocessing, coloured by its predictions (FE-005a). */
  projection(runId: string, body: ProjectionRequest = {}, options?: CallOptions): Promise<Projection> {
    return this.http.request({ method: "POST", path: `/v1/runs/${seg(runId)}/projection`, body, ...options });
  }

  /** Download the model as ONNX (409 `onnx_unsupported` when the pipeline can't be exported). */
  onnx(runId: string, options?: CallOptions): Promise<ArrayBuffer> {
    return this.http.request({
      method: "GET",
      path: `/v1/runs/${seg(runId)}/onnx`,
      responseType: "arrayBuffer",
      ...options,
      headers: { Accept: "application/octet-stream", ...(options?.headers ?? {}) },
    });
  }

  /** A plain-English summary of the model, written by the tenant's LLM. */
  async explanationText(runId: string, options?: CallOptions): Promise<string> {
    const out = await this.http.request<{ text: string }>({ method: "POST", path: `/v1/runs/${seg(runId)}/explanation-text`, ...options });
    return out.text;
  }
}
