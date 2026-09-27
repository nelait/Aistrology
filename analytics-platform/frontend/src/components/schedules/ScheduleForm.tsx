"use client";
/** Create / edit a schedule: job type, per-type parameters, cron + time zone, enabled. */
import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Schedule, type ScheduleType } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { browserTimezone, validateCron } from "@/lib/cron";
import { buildParams, EMPTY_PARAMS, jobTypeLabel, paramsToForm, type ParamsForm } from "@/lib/schedules";
import { useToast } from "@/lib/toast";
import { useChatDestinations, useTenantUsers } from "../useDirectory";
import { Button, Checkbox, Modal, MultiSelect, SelectField, TextField } from "../ui";
import { CronField } from "./CronField";
import { UpcomingRuns } from "./UpcomingRuns";

export function ScheduleForm({ types, existing, initialJobType, initialParams, onClose }: { types: ScheduleType[]; existing?: Schedule | null; initialJobType?: string; initialParams?: Record<string, unknown>; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const allowed = types.filter((t) => t.allowed);
  const [name, setName] = useState(existing?.name ?? "");
  const [jobType, setJobType] = useState(existing?.job_type ?? initialJobType ?? allowed[0]?.job_type ?? "");
  const [cron, setCron] = useState(existing?.cron ?? "0 9 * * 1-5");
  const [timezone, setTimezone] = useState(existing?.timezone ?? browserTimezone());
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [form, setForm] = useState<ParamsForm>(() => paramsToForm(existing?.params ?? initialParams ?? {}));
  const [saved, setSaved] = useState<Schedule | null>(null);

  const analytics = useQuery({ queryKey: ["analytics"], queryFn: api.analytics.list, enabled: jobType === "analytics.scheduled_run" });
  const analytic = analytics.data?.find((a) => a.id === form.analytic_id);
  const built = buildParams(jobType, form, analytic?.parameters ?? []);
  const cronError = validateCron(cron);
  const ready = !!name.trim() && !!jobType && !cronError && !built.error;

  const save = useMutation({
    mutationFn: () => {
      const params = built.params ?? {};
      return existing
        ? api.schedules.update(existing.id, { name: name.trim(), cron, timezone, params, enabled })
        : api.schedules.create({ name: name.trim(), cron, timezone, job_type: jobType, params, enabled });
    },
    meta: { errorPrefix: existing ? "Schedule not saved" : "Schedule not created" },
    onSuccess: (s) => {
      toast.success(existing ? "Schedule saved" : "Schedule created");
      qc.invalidateQueries({ queryKey: ["schedules"] });
      qc.setQueryData(["schedule", s.id], s);
      setSaved(s);
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={existing ? `Edit “${existing.name}”` : "New schedule"}
      footer={
        saved ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!ready}>
              {existing ? "Save" : "Create schedule"}
            </Button>
          </>
        )
      }
    >
      {saved ? (
        <div className="space-y-3">
          <p className="text-sm">
            <strong>{saved.name}</strong> is {saved.enabled ? "scheduled" : "saved but disabled"}. Next runs computed by the server:
          </p>
          <UpcomingRuns schedule={saved} />
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) save.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
            <SelectField
              label="Job type"
              value={jobType}
              disabled={!!existing}
              onChange={(e) => {
                setJobType(e.target.value);
                setForm(EMPTY_PARAMS);
              }}
              options={types.filter((t) => t.allowed || t.job_type === jobType).map((t) => ({ value: t.job_type, label: `${jobTypeLabel(t.job_type)}${t.allowed ? "" : ` (needs ${t.permission})`}` }))}
              hint={types.find((t) => t.job_type === jobType)?.description}
            />
          </div>
          <ParamsFields jobType={jobType} form={form} onChange={setForm} />
          {built.error && <p className="text-xs text-amber-800 dark:text-amber-300">{built.error}</p>}
          <CronField cron={cron} onCron={setCron} timezone={timezone} onTimezone={setTimezone} />
          <Checkbox label="Enabled" hint="Disabled schedules keep their settings but never run on their own." checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {existing && existing.created_by && <OwnerNote schedule={existing} />}
        </form>
      )}
    </Modal>
  );
}

