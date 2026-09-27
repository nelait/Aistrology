import type { ExperimentWithJob, TrainingTemplate, TrainingTemplateApply, TrainingTemplateCreate } from "../types.js";
import { Resource, seg, type CallOptions } from "./base.js";

/** Reusable training configurations (CFG-007). */
export class TrainingTemplatesResource extends Resource {
  list(options?: CallOptions): Promise<TrainingTemplate[]> {
    return this.http.request({ method: "GET", path: "/v1/training-templates", ...options });
  }

  create(body: TrainingTemplateCreate, options?: CallOptions): Promise<TrainingTemplate> {
    return this.http.request({ method: "POST", path: "/v1/training-templates", body, ...options });
  }

  get(templateId: string, options?: CallOptions): Promise<TrainingTemplate> {
    return this.http.request({ method: "GET", path: `/v1/training-templates/${seg(templateId)}`, ...options });
  }

  update(templateId: string, body: Partial<Pick<TrainingTemplateCreate, "description" | "config">>, options?: CallOptions): Promise<TrainingTemplate> {
    return this.http.request({ method: "PATCH", path: `/v1/training-templates/${seg(templateId)}`, body, ...options });
  }

  delete(templateId: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: `/v1/training-templates/${seg(templateId)}`, ...options });
  }

  /** Start an experiment from the template; `overrides` are deep-merged over it. */
  apply(templateId: string, body: TrainingTemplateApply, options?: CallOptions): Promise<ExperimentWithJob & { template_id: string }> {
    return this.http.request({
      method: "POST",
      path: `/v1/training-templates/${seg(templateId)}/apply`,
      body: { overrides: {}, ...body },
      ...options,
    });
  }
}
