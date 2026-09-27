"use client";
/** Per-table ingest details (ING-003a, ING-006, CLN-009): conversions, archive extraction, detected encoding, notes. */
import type { TableRecord } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { Badge } from "../ui";

export function tableEncoding(t: TableRecord): string | null {
  return t.source_encoding || (t.encoding && t.encoding.toLowerCase() !== "utf-8" ? t.encoding : null);
}

export function IngestNotes({ tables, compact }: { tables: TableRecord[]; compact?: boolean }) {
  const interesting = tables.filter((t) => t.source_format || tableEncoding(t) || t.notes?.length || tables.length > 1);
  if (!interesting.length) return null;
  return (
    <ul className="space-y-1 text-xs" aria-label="Ingest details">
      {interesting.map((t) => {
        const enc = tableEncoding(t);
        return (
          <li key={t.name} className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono font-medium">{t.name}</span>
            {t.source_format && t.source_format !== t.format ? (
              <Badge tone="info">
                {t.source_format} → {t.format}
              </Badge>
            ) : (
              <Badge>{t.format}</Badge>
            )}
            {enc && (
              <Badge tone="warning">
                encoding: {enc}
                {t.source_encoding ? " → UTF-8" : ""}
              </Badge>
            )}
            {!compact && t.row_count ? <span className="text-[var(--text-2)]">{t.row_count.toLocaleString()} rows</span> : null}
            {!compact && <span className="text-[var(--text-2)]">{formatBytes(t.size_bytes)}</span>}
            {t.original_filename && t.original_filename !== t.name && <span className="text-[var(--text-2)]">from {t.original_filename}</span>}
            {t.notes?.map((n, i) => (
              <span key={i} className="block w-full text-[var(--text-2)]">
                ℹ {n}
              </span>
            ))}
          </li>
        );
      })}
    </ul>
  );
}
