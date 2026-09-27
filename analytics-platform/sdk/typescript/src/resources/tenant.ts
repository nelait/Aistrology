import type {
  ApiKey,
  ApiKeyCreate,
  ApiKeyWithSecret,
  AuditEntry,
  Job,
  LLMConfig,
  LLMUsage,
  OAuthClient,
  OAuthClientCreate,
  OAuthClientWithSecret,
  RetentionApplyResult,
  RetentionPolicy,
  Tenant,
  TenantDeletion,
  TenantPatch,
  Usage,
  User,
  UserCreate,
  UserPatch,
} from "../types.js";
import type { HttpClient } from "../http.js";
import { Resource, seg, type CallOptions } from "./base.js";

class UsersResource extends Resource {
  list(options?: CallOptions): Promise<User[]> {
    return this.http.request({ method: "GET", path: "/v1/tenant/users", ...options });
  }
  create(body: UserCreate, options?: CallOptions): Promise<User> {
    return this.http.request({ method: "POST", path: "/v1/tenant/users", body, ...options });
  }
  update(userId: string, body: UserPatch, options?: CallOptions): Promise<User> {
    return this.http.request({ method: "PATCH", path: `/v1/tenant/users/${seg(userId)}`, body, ...options });
  }
}

class ApiKeysResource extends Resource {
  list(options?: CallOptions): Promise<ApiKey[]> {
    return this.http.request({ method: "GET", path: "/v1/tenant/api-keys", ...options });
  }
  /** The secret `key` is returned only here. */
  create(body: ApiKeyCreate, options?: CallOptions): Promise<ApiKeyWithSecret> {
    return this.http.request({ method: "POST", path: "/v1/tenant/api-keys", body, ...options });
  }
  /** Issue a replacement key; the secret `key` is returned only here. */
  rotate(keyId: string, options?: CallOptions): Promise<ApiKeyWithSecret> {
    return this.http.request({ method: "POST", path: `/v1/tenant/api-keys/${seg(keyId)}/rotate`, ...options });
  }
  revoke(keyId: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: `/v1/tenant/api-keys/${seg(keyId)}`, ...options });
  }
}

/** OAuth 2.0 clients for machine-to-machine access (MGT-004a). */
class OAuthClientsResource extends Resource {
  list(options?: CallOptions): Promise<OAuthClient[]> {
    return this.http.request({ method: "GET", path: "/v1/tenant/oauth-clients", ...options });
  }
  /** The `client_secret` is returned only here. */
  create(body: OAuthClientCreate, options?: CallOptions): Promise<OAuthClientWithSecret> {
    return this.http.request({ method: "POST", path: "/v1/tenant/oauth-clients", body, ...options });
  }
  /** Revoke the client; its tokens stop working immediately. */
  revoke(clientRowId: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: `/v1/tenant/oauth-clients/${seg(clientRowId)}`, ...options });
  }
}

/** Data retention (SOC-PRV-002, admin only). */
class RetentionResource extends Resource {
  get(options?: CallOptions): Promise<RetentionPolicy> {
    return this.http.request({ method: "GET", path: "/v1/tenant/retention", ...options });
  }
  /** Change some periods; the others keep their current values. `audit_days` must be at least 365. */
  async update(changes: Partial<RetentionPolicy>, options?: CallOptions): Promise<RetentionPolicy> {
    const current = await this.get(options);
    return this.http.request({ method: "PUT", path: "/v1/tenant/retention", body: { ...current, ...changes }, ...options });
  }
  /** Apply the policy now instead of waiting for the daily sweep. */
  apply(options?: CallOptions): Promise<RetentionApplyResult> {
    return this.http.request({ method: "POST", path: "/v1/tenant/retention/apply", ...options });
  }
}

class LLMConfigResource extends Resource {
  get(options?: CallOptions): Promise<Required<LLMConfig>> {
    return this.http.request({ method: "GET", path: "/v1/tenant/llm-config", ...options });
  }
  put(config: LLMConfig, options?: CallOptions): Promise<Required<LLMConfig>> {
    return this.http.request({ method: "PUT", path: "/v1/tenant/llm-config", body: config, ...options });
  }
}

class SecretsResource extends Resource {
  /** Names only; secret values are write-only. */
  async list(options?: CallOptions): Promise<string[]> {
    const out = await this.http.request<{ names: string[] }>({ method: "GET", path: "/v1/tenant/secrets", ...options });
    return out.names;
  }
  put(name: string, value: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "PUT", path: `/v1/tenant/secrets/${seg(name)}`, body: { value }, ...options });
  }
  delete(name: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: `/v1/tenant/secrets/${seg(name)}`, ...options });
  }
}

class AuditResource extends Resource {
  list(params: { action?: string } = {}, options?: CallOptions): Promise<AuditEntry[]> {
    return this.http.request({ method: "GET", path: "/v1/tenant/audit", query: { action: params.action }, ...options });
  }
  /** Check the hash chain of the audit log. */
  verify(options?: CallOptions): Promise<{ valid: boolean }> {
    return this.http.request({ method: "GET", path: "/v1/tenant/audit/verify", ...options });
  }
}

class ExportsResource extends Resource {
  /** Start a full data export; wait for the job with `jobs.wait`, then `download`. */
  create(options?: CallOptions): Promise<Job> {
    return this.http.request({ method: "POST", path: "/v1/tenant/exports", ...options });
  }
  /** Download a finished export as a zip. */
  download(jobId: string, options?: CallOptions): Promise<Blob> {
    return this.http.request({
      method: "GET",
      path: `/v1/tenant/exports/${seg(jobId)}`,
      responseType: "blob",
      ...options,
    });
  }
}

export class TenantResource extends Resource {
  readonly users: UsersResource;
  readonly apiKeys: ApiKeysResource;
  readonly llmConfig: LLMConfigResource;
  readonly secrets: SecretsResource;
  readonly audit: AuditResource;
  readonly exports: ExportsResource;
  readonly oauthClients: OAuthClientsResource;
  readonly retention: RetentionResource;

  constructor(http: HttpClient) {
    super(http);
    this.users = new UsersResource(http);
    this.apiKeys = new ApiKeysResource(http);
    this.llmConfig = new LLMConfigResource(http);
    this.secrets = new SecretsResource(http);
    this.audit = new AuditResource(http);
    this.exports = new ExportsResource(http);
    this.oauthClients = new OAuthClientsResource(http);
    this.retention = new RetentionResource(http);
  }

  get(options?: CallOptions): Promise<Tenant> {
    return this.http.request({ method: "GET", path: "/v1/tenant", ...options });
  }

  update(body: TenantPatch, options?: CallOptions): Promise<Tenant> {
    return this.http.request({ method: "PATCH", path: "/v1/tenant", body, ...options });
  }

  /** Delete all tenant data. `confirm` must equal the tenant id. Irreversible. */
  delete(confirm: string, options?: CallOptions): Promise<TenantDeletion> {
    return this.http.request({ method: "DELETE", path: "/v1/tenant", query: { confirm }, ...options });
  }

  /** Metered usage: storage, API calls, compute seconds, LLM tokens. */
  usage(params: { since?: string } = {}, options?: CallOptions): Promise<Usage> {
    return this.http.request({ method: "GET", path: "/v1/tenant/usage", query: { since: params.since }, ...options });
  }

  llmUsage(options?: CallOptions): Promise<LLMUsage> {
    return this.http.request({ method: "GET", path: "/v1/tenant/llm-usage", ...options });
  }
}
