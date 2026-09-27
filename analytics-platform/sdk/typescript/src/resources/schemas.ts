import type {
  DatasetRecord,
  GeneratePreview,
  GenerateRequest,
  GenerateResult,
  Job,
  ParseSchemaRequest,
  ParseSchemaResponse,
  SavedSchema,
  SavedSchemaVersion,
  SaveSchemaRequest,
  SaveSchemaResponse,
  Schema,
  SchemaDiff,
  SchemaValidation,
} from "../types.js";
import { Resource, filenameFrom, seg, type CallOptions } from "./base.js";

export class SchemasResource extends Resource {
  /** Parse JSON Schema, XSD or a natural-language description into the canonical schema. */
  parse(body: ParseSchemaRequest, options?: CallOptions): Promise<ParseSchemaResponse> {
    return this.http.request({ method: "POST", path: "/v1/schemas/parse", body, ...options });
  }

  validate(schema: Schema, options?: CallOptions): Promise<SchemaValidation> {
    return this.http.request({ method: "POST", path: "/v1/schemas/validate", body: schema, ...options });
  }

  // -- schema history (SCH-010) --

  /** Save a new version; `created: false` when the content is identical to the latest version. */
  save(body: SaveSchemaRequest, options?: CallOptions): Promise<SaveSchemaResponse> {
    return this.http.request({ method: "POST", path: "/v1/schemas", body, ...options });
  }

  list(params: { projectId?: string } = {}, options?: CallOptions): Promise<SavedSchema[]> {
    return this.http.request({ method: "GET", path: "/v1/schemas", query: { project_id: params.projectId }, ...options });
  }

  /** A saved schema with its `versions`. */
  get(schemaId: string, options?: CallOptions): Promise<SavedSchema> {
    return this.http.request({ method: "GET", path: `/v1/schemas/${seg(schemaId)}`, ...options });
  }

  versions(schemaId: string, options?: CallOptions): Promise<SavedSchemaVersion[]> {
    return this.http.request({ method: "GET", path: `/v1/schemas/${seg(schemaId)}/versions`, ...options });
  }

  /** One version, including its `schema`. */
  version(schemaId: string, version: number, options?: CallOptions): Promise<SavedSchemaVersion> {
    return this.http.request({ method: "GET", path: `/v1/schemas/${seg(schemaId)}/versions/${seg(version)}`, ...options });
  }

  /** Diff two saved versions (default: previous → latest). */
  diff(schemaId: string, params: { fromVersion?: number; toVersion?: number } = {}, options?: CallOptions): Promise<SchemaDiff> {
    return this.http.request({
      method: "GET",
      path: `/v1/schemas/${seg(schemaId)}/diff`,
      query: { from_version: params.fromVersion, to_version: params.toVersion },
      ...options,
    });
  }

  /** Diff two arbitrary schemas. */
  diffSchemas(a: Schema, b: Schema, options?: CallOptions): Promise<SchemaDiff> {
    return this.http.request({ method: "POST", path: "/v1/schemas/diff", body: { a, b }, ...options });
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
