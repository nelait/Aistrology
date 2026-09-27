"use client";
import Link from "next/link";
import type { AnalyticSnapshot, DashboardSnapshot, Schedule } from "@/lib/types";
import { formatInZone } from "@/lib/cron";
import { toRecords } from "@/lib/data";
import { formatBytes, formatDate } from "@/lib/format";
import { DataGrid } from "../DataGrid";
import { Badge } from "../ui";

/** The next runs as computed by the API (`upcoming`), in the schedule's zone and in local time. */
export function UpcomingRuns({ schedule }: { schedule: Schedule }) {
  if (!schedule.enabled) return <p className="text-sm text-[var(--text-2)]">Disabled: no upcoming runs.</p>;
  const runs = schedule.upcoming ?? [];
  if (!runs.length) return <p className="text-sm text-[var(--text-2)]">No upcoming runs within the search horizon.</p>;
  return (
    <ol className="space-y-0.5 text-sm" aria-label="Next runs">
      {runs.map((r) => (
        <li key={r} className="tabular-nums">
          {formatInZone(r, schedule.timezone)} <span className="text-xs text-[var(--text-2)]">· your time {formatDate(r)}</span>
        </li>
      ))}
    </ol>
  );
}

function isAnalytic(r: unknown): r is AnalyticSnapshot {
  return !!r && typeof r === "object" && (r as { kind?: unknown }).kind === "analytic" && Array.isArray((r as { columns?: unknown }).columns);
}

function isDashboard(r: unknown): r is DashboardSnapshot {
  return !!r && typeof r === "object" && (r as { kind?: unknown }).kind === "dashboard";
}

/** `last_result` snapshot: first rows of a scheduled analytic, or the delivered dashboard. */
export function LastResult({ schedule }: { schedule: Schedule }) {
  const r = schedule.last_result;
  if (!r) return <p className="text-sm text-[var(--text-2)]">No result yet. Use “Run now” to try it.</p>;
  if (isAnalytic(r)) {
    return (
      <div className="space-y-2">
        <p className="text-sm">
          <Link href={`/analytics/${r.analytic_id}`} className="font-medium underline">
            {r.name}
          </Link>{" "}
          · {r.row_count.toLocaleString()} rows{r.truncated && <Badge tone="warning">truncated</Badge>} · {formatDate(r.at)}
        </p>
        <DataGrid columns={r.columns} rows={toRecords({ columns: r.columns, rows: r.rows })} pageSize={10} dense caption={`Last result of ${schedule.name}`} exportName={`${schedule.name}-last-result`} />
        {r.rows.length < r.row_count && <p className="text-xs text-[var(--text-2)]">Showing the first {r.rows.length} rows; recipients receive the full CSV.</p>}
      </div>
    );
  }
  if (isDashboard(r)) {
    return (
      <p className="text-sm">
        Delivered{" "}
        <Link href={`/dashboards/${r.dashboard_id}`} className="font-medium underline">
          {r.name}
        </Link>{" "}
        ({formatBytes(r.size_bytes)} HTML snapshot) · chat link: {r.link_kind === "public" ? "public link" : "in-app link"} · {formatDate(r.at)}
      </p>
    );
  }
  return <pre className="overflow-auto rounded bg-[var(--surface-2)] p-2 text-xs">{JSON.stringify(r, null, 2)}</pre>;
}
