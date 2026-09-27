import type { Webhook, WebhookCreate, WebhookDelivery, WebhookWithSecret } from "../types.js";
import { verifyWebhookSignature } from "../webhooks.js";
import { Resource, seg, type CallOptions } from "./base.js";

export class WebhooksResource extends Resource {
  /** Register a webhook. Store the returned `secret`: it is shown only once. */
  create(body: WebhookCreate, options?: CallOptions): Promise<WebhookWithSecret> {
    return this.http.request({ method: "POST", path: "/v1/webhooks", body, ...options });
  }

  list(options?: CallOptions): Promise<Webhook[]> {
    return this.http.request({ method: "GET", path: "/v1/webhooks", ...options });
  }

  /** Deactivate a webhook and delete its secret. */
  delete(webhookId: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: `/v1/webhooks/${seg(webhookId)}`, ...options });
  }

  /** The latest 200 delivery attempts. */
  deliveries(webhookId: string, options?: CallOptions): Promise<WebhookDelivery[]> {
    return this.http.request({ method: "GET", path: `/v1/webhooks/${seg(webhookId)}/deliveries`, ...options });
  }

  /** Re-send a delivery. */
  retryDelivery(deliveryId: string, options?: CallOptions): Promise<{ job_id: string }> {
    return this.http.request({ method: "POST", path: `/v1/webhooks/deliveries/${seg(deliveryId)}/retry`, ...options });
  }

  /** Same as the standalone `verifyWebhookSignature`. */
  readonly verifySignature = verifyWebhookSignature;
}
