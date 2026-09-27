import type { Job, Pipeline, PipelineApplyResult, PipelineCreate, PipelineFromTemplate, PipelinePreview, Step } from "../types.js";
import { Resource, seg, type CallOptions } from "./base.js";

export class PipelinesResource extends Resource {
  create(body: PipelineCreate, options?: CallOptions): Promise<Pipeline> {
    return this.http.request({ method: "POST", path: "/v1/pipelines", body, ...options });
  }

  list(params: { datasetId?: string } = {}, options?: CallOptions): Promise<Pipeline[]> {
    return this.http.request({ method: "GET", path: "/v1/pipelines", query: { dataset_id: params.datasetId }, ...options });
  }

  templates(options?: CallOptions): Promise<Pipeline[]> {
    return this.http.request({ method: "GET", path: "/v1/pipelines/templates", ...options });
  }

  fromTemplate(body: PipelineFromTemplate, options?: CallOptions): Promise<Pipeline> {
    return this.http.request({ method: "POST", path: "/v1/pipelines/from-template", body, ...options });
  }

  get(pipelineId: string, options?: CallOptions): Promise<Pipeline> {
    return this.http.request({ method: "GET", path: `/v1/pipelines/${seg(pipelineId)}`, ...options });
  }

  addStep(pipelineId: string, step: Step, options?: CallOptions): Promise<Pipeline> {
    return this.http.request({ method: "POST", path: `/v1/pipelines/${seg(pipelineId)}/steps`, body: { step }, ...options });
  }

  undo(pipelineId: string, options?: CallOptions): Promise<Pipeline> {
    return this.http.request({ method: "POST", path: `/v1/pipelines/${seg(pipelineId)}/undo`, ...options });
  }

  redo(pipelineId: string, options?: CallOptions): Promise<Pipeline> {
    return this.http.request({ method: "POST", path: `/v1/pipelines/${seg(pipelineId)}/redo`, ...options });
  }

  /** Preview the pipeline on a sample, optionally with one extra (unsaved) step. */
  preview(pipelineId: string, params: { step?: Step; rows?: number } = {}, options?: CallOptions): Promise<PipelinePreview> {
    return this.http.request({ method: "POST", path: `/v1/pipelines/${seg(pipelineId)}/preview`, body: params, ...options });
  }

  /** Save a copy of the pipeline as a reusable template. */
  saveTemplate(pipelineId: string, name: string, options?: CallOptions): Promise<Pipeline> {
    return this.http.request({ method: "POST", path: `/v1/pipelines/${seg(pipelineId)}/template`, body: { name }, ...options });
  }

  /** Apply the pipeline, producing a new dataset version. Returns a job; see `jobs.wait`. */
  apply(pipelineId: string, options?: CallOptions): Promise<Job<PipelineApplyResult>> {
    return this.http.request({ method: "POST", path: `/v1/pipelines/${seg(pipelineId)}/apply`, ...options });
  }
}
