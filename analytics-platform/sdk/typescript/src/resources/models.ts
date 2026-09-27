import type {
  ModelDetail,
  ModelSignatureUpload,
  ModelStage,
  ModelSummary,
  ModelUploadResult,
  RegisterModelRequest,
  RegisteredModelVersionRef,
} from "../types.js";
import { Resource, nameOf, seg, toBlob, type CallOptions, type UploadInput } from "./base.js";

export interface ModelUploadOptions extends CallOptions {
  name: string;
  signature: ModelSignatureUpload;
  description?: string;
  /** Reference rows for drift monitoring and explanations (otherwise 100 synthetic rows). */
  datasetId?: string;
  filename?: string;
}

export class ModelsResource extends Resource {
  /** Register a run as a new version of the named model (created if needed). */
  register(body: RegisterModelRequest, options?: CallOptions): Promise<RegisteredModelVersionRef> {
    return this.http.request({ method: "POST", path: "/v1/models", body, ...options });
  }

  /**
   * Register a custom ONNX model (TRN-010). The server validates it (no pickle, standard operators only,
   * dry run); a rejection is a `ValidationError` with code `model_rejected`. Not retried on 5xx.
   */
  upload(file: UploadInput, options: ModelUploadOptions): Promise<ModelUploadResult> {
    const { name, signature, description, datasetId, filename, ...call } = options;
    const form = new FormData();
    form.append("file", toBlob(file, "application/octet-stream"), filename ?? nameOf(file) ?? "model.onnx");
    form.append("signature", JSON.stringify(signature));
    form.append("name", name);
    if (description !== undefined) form.append("description", description);
    if (datasetId !== undefined) form.append("dataset_id", datasetId);
    return this.http.request({ method: "POST", path: "/v1/models/upload", rawBody: form, ...call });
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