function OwnerNote({ schedule }: { schedule: Schedule }) {
  const { me } = useAuth();
  if (schedule.created_by === me?.id) return null;
  return <p className="text-xs text-[var(--text-2)]">This schedule runs as its owner ({schedule.created_by}); new parameters must be valid for them too.</p>;
}

function ParamsFields({ jobType, form, onChange }: { jobType: string; form: ParamsForm; onChange: (f: ParamsForm) => void }) {
  const set = <K extends keyof ParamsForm>(k: K, v: ParamsForm[K]) => onChange({ ...form, [k]: v });
  const analytics = useQuery({ queryKey: ["analytics"], queryFn: api.analytics.list, enabled: jobType === "analytics.scheduled_run" });
  const dashboards = useQuery({ queryKey: ["dashboards", false], queryFn: () => api.dashboards.list(false), enabled: jobType === "dashboard.deliver" });
  const endpoints = useQuery({ queryKey: ["endpoints"], queryFn: api.endpoints.list, enabled: jobType === "serving.drift_check" });
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api.datasets.list(), enabled: jobType === "stream.compact" || jobType === "dataset.profile" });
  const pipelines = useQuery({ queryKey: ["pipelines", ""], queryFn: () => api.pipelines.list(), enabled: jobType === "pipeline.apply" });
  const analytic = analytics.data?.find((a) => a.id === form.analytic_id);

  switch (jobType) {
    case "analytics.scheduled_run":
      return (
        <fieldset className="space-y-3 rounded-md border border-[var(--border)] p-3">
          <legend className="px-1 text-xs font-semibold">Analytic &amp; delivery</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label="Saved analytic"
              required
              value={form.analytic_id}
              onChange={(e) => onChange({ ...form, analytic_id: e.target.value, values: {} })}
              options={(analytics.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
              placeholder={analytics.isLoading ? "Loading…" : "Choose an analytic…"}
            />
            <TextField label="Row limit" type="number" min={1} max={10000} value={form.row_limit} onChange={(e) => set("row_limit", e.target.value)} hint="Up to 10,000 rows; the CSV attachment is capped at 10 MB" />
          </div>
          {analytic?.parameters?.length ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {analytic.parameters.map((p) => (
                <TextField
                  key={p.name}
                  label={`:${p.name} (${p.type})`}
                  type={p.type === "number" ? "number" : p.type === "date" ? "date" : "text"}
                  value={form.values[p.name] ?? ""}
                  placeholder={p.default !== null && p.default !== undefined ? `default ${String(p.default)}` : undefined}
                  onChange={(e) => set("values", { ...form.values, [p.name]: e.target.value })}
                />
              ))}
            </div>
          ) : null}
          <Recipients form={form} onChange={onChange} />
        </fieldset>
      );
    case "dashboard.deliver":
      return (
        <fieldset className="space-y-3 rounded-md border border-[var(--border)] p-3">
          <legend className="px-1 text-xs font-semibold">Dashboard &amp; delivery</legend>
          <SelectField
            label="Dashboard"
            required
            value={form.dashboard_id}
            onChange={(e) => set("dashboard_id", e.target.value)}
            options={(dashboards.data ?? []).filter((d) => d.your_role !== "viewer").map((d) => ({ value: d.id, label: d.name }))}
            placeholder={dashboards.isLoading ? "Loading…" : "Choose a dashboard you can edit…"}
          />
          <Recipients form={form} onChange={onChange} />
          <Checkbox
            label="Post a public link to chat"
            hint="When public links are enabled for the organization, chat posts get a link valid for 72 h; otherwise a link into the app."
            checked={form.public_link}
            onChange={(e) => set("public_link", e.target.checked)}
          />
        </fieldset>
      );
    case "serving.drift_check":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Endpoint" value={form.endpoint} onChange={(e) => set("endpoint", e.target.value)} options={(endpoints.data ?? []).map((e) => ({ value: e.name, label: e.name }))} placeholder="All endpoints" />
          <TextField label="Window (hours)" type="number" min={1} max={2160} value={form.hours} onChange={(e) => set("hours", e.target.value)} />
        </div>
      );
    case "serving.canary_step":
      return (
        <p className="rounded-md bg-[var(--surface-2)] p-3 text-sm">
          Evaluates every canary rollout whose next step is due and ramps, holds or rolls it back. Scheduling it (for example every 5 minutes) keeps rollouts moving across API restarts.
          No parameters.
        </p>
      );
    case "stream.compact":
    case "dataset.profile": {
      const list = (datasets.data ?? []).filter((d) => jobType !== "stream.compact" || d.source === "stream");
      return (
        <SelectField
          label={jobType === "stream.compact" ? "Stream" : "Dataset"}
          required
          value={form.dataset_id}
          onChange={(e) => set("dataset_id", e.target.value)}
          options={list.map((d) => ({ value: d.id, label: d.name }))}
          placeholder={datasets.isLoading ? "Loading…" : list.length ? "Choose…" : jobType === "stream.compact" ? "No stream datasets yet" : "No datasets"}
          hint={jobType === "stream.compact" ? "Folds buffered records into the next immutable version." : "Re-profiles the latest version."}
        />
      );
    }
    case "pipeline.apply":
      return (
        <SelectField
          label="Pipeline"
          required
          value={form.pipeline_id}
          onChange={(e) => set("pipeline_id", e.target.value)}
          options={(pipelines.data ?? []).filter((p) => !p.is_template && p.dataset_id).map((p) => ({ value: p.id, label: p.name }))}
          placeholder={pipelines.isLoading ? "Loading…" : "Choose a pipeline…"}
          hint="Applies the pipeline to its dataset and writes a new version."
        />
      );
    default:
      return null;
  }
}

