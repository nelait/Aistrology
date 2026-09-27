import type { Schedule, ScheduleCreate, ScheduleJobType, ScheduleRun, ScheduleType, ScheduleUpdate } from "../types.js";
import { Resource, seg, type CallOptions } from "./base.js";

/** Cron schedules for allowlisted job types (Phase 3). */
export class SchedulesResource extends Resource {
  /** Job types that can be scheduled, with the permission each needs and whether the caller has it. */
  types(options?: CallOptions): Promise<ScheduleType[]> {
    return this.http.request({ method: "GET", path: "/v1/schedules/types", ...options });
  }

  create(body: ScheduleCreate, options?: CallOptions): Promise<Schedule> {
    return this.http.request({ method: "POST", path: "/v1/schedules", body: { params: {}, ...body }, ...options });
  }

  /** Admins see every schedule of the organization, others their own. */
  list(params: { jobType?: ScheduleJobType } = {}, options?: CallOptions): Promise<Schedule[]> {
    return this.http.request({ method: "GET", path: "/v1/schedules", query: { job_type: params.jobType }, ...options });
  }

  get(scheduleId: string, options?: CallOptions): Promise<Schedule> {
    return this.http.request({ method: "GET", path: `/v1/schedules/${seg(scheduleId)}`, ...options });
  }

  update(scheduleId: string, body: ScheduleUpdate, options?: CallOptions): Promise<Schedule> {
    return this.http.request({ method: "PATCH", path: `/v1/schedules/${seg(scheduleId)}`, body, ...options });
  }

  pause(scheduleId: string, options?: CallOptions): Promise<Schedule> {
    return this.update(scheduleId, { enabled: false }, options);
  }

  resume(scheduleId: string, options?: CallOptions): Promise<Schedule> {
    return this.update(scheduleId, { enabled: true }, options);
  }

  delete(scheduleId: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "DELETE", path: `/v1/schedules/${seg(scheduleId)}`, ...options });
  }

  /** Run once now; wait for `result.job_id` with `jobs.wait`. */
  runNow(scheduleId: string, options?: CallOptions): Promise<ScheduleRun> {
    return this.http.request({ method: "POST", path: `/v1/schedules/${seg(scheduleId)}/run`, ...options });
  }
}
