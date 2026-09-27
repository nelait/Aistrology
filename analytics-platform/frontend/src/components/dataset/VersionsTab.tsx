"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api, type DatasetRecord } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/format";
import { Badge, Card, QueryState } from "../ui";

/** Version lineage (PIP-007). */
export function VersionsTab({ dataset }: { dataset: DatasetRecord }) {
  const q = useQuery({ queryKey: ["versions", dataset.id], queryFn: () => api.datasets.versions(dataset.id) });
  return (
    <Card title="Versions & lineage" bodyClassName="p-0">
      <QueryState query={q}>
        {(versions) => (
          <ol className="divide-y divide-[var(--border)]">
            {[...versions]
              .sort((a, b) => b.version - a.version)
              .map((v) => (
                <li key={v.version} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <Badge tone={v.version === dataset.version ? "info" : "neutral"}>v{v.version}</Badge>
                  <span className="min-w-0 flex-1">
                    {v.parent_version ? (
                      <>
                        derived from <strong>v{v.parent_version}</strong>
                        {v.pipeline_id && (
                          <>
                            {" "}
                            by pipeline{" "}
                            <Link href={`/pipelines/${v.pipeline_id}`} className="font-mono text-xs text-brand-600 underline dark:text-brand-300">
                              {v.pipeline_id.slice(0, 12)}
                            </Link>
                          </>
                        )}
                      </>
                    ) : (
                      <>original ({v.source})</>
                    )}
                  </span>
                  <span className="text-xs text-[var(--text-2)]">
                    {v.tables.map((t) => (t.row_count ? `${t.row_count.toLocaleString()} rows` : t.format)).join(", ")} · {formatBytes(v.size_bytes)} · {formatDate(v.created_at)} · {v.created_by}
                  </span>
                  <Link href={`/datasets/${dataset.id}?version=${v.version}&tab=profile`} className="text-xs text-brand-600 underline dark:text-brand-300">
                    Open
                  </Link>
                </li>
              ))}
          </ol>
        )}
      </QueryState>
    </Card>
  );
}