/** Recipients (tenant users) and chat destinations. Admins pick from lists; others can add themselves or type user ids. */
function Recipients({ form, onChange }: { form: ParamsForm; onChange: (f: ParamsForm) => void }) {
  const { me } = useAuth();
  const { users, complete } = useTenantUsers();
  const { destinations, available } = useChatDestinations();
  const [typed, setTyped] = useState("");
  const userOptions = useMemo(() => users.filter((u) => !u.disabled).map((u) => ({ value: u.id, label: u.name ? `${u.name} <${u.email}>` : u.email })), [users]);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {complete ? (
        <MultiSelect label="Email recipients" options={userOptions} value={form.recipients} onChange={(v) => onChange({ ...form, recipients: v })} hint="Each recipient must be able to see the data; others are rejected (422)." />
      ) : (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-[var(--text-2)]">Email recipients (user ids)</legend>
          <ul className="flex flex-wrap gap-1">
            {form.recipients.map((r) => (
              <li key={r} className="flex items-center gap-1 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs">
                {r === me?.id ? "You" : <code>{r}</code>}
                <button type="button" aria-label={`Remove ${r}`} onClick={() => onChange({ ...form, recipients: form.recipients.filter((x) => x !== r) })}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <TextField label="Add user id" srOnlyLabel className="flex-1" placeholder="usr_…" value={typed} onChange={(e) => setTyped(e.target.value)} />
            <Button
              size="sm"
              disabled={!typed.trim()}
              onClick={() => {
                if (!form.recipients.includes(typed.trim())) onChange({ ...form, recipients: [...form.recipients, typed.trim()] });
                setTyped("");
              }}
            >
              Add
            </Button>
            {me && !form.recipients.includes(me.id) && (
              <Button size="sm" onClick={() => onChange({ ...form, recipients: [...form.recipients, me.id] })}>
                Add me
              </Button>
            )}
          </div>
          <p className="text-xs text-[var(--text-2)]">Only admins can browse the user directory. Recipients are always users of your organization.</p>
        </fieldset>
      )}
      {available ? (
        destinations.length ? (
          <MultiSelect label="Slack / Teams destinations" options={destinations.map((d) => ({ value: d.id, label: `${d.name} (${d.kind})` }))} value={form.chat_destinations} onChange={(v) => onChange({ ...form, chat_destinations: v })} />
        ) : (
          <p className="text-xs text-[var(--text-2)]">
            No chat destinations yet. Add Slack or Teams webhooks in{" "}
            <Link href="/admin?tab=chat" className="underline">
              Admin → Slack / Teams
            </Link>
            .
          </p>
        )
      ) : form.chat_destinations.length ? (
        <p className="text-xs text-[var(--text-2)]">Posts to {form.chat_destinations.length} chat destination(s) configured by an admin.</p>
      ) : (
        <p className="text-xs text-[var(--text-2)]">Chat destinations are managed by admins.</p>
      )}
    </div>
  );
}
