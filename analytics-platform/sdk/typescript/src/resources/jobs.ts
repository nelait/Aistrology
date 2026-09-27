import type { Job, JobStatus, Notification, NotificationPreferences } from "../types.js";
import { JobFailedError, TimeoutError } from "../errors.js";
import { sleep, throwIfAborted } from "../http.js";
import { Resource, seg, type CallOptions } from "./base.js";

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "cancelled"];

export interface WaitOptions {
  /** Delay between polls (default 1000 ms). */
  intervalMs?: number;
  /** Give up after this long (default: wait forever); rejects with `TimeoutError`. */
  timeoutMs?: number;
  /** Called with every polled job state. */
  onProgress?: (job: Job) => void;
  /** Reject with `JobFailedError` when the job fails or is cancelled (default true). */
  throwOnFailure?: boolean;
  signal?: AbortSignal;
}

export class JobsResource extends Resource {
  list(params: { status?: JobStatus } = {}, options?: CallOptions): Promise<Job[]> {
    return this.http.request({ method: "GET", path: "/v1/jobs", query: { status: params.status }, ...options });
  }

  get<TResult = Record<string, unknown>>(jobId: string, options?: CallOptions): Promise<Job<TResult>> {
    return this.http.request({ method: "GET", path: `/v1/jobs/${seg(jobId)}`, ...options });
  }

  cancel(jobId: string, options?: CallOptions): Promise<Job> {
    return this.http.request({ method: "POST", path: `/v1/jobs/${seg(jobId)}/cancel`, ...options });
  }

  /** Poll a job until it succeeds, fails or is cancelled. */
  async wait<TResult = Record<string, unknown>>(jobId: string, options: WaitOptions = {}): Promise<Job<TResult>> {
    const { intervalMs = 1000, timeoutMs, onProgress, throwOnFailure = true, signal } = options;
    const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
    for (;;) {
      throwIfAborted(signal);
      const job = await this.get<TResult>(jobId, signal ? { signal } : undefined);
      onProgress?.(job as Job);
      if (TERMINAL_JOB_STATUSES.includes(job.status)) {
        if (throwOnFailure && job.status !== "succeeded") throw new JobFailedError(job as Job);
        return job;
      }
      let delay = intervalMs;
      if (deadline !== undefined) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new TimeoutError(timeoutMs!, `job ${jobId} did not finish within ${timeoutMs} ms (status ${job.status})`);
        delay = Math.min(delay, remaining);
      }
      await sleep(delay, signal);
    }
  }
}

export class NotificationsResource extends Resource {
  list(params: { unreadOnly?: boolean } = {}, options?: CallOptions): Promise<Notification[]> {
    return this.http.request({ method: "GET", path: "/v1/notifications", query: { unread_only: params.unreadOnly }, ...options });
  }

  markRead(notificationId: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "POST", path: `/v1/notifications/${seg(notificationId)}/read`, ...options });
  }

  /** Notification kinds emailed to the calling user (users only). */
  preferences(options?: CallOptions): Promise<NotificationPreferences> {
    return this.http.request({ method: "GET", path: "/v1/notifications/preferences", ...options });
  }

  setPreferences(body: NotificationPreferences, options?: CallOptions): Promise<NotificationPreferences> {
    return this.http.request({ method: "PUT", path: "/v1/notifications/preferences", body, ...options });
  }
}
