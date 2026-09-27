import type { ModelDetail, ModelStage, ModelSummary, RegisterModelRequest, RegisteredModelVersionRef } from "../types.js";
import { Resource, seg, type CallOptions } from "./base.js";

export class ModelsResource extends Resource {
  /** Register a run as a new version of the named model (created if needed). */
  register(body: RegisterModelRequest, options?: CallOptions): Promise<RegisteredModelVersionRef> {
    return this.http.request({ method: "POST", path: "/v1/models", body, ...options });
  }

  list(options?: CallOptions): Promise<ModelSummary[]> {
    return this.http.request({ method: "GET", path: "/v1/models", ...options });
  }

  get(modelId: string, options?: CallOptions): Promise<ModelDetail> {
    return this.http.request({ method: "GET", path: `/v1/models/${seg(modelId)}`, ...options });
  }

  /** Move a version between stages. Promoting to `production` archives the previous production version. */
  setStage(modelId: string, version: number, stage: ModelStage, options?: CallOptions): Promise<ModelDetail> {
    return this.http.request({
      method: "POST",
      path: `/v1/models/${seg(modelId)}/versions/${seg(version)}/stage`,
      body: { stage },
      ...options,
    });
  }
}
