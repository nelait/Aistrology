"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api, type ChartSpec } from "@/lib/api";
import { AnalyticEditor, type AnalyticDraft } from "@/components/analytics/AnalyticEditor";
import { RequirePermission } from "@/components/RequirePermission";
import { PageHeader, Spinner } from "@/components/ui";

export default function NewAnalyticPage() {
  const p = useSearchParams();
  const from = p.get("from");
  const source = useQuery({ queryKey: ["analytic", from], queryFn: () => api.analytics.get(from!), enabled: !!from });

  let draft: AnalyticDraft;
  if (from) {
    if (!source.data) return <Spinner />;
    draft = { datasetId: source.data.dataset_id, name: `${source.data.name} (copy)`, sql: source.data.sql, chart: source.data.chart, parameters: source.data.parameters };
  } else {
    const chart: ChartSpec | undefined = p.get("type")
      ? { type: p.get("type")!, x: p.get("x"), y: p.get("y"), series: p.get("series"), aggregation: p.get("agg") as ChartSpec["aggregation"] }
      : undefined;
    draft = { datasetId: p.get("dataset") ?? undefined, name: p.get("name") ?? undefined, sql: p.get("sql") ?? undefined, chart };
  }

  return (
    <RequirePermission perm="analytics.create">
      <PageHeader
        breadcrumb={
          <>
            <Link href="/analytics" className="hover:underline">
              Analytics
            </Link>{" "}
            / New
          </>
        }
        title="New analytic"
      />
      <AnalyticEditor key={from ?? p.toString()} draft={draft} />
    </RequirePermission>
  );
}
