import type { Comment, CommentCreate, CommentUpdate } from "../types.js";
import { Resource, seg, type CallOptions } from "./base.js";

/** Dashboard comment threads (SHR-005). */
export class CommentsResource extends Resource {
  /** Threads (root comments with `replies`), oldest first. */
  list(
    dashboardId: string,
    params: { widgetId?: string; includeResolved?: boolean } = {},
    options?: CallOptions,
  ): Promise<Comment[]> {
    return this.http.request({
      method: "GET",
      path: `/v1/dashboards/${seg(dashboardId)}/comments`,
      query: { widget_id: params.widgetId, include_resolved: params.includeResolved },
      ...options,
    });
  }

  create(dashboardId: string, body: CommentCreate, options?: CallOptions): Promise<Comment> {
    return this.http.request({ method: "POST", path: `/v1/dashboards/${seg(dashboardId)}/comments`, body, ...options });
  }

  reply(dashboardId: string, parentId: string, body: string, options?: CallOptions): Promise<Comment> {
    return this.create(dashboardId, { body, parent_id: parentId }, options);
  }

  update(dashboardId: string, commentId: string, body: CommentUpdate, options?: CallOptions): Promise<Comment> {
    return this.http.request({ method: "PATCH", path: `/v1/dashboards/${seg(dashboardId)}/comments/${seg(commentId)}`, body, ...options });
  }

  resolve(dashboardId: string, commentId: string, resolved = true, options?: CallOptions): Promise<Comment> {
    return this.update(dashboardId, commentId, { resolved }, options);
  }

  delete(dashboardId: string, commentId: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: `/v1/dashboards/${seg(dashboardId)}/comments/${seg(commentId)}`, ...options });
  }
}
