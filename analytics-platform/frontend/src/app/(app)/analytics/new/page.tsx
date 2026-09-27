"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api, type ChartSpec } from "@/lib/api";
import { AnalyticEditor, type AnalyticDraft } from "@/components/analytics/AnalyticEditor";
import { MultiDatasetEditor } from "@/components/analytics/MultiDatasetEditor";
import { RequirePermission } from "@/components/RequirePermission";
import { PageHeader, Spinner, TabPanel, Tabs } from "@/components/ui";

export default function NewAnalyticPage() {
  const p = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const multi = p.get("mode") === "multi";
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
        description={multi ? "Join up to five datasets by alias, run SQL across them and get join suggestions." : undefined}
      />
      <Tabs
        label="Analytic mode"
        className="mb-4"
        active={multi ? "multi" : "single"}
        onChange={(m) => router.replace(m === "multi" ? `${pathname}?mode=multi` : pathname, { scroll: false })}
        tabs={[
          { id: "single", label: "Single dataset" },
          { id: "multi", label: "Multiple datasets" },
        ]}
      />
      <TabPanel id={multi ? "multi" : "single"}>{multi ? <MultiDatasetEditor /> : <AnalyticEditor key={from ?? p.toString()} draft={draft} />}</TabPanel>
    </RequirePermission>
  );
}
