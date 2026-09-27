"use client";
/** Visual schema diff (SCH-010, INF-007/008): added / removed / changed fields with a "breaking" badge. */
import type { SchemaDiff } from "@/lib/types";
import { DIFF_LABEL, DIFF_TONE, diffSummary, flattenDiff } from "@/lib/schemaDiff";
import { Badge, cx } from "./ui";

const ICON: Record<string, string> = { good: "+", critical: "−", warning: "~", info: "•" };
const ROW_BG: Record<string, string> = {
  good: "bg-green-50/60 dark:bg-green-950/40",
  critical: "bg-red-50/60 dark:bg-red-950/40",
  warning: "bg-amber-50/60 dark:bg-amber-950/40",
  info: "",
};

export function BreakingBadge({ breaking }: { breaking: boolean }) {
  return breaking ? (
    <Badge tone="critical">
      <span aria-hidden="true">⚠</span> Breaking
    </Badge>
  ) : (
    <Badge tone="good">
      <span aria-hidden="true">✓</span> Non-breaking
    </Badge>
  );
}

export function SchemaDiffView({ diff, caption = "Schema changes" }: { diff: SchemaDiff; caption?: string }) {
  const rows = flattenDiff(diff);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <BreakingBadge breaking={diff.breaking} />
        <span className="text-[var(--text-2)]">{diffSummary(diff)}</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--text-2)]">{diff.identical ? "The schemas are identical." : "No field-level changes."}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-[var(--border)]">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead className="bg-[var(--surface-2)] text-xs">
              <tr>
                <th scope="col" className="px-3 py-2">Change</th>
                <th scope="col" className="px-3 py-2">Entity</th>
                <th scope="col" className="px-3 py-2">Field</th>
                <th scope="col" className="px-3 py-2">Details</th>
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">Breaking</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const tone = DIFF_TONE[r.kind];
                return (
                  <tr key={i} className={cx("border-t border-[var(--border)]", ROW_BG[tone])}>
                    <td className="px-3 py-1.5">
                      <Badge tone={tone}>
                        <span aria-hidden="true">{ICON[tone]}</span>
                        {DIFF_LABEL[r.kind]}
                      </Badge>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs">{r.entity}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{r.field ?? "—"}</td>
                    <td className="px-3 py-1.5 text-xs">{r.detail}</td>
                    <td className="px-3 py-1.5">{r.breaking && <Badge tone="critical">breaking</Badge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {diff.summary?.length ? (
        <details className="text-xs text-[var(--text-2)]">
          <summary className="cursor-pointer">Server summary</summary>
          <ul className="mt-1 list-disc pl-5">
            {diff.summary.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
