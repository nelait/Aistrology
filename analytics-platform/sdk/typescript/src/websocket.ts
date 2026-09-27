/**
 * WebSocket inference (API-006): `/v1/endpoints/{name}/ws`, authenticated with a single-use stream token.
 */

import { AnalyticsPlatformError, NetworkError, createApiError } from "./errors.js";
import type { PredictResponse, Row } from "./types.js";

/** The subset of the WHATWG `WebSocket` API the helper uses (browsers, Node 22+, or the `ws` package). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface SocketPredictRequest {
  instances?: Row[];
  explain?: boolean;
  /** Forecasting endpoints. */
  horizon?: number;
  history?: Row[];
}

interface Pending {
  resolve: (value: any) => void;
  reject: (reason: unknown) => void;
}

/**
 * A connected prediction socket. Each `predict` sends one message and resolves with the matching reply;
 * several can be in flight at once. Every message counts against the rate limit.
 */
export class PredictionSocket {
  /** Resolves when the server sent `{"type": "ready"}`; rejects if authentication or the connection fails. */
  readonly ready: Promise<void>;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private closed = false;
  private closeError: AnalyticsPlatformError | undefined;

  constructor(
    readonly socket: WebSocketLike,
    readonly endpoint: string,
  ) {
    let resolveReady!: () => void;
    let rejectReady!: (err: unknown) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Avoid unhandled-rejection noise when callers only use predict().
    this.ready.catch(() => undefined);
    let isReady = false;

    socket.addEventListener("message", (event: { data: unknown }) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "ready") {
        isReady = true;
        resolveReady();
        return;
      }
      const id = msg.id === undefined || msg.id === null ? undefined : String(msg.id);
      const error = msg.error as { status?: number; detail?: unknown } | undefined;
      if (id === undefined) {
        // Connection-level failure (auth, permission, endpoint, stream limit); the server closes next.
        if (error) this.closeError = createApiError({ status: error.status ?? 500, detail: error.detail ?? "websocket error" });
        return;
      }
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      if (error) {
        waiter.reject(createApiError({ status: error.status ?? 500, detail: error.detail ?? "prediction failed" }));
      } else {
        const { id: _id, ...rest } = msg;
        waiter.resolve(rest);
      }
    });

    socket.addEventListener("close", (event: { code?: number; reason?: string }) => {
      this.closed = true;
      const err =
        this.closeError ?? new NetworkError(`websocket closed (code ${event?.code ?? "unknown"}${event?.reason ? `: ${event.reason}` : ""})`);
      if (!isReady) rejectReady(err);
      for (const waiter of this.pending.values()) waiter.reject(err);
      this.pending.clear();
    });

    socket.addEventListener("error", () => {
      if (!isReady && !this.closeError) this.closeError = new NetworkError("websocket connection failed");
    });
  }

  /** Predict over the socket. Waits for `ready` first. */
  async predict<TPrediction = unknown>(body: SocketPredictRequest): Promise<PredictResponse<TPrediction>> {
    await this.ready;
    if (this.closed) throw this.closeError ?? new NetworkError("websocket is closed");
    const id = String(this.nextId++);
    return new Promise<PredictResponse<TPrediction>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.send(JSON.stringify({ id, ...body }));
      } catch (err) {
        this.pending.delete(id);
        reject(new NetworkError(`websocket send failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
      }
    });
  }

  close(code = 1000, reason = "client closed"): void {
    this.socket.close(code, reason);
  }
}

/** `https://host` + `/v1/...` → `wss://host/v1/...`. */
export function toWebSocketUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`) + (path.startsWith("/") ? path : `/${path}`);
}
