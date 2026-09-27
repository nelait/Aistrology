import type { Connector, ConnectorCreate, ConnectorImport, ConnectorImportResult, Job } from "../types.js";
import { Resource, seg, type CallOptions } from "./base.js";

/** External data sources: S3, GCS, PostgreSQL and MySQL (ING-007). */
export class ConnectorsResource extends Resource {
  /** Credentials go to the secret store and are never returned. */
  create(body: ConnectorCreate, options?: CallOptions): Promise<Connector> {
    return this.http.request({ method: "POST", path: "/v1/connectors", body: { credentials: {}, ...body }, ...options });
  }

  list(options?: CallOptions): Promise<Connector[]> {
    return this.http.request({ method: "GET", path: "/v1/connectors", ...options });
  }

  get(connectorId: string, options?: CallOptions): Promise<Connector> {
    return this.http.request({ method: "GET", path: `/v1/connectors/${seg(connectorId)}`, ...options });
  }

  delete(connectorId: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: `/v1/connectors/${seg(connectorId)}`, ...options });
  }

  /** Import an object (`key`), a `prefix` or a SELECT `query` into a new dataset. Returns the job. */
  import(connectorId: string, body: ConnectorImport, options?: CallOptions): Promise<Job<ConnectorImportResult>> {
    return this.http.request({ method: "POST", path: `/v1/connectors/${seg(connectorId)}/import`, body, ...options });
  }

  /** Private hosts connectors may reach (admin only). */
  allowlist(options?: CallOptions): Promise<{ hosts: string[] }> {
    return this.http.request({ method: "GET", path: "/v1/connectors/allowlist", ...options });
  }

  setAllowlist(hosts: string[], options?: CallOptions): Promise<{ hosts: string[] }> {
    return this.http.request({ method: "PUT", path: "/v1/connectors/allowlist", body: { hosts }, ...options });
  }
}
