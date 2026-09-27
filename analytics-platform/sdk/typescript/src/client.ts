import { HttpClient, type ClientOptions, type Tokens } from "./http.js";
import { ProjectsResource, TeamsResource } from "./resources/access.js";
import { AnalyticsResource } from "./resources/analytics.js";
import { CommentsResource } from "./resources/comments.js";
import { ConnectorsResource } from "./resources/connectors.js";
import { SchedulesResource } from "./resources/schedules.js";
import { StreamsResource } from "./resources/streams.js";
import { TrainingTemplatesResource } from "./resources/trainingTemplates.js";
import { AuthResource } from "./resources/auth.js";
import { DashboardsResource } from "./resources/dashboards.js";
import { DatasetsResource } from "./resources/datasets.js";
import { EndpointsResource } from "./resources/endpoints.js";
import { ExperimentsResource } from "./resources/experiments.js";
import { JobsResource, NotificationsResource } from "./resources/jobs.js";
import { ModelsResource } from "./resources/models.js";
import { PipelinesResource } from "./resources/pipelines.js";
import { SchemasResource } from "./resources/schemas.js";
import { TenantResource } from "./resources/tenant.js";
import { WebhooksResource } from "./resources/webhooks.js";

/**
 * Client for the Analytics Platform REST API.
 *
 * ```ts
 * const ap = new AnalyticsPlatform({ baseUrl: "https://analytics.example.com", apiKey: "ap_live_…" });
 * const { predictions } = await ap.endpoints.predict("churn", [{ tenure: 3, plan: "pro" }]);
 *
 * // Machine to machine with OAuth client credentials (tokens are fetched and renewed automatically):
 * const m2m = new AnalyticsPlatform({ baseUrl, clientId: "apc_…", clientSecret: "…" });
 * ```
 */
export class AnalyticsPlatform {
  readonly auth: AuthResource;
  readonly tenant: TenantResource;
  readonly schemas: SchemasResource;
  readonly datasets: DatasetsResource;
  readonly pipelines: PipelinesResource;
  readonly jobs: JobsResource;
  readonly notifications: NotificationsResource;
  readonly experiments: ExperimentsResource;
  readonly models: ModelsResource;
  readonly endpoints: EndpointsResource;
  readonly analytics: AnalyticsResource;
  readonly dashboards: DashboardsResource;
  readonly webhooks: WebhooksResource;
  readonly projects: ProjectsResource;
  readonly teams: TeamsResource;
  readonly schedules: SchedulesResource;
  readonly connectors: ConnectorsResource;
  readonly streams: StreamsResource;
  readonly comments: CommentsResource;
  readonly trainingTemplates: TrainingTemplatesResource;

  /** The underlying transport, for endpoints the SDK does not wrap yet. */
  readonly http: HttpClient;

  constructor(options: ClientOptions) {
    const http = new HttpClient(options);
    this.http = http;
    this.auth = new AuthResource(http);
    this.tenant = new TenantResource(http);
    this.schemas = new SchemasResource(http);
    this.datasets = new DatasetsResource(http);
    this.pipelines = new PipelinesResource(http);
    this.jobs = new JobsResource(http);
    this.notifications = new NotificationsResource(http);
    this.experiments = new ExperimentsResource(http);
    this.models = new ModelsResource(http);
    this.endpoints = new EndpointsResource(http);
    this.analytics = new AnalyticsResource(http);
    this.dashboards = new DashboardsResource(http);
    this.webhooks = new WebhooksResource(http);
    this.projects = new ProjectsResource(http);
    this.teams = new TeamsResource(http);
    this.schedules = new SchedulesResource(http);
    this.connectors = new ConnectorsResource(http);
    this.streams = new StreamsResource(http);
    this.comments = new CommentsResource(http);
    this.trainingTemplates = new TrainingTemplatesResource(http);
  }

  /** Current user tokens (e.g. to persist a session). */
  getTokens(): Tokens {
    return this.http.getTokens();
  }

  /** Replace the user tokens (e.g. to restore a session). Does not call `onTokens`. */
  setTokens(tokens: Tokens): void {
    this.http.setTokens(tokens);
  }
}
