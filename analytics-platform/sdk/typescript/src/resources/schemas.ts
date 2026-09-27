import type {
  DatasetRecord,
  GeneratePreview,
  GenerateRequest,
  GenerateResult,
  Job,
  ParseSchemaRequest,
  ParseSchemaResponse,
  Schema,
  SchemaValidation,
} from "../types.js";
import { Resource, filenameFrom, type CallOptions } from "./base.js";

export class SchemasResource extends Resource {
  /** Parse JSON Schema, XSD or a natural-language description into the canonical schema. */
  parse(body: ParseSchemaRequest, options?: CallOptions): Promise<ParseSchemaResponse> {
    return this.http.request({ method: "POST", path: "/v1/schemas/parse", body, ...options });
  }

  validate(schema: Schema, options?: CallOptions): Promise<SchemaValidation> {
    return this.http.request({ method: "POST", path: "/v1/schemas/validate", body: schema, ...options });
  }

  /** A few generated rows per entity, without storing anything. */
  preview(body: GenerateRequest, options?: CallOptions): Promise<GeneratePreview> {
    return this.http.request({ method: "POST", path: "/v1/generate/preview", body, ...options });
  }

  /**
   * Generate sample data. Resolves to a file download, a stored dataset (when `save_as` is set), or
   * a job for runs too large for a synchronous request.
   */
  async generate(body: GenerateRequest, options?: CallOptions): Promise<GenerateResult> {
    const response = await this.http.send({ method: "POST", path: "/v1/generate", body, ...options });
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status === 202) return { kind: "job", job: (await response.json()) as Job };
    if (contentType.includes("application/json")) return { kind: "dataset", dataset: (await response.json()) as DatasetRecord };
    return {
      kind: "file",
      data: await response.blob(),
      filename: filenameFrom(response.headers.get("content-disposition")),
      contentType,
    };
  }
}
