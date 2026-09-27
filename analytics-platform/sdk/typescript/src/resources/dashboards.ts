import type {
  Dashboard,
  DashboardCreate,
  DashboardFromTemplate,
  DashboardTemplate,
  DashboardUpdate,
  EmbedToken,
  Filters,
  WidgetData,
} from "../types.js";
import { Resource, seg, type CallOptions } from "./base.js";

export class DashboardsResource extends Resource {
  create(body: DashboardCreate, options?: CallOptions): Promise<Dashboard> {
    return this.http.request({ method: "POST", path: "/v1/dashboards", body, ...options });
  }

  list(params: { archived?: boolean } = {}, options?: CallOptions): Promise<Dashboard[]> {
    return this.http.request({ method: "GET", path: "/v1/dashboards", query: { archived: params.archived }, ...options });
  }

  get(dashboardId: string, options?: CallOptions): Promise<Dashboard> {
    return this.http.request({ method: "GET", path: `/v1/dashboards/${seg(dashboardId)}`, ...options });
  }

  update(dashboardId: string, body: DashboardUpdate, options?: CallOptions): Promise<Dashboard> {
    return this.http.request({ method: "PUT", path: `/v1/dashboards/${seg(dashboardId)}`, body, ...options });
  }

  delete(dashboardId: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: `/v1/dashboards/${seg(dashboardId)}`, ...options });
  }

  clone(dashboardId: string, options?: CallOptions): Promise<Dashboard> {
    return this.http.request({ method: "POST", path: `/v1/dashboards/${seg(dashboardId)}/clone`, ...options });
  }

  /** Archive (default) or restore (`archived: false`). */
  archive(dashboardId: string, archived = true, options?: CallOptions): Promise<Dashboard> {
    return this.http.request({
      method: "POST",
      path: `/v1/dashboards/${seg(dashboardId)}/archive`,
      query: { archived },
      ...options,
    });
  }

  /** Share with a user id, or `*` for everyone in the organization. */
  share(dashboardId: string, userId: string, role: "editor" | "viewer" = "viewer", options?: CallOptions): Promise<Dashboard> {
    return this.http.request({
      method: "POST",
      path: `/v1/dashboards/${seg(dashboardId)}/share`,
      body: { user_id: userId, role },
      ...options,
    });
  }

  /** Data for one widget with dashboard filters applied (`{column: value | [values] | {min, max}}`). */
  widgetData(dashboardId: string, widgetId: string, filters: Filters = {}, options?: CallOptions): Promise<WidgetData> {
    return this.http.request({
      method: "POST",
      path: `/v1/dashboards/${seg(dashboardId)}/widgets/${seg(widgetId)}/data`,
      body: { filters },
      ...options,
    });
  }

  /** A self-contained interactive HTML snapshot. (For JSON, use `get`.) */
  export(dashboardId: string, filters: Filters = {}, options?: CallOptions): Promise<string> {
    return this.http.request({
      method: "POST",
      path: `/v1/dashboards/${seg(dashboardId)}/export`,
      body: { filters },
      responseType: "text",
      ...options,
      headers: { Accept: "text/html", ...(options?.headers ?? {}) },
    });
  }

  /** A signed, expiring token for embedding a read-only dashboard in another site. */
  embedToken(dashboardId: string, params: { ttlMinutes?: number } = {}, options?: CallOptions): Promise<EmbedToken> {
    return this.http.request({
      method: "POST",
      path: `/v1/dashboards/${seg(dashboardId)}/embed-token`,
      body: params.ttlMinutes !== undefined ? { ttl_minutes: params.ttlMinutes } : {},
      ...options,
    });
  }

  /** Load an embedded dashboard by token (no credentials needed). */
  getEmbedded(token: string, options?: CallOptions): Promise<Dashboard> {
    return this.http.request({ method: "GET", path: `/v1/embed/${seg(token)}`, auth: false, ...options });
  }

  /** Widget data for an embedded dashboard (no credentials needed). */
  embeddedWidgetData(token: string, widgetId: string, filters: Filters = {}, options?: CallOptions): Promise<WidgetData> {
    return this.http.request({
      method: "POST",
      path: `/v1/embed/${seg(token)}/widgets/${seg(widgetId)}/data`,
      body: { filters },
      auth: false,
      ...options,
    });
  }

  templates(options?: CallOptions): Promise<DashboardTemplate[]> {
    return this.http.request({ method: "GET", path: "/v1/dashboards/templates", ...options });
  }

  fromTemplate(body: DashboardFromTemplate, options?: CallOptions): Promise<Dashboard> {
    return this.http.request({ method: "POST", path: "/v1/dashboards/from-template", body, ...options });
  }
}
