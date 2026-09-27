"use client";
/** Cron builder (frequency / time / days) with presets and a raw-expression mode, plus a time-zone picker. */
import { useId, useMemo, useState } from "react";
import { buildCron, CRON_PRESETS, DAY_LABELS, DEFAULT_BUILDER, describeCron, listTimezones, parseBuilder, validateCron, type CronBuilder, type Frequency } from "@/lib/cron";
import { Button, SelectField, TextField, cx } from "../ui";

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays (Mon–Fri)" },
  { value: "weekly", label: "Specific days of the week" },
  { value: "monthly", label: "Monthly" },
];

export function CronField({ cron, onCron, timezone, onTimezone }: { cron: string; onCron: (c: string) => void; timezone: string; onTimezone: (tz: string) => void }) {
  const [mode, setMode] = useState<"builder" | "raw">(() => (parseBuilder(cron) ? "builder" : "raw"));
  const [builder, setBuilder] = useState<CronBuilder>(() => parseBuilder(cron) ?? DEFAULT_BUILDER);
  const zones = useMemo(() => listTimezones(), []);
  const error = validateCron(cron);
  const id = useId();

  const update = (b: CronBuilder) => {
    setBuilder(b);
    onCron(buildCron(b));
  };
  const time = `${String(builder.hour).padStart(2, "0")}:${String(builder.minute).padStart(2, "0")}`;

  return (
    <fieldset className="space-y-3 rounded-md border border-[var(--border)] p-3">
      <legend className="px-1 text-xs font-semibold">When</legend>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Presets">
        {CRON_PRESETS.map((p) => (
          <Button
            key={p.cron}
            size="sm"
            variant={cron === p.cron ? "primary" : "secondary"}
            aria-pressed={cron === p.cron}
            onClick={() => {
              onCron(p.cron);
              const b = parseBuilder(p.cron);
              if (b) {
                setBuilder(b);
                setMode("builder");
              } else setMode("raw");
            }}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <div className="flex gap-3 text-sm" role="radiogroup" aria-label="Cron editor mode">
        {(["builder", "raw"] as const).map((m) => (
          <label key={m} className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`${id}-mode`}
              className="accent-brand-600"
              checked={mode === m}
              onChange={() => {
                setMode(m);
                if (m === "builder") {
                  const b = parseBuilder(cron);
                  if (b) setBuilder(b);
                  else update(builder);
                }
              }}
            />
            {m === "builder" ? "Builder" : "Cron expression"}
          </label>
        ))}
      </div>
      {mode === "builder" ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <SelectField label="Repeat" value={builder.frequency} onChange={(e) => update({ ...builder, frequency: e.target.value as Frequency })} options={FREQUENCIES} />
          {builder.frequency === "hourly" ? (
            <TextField label="At minute" type="number" min={0} max={59} value={builder.minute} onChange={(e) => update({ ...builder, minute: Number(e.target.value) })} />
          ) : (
            <TextField
              label="At (local time in the zone)"
              type="time"
              value={time}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map(Number);
                if (Number.isFinite(h) && Number.isFinite(m)) update({ ...builder, hour: h, minute: m });
              }}
            />
          )}
          {builder.frequency === "monthly" && (
            <TextField label="Day of month" type="number" min={1} max={31} value={builder.day} onChange={(e) => update({ ...builder, day: Number(e.target.value) })} hint="Months without this day are skipped" />
          )}
          {builder.frequency === "weekly" && (
            <fieldset className="sm:col-span-3">
              <legend className="text-xs font-medium text-[var(--text-2)]">Days</legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {DAY_LABELS.map((d, i) => {
                  const checked = builder.weekdays.includes(i);
                  return (
                    <label key={d} className={cx("flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs", checked ? "border-brand-500 bg-brand-50 dark:bg-brand-900/40" : "border-[var(--border)]")}>
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-brand-600"
                        checked={checked}
                        onChange={() => update({ ...builder, weekdays: checked ? builder.weekdays.filter((x) => x !== i) : [...builder.weekdays, i] })}
                      />
                      {d.slice(0, 3)}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
        </div>
      ) : (
        <TextField
          label="Cron expression"
          value={cron}
          onChange={(e) => onCron(e.target.value)}
          className="font-mono"
          spellCheck={false}
          autoComplete="off"
          hint="minute hour day-of-month month day-of-week — e.g. 0 9 * * 1-5. Names (jan, mon) and steps (*/15) work."
          error={error}
        />
      )}
      <SelectField label="Time zone" value={timezone} onChange={(e) => onTimezone(e.target.value)} options={zones.map((z) => ({ value: z, label: z }))} hint="Daylight-saving gaps skip that day's run; repeated hours run once." />
      <p className="text-sm" aria-live="polite">
        {error && mode === "builder" ? <span className="text-red-700 dark:text-red-400">{error}</span> : !error ? <span className="text-[var(--text-2)]">{describeCron(cron)} ({timezone}) · <code className="font-mono text-xs">{cron}</code></span> : null}
      </p>
    </fieldset>
  );
}
