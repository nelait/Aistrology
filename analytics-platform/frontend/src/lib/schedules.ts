/** Per-job-type parameter forms for schedules (USR-007, SHR-004): labels, defaults and serialization. */
import type { AnalyticParameter, ScheduleJobType } from "./types";

export const JOB_TYPE_LABELS: Record<ScheduleJobType, string> = {
  "analytics.scheduled_run": "Scheduled analytic",
  "dashboard.deliver": "Dashboard delivery",
  "serving.drift_check": "Drift check",
  "serving.canary_step": "Canary steps",
  "stream.compact": "Stream compaction",
  "dataset.profile": "Dataset profiling",
  "pipeline.apply": "Pipeline apply",
};

export function jobTypeLabel(t: string): string {
  return JOB_TYPE_LABELS[t as ScheduleJobType] ?? t;
}

export interface ParamsForm {
  analytic_id: string;
  /** analytic parameter values as typed */
  values: Record<string, string>;
  row_limit: string;
  dashboard_id: string;
  public_link: boolean;
  recipients: string[];
  chat_destinations: string[];
  endpoint: string;
  hours: string;
  dataset_id: string;
  pipeline_id: string;
}

export const EMPTY_PARAMS: ParamsForm = {
  analytic_id: "",
  values: {},
  row_limit: "1000",
  dashboard_id: "",
  public_link: true,
  recipients: [],
  chat_destinations: [],
  endpoint: "",
  hours: "24",
  dataset_id: "",
  pipeline_id: "",
};

const int = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);

function paramValue(p: AnalyticParameter | undefined, raw: string): unknown {
  if (raw === "") return undefined;
  if (p?.type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

/**
 * The `params` body for a job type, or an error message. `analyticParams` are the saved analytic's declared
 * parameters (used to type the values).
 */
export function buildParams(jobType: string, f: ParamsForm, analyticParams: AnalyticParameter[] = []): { params: Record<string, unknown> | null; error: string | null } {
  const ok = (params: Record<string, unknown>) => ({ params, error: null });
  const fail = (error: string) => ({ params: null, error });
  switch (jobType) {
    case "analytics.scheduled_run": {
      if (!f.analytic_id) return fail("Choose a saved analytic");
      const limit = int(f.row_limit);
      if (!Number.isFinite(limit) || limit < 1 || limit > 10000) return fail("Row limit must be 1–10,000");
      const values = Object.fromEntries(
        Object.entries(f.values)
          .map(([k, v]) => [k, paramValue(analyticParams.find((p) => p.name === k), v)] as const)
          .filter(([, v]) => v !== undefined),
      );
      return ok({ analytic_id: f.analytic_id, params: values, row_limit: limit, recipients: f.recipients, chat_destinations: f.chat_destinations });
    }
    case "dashboard.deliver":
      if (!f.dashboard_id) return fail("Choose a dashboard");
      if (!f.recipients.length && !f.chat_destinations.length) return fail("Add at least one recipient or chat destination");
      return ok({ dashboard_id: f.dashboard_id, recipients: f.recipients, chat_destinations: f.chat_destinations, public_link: f.public_link });
    case "serving.drift_check": {
      const hours = int(f.hours);
      if (!Number.isFinite(hours) || hours < 1 || hours > 2160) return fail("Window must be 1–2,160 hours");
      return ok({ ...(f.endpoint ? { endpoint: f.endpoint } : {}), hours });
    }
    case "serving.canary_step":
      return ok({});
    case "stream.compact":
    case "dataset.profile":
      if (!f.dataset_id) return fail(jobType === "stream.compact" ? "Choose a stream" : "Choose a dataset");
      return ok({ dataset_id: f.dataset_id });
    case "pipeline.apply":
      if (!f.pipeline_id) return fail("Choose a pipeline");
      return ok({ pipeline_id: f.pipeline_id });
    default:
      return fail(`Unknown job type ${jobType}`);
  }
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const strList = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

/** Form state from a saved schedule's params (for editing). */
export function paramsToForm(params: Record<string, unknown>): ParamsForm {
  const values = params.params && typeof params.params === "object" ? Object.fromEntries(Object.entries(params.params as Record<string, unknown>).map(([k, v]) => [k, str(v)])) : {};
  return {
    ...EMPTY_PARAMS,
    analytic_id: str(params.analytic_id),
    values,
    row_limit: params.row_limit !== undefined ? str(params.row_limit) : EMPTY_PARAMS.row_limit,
    dashboard_id: str(params.dashboard_id),
    public_link: params.public_link === undefined ? true : !!params.public_link,
    recipients: strList(params.recipients),
    chat_destinations: strList(params.chat_destinations),
    endpoint: str(params.endpoint),
    hours: params.hours !== undefined ? str(params.hours) : EMPTY_PARAMS.hours,
    dataset_id: str(params.dataset_id),
    pipeline_id: str(params.pipeline_id),
  };
}

/** Tone of a schedule's last status. */
export function lastStatusTone(status: string | null): "neutral" | "info" | "good" | "warning" | "critical" {
  switch (status) {
    case "succeeded":
      return "good";
    case "submitted":
    case "running":
    case "queued":
      return "info";
    case "skipped":
      return "warning";
    case "failed":
      return "critical";
    default:
      return "neutral";
  }
}
