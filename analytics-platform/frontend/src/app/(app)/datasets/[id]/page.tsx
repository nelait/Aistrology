"use client";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatBytes, formatDate } from "@/lib/format";
import { Badge, EmptyState, PageHeader, QueryState, TabPanel, Tabs } from "@/components/ui";
import { SchemaTab } from "@/components/dataset/SchemaTab";
import { ProfileTab } from "@/components/dataset/ProfileTab";
import { DataTab } from "@/components/dataset/DataTab";
import { SuggestionsTab } from "@/components/dataset/SuggestionsTab";
import { VersionsTab } from "@/components/dataset/VersionsTab";
import { TablesTab } from "@/components/dataset/TablesTab";
import { AdvancedProfileTab } from "@/components/dataset/AdvancedProfileTab";
import { AnnotationsTab } from "@/components/dataset/AnnotationsTab";
import { IngestNotes } from "@/components/dataset/IngestNotes";

const TABS = ["schema", "tables", "profile", "advanced", "annotations", "data", "suggestions", "versions"] as const;
type Tab = (typeof TABS)[number];

export default function DatasetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useAuth();
  const tab = (TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "profile";
  const versionParam = params.get("version");
  const version = versionParam ? Number(versionParam) : undefined;

  const ds = useQuery({ queryKey: ["dataset", id, version ?? null], queryFn: () => api.datasets.get(id, version) });

  const setTab = (t: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", t);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  return (
    <QueryState query={ds}>
      {(d) => (
        <div>
          <PageHeader
            breadcrumb={
              <>
                <Link href="/datasets" className="hover:underline">
                  Datasets
                </Link>{" "}
                / {d.name}
              </>
            }
            title={
              <span className="flex flex-wrap items-center gap-2">
                {d.name}
                <Badge tone="info">v{d.version}</Badge>
                {d.version !== d.latest_version && (
                  <Link href={`/datasets/${d.id}`} className="text-xs font-normal text-brand-600 underline dark:text-brand-300">
                    latest is v{d.latest_version}
                  </Link>
                )}
              </span>
            }
            description={`${d.source} · ${formatBytes(d.size_bytes)} · ${d.tables.map((t) => t.format).join(", ")} · created ${formatDate(d.created_at)}`}
            actions={
              <>
                {can("pipelines.edit") && (
                  <Link href={`/pipelines?dataset=${d.id}`} className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]">
                    Clean data
                  </Link>
                )}
                {can("analytics.create") && (
                  <Link href={`/analytics/new?dataset=${d.id}`} className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]">
                    New analytic
                  </Link>
                )}
                {can("models.train") && (
                  <Link href={`/experiments/new?dataset=${d.id}`} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
                    Train model
                  </Link>
                )}
              </>
            }
          />
          <div className="mb-3">
            <IngestNotes tables={d.tables.filter((t) => t.source_format || t.source_encoding || t.notes?.length)} compact />
          </div>
          <Tabs
            label="Dataset sections"
            active={tab}
            onChange={setTab}
            tabs={[
              { id: "schema", label: "Schema" },
              { id: "tables", label: d.tables.length > 1 ? `Tables (${d.tables.length})` : "Table" },
              { id: "profile", label: "Profile" },
              { id: "advanced", label: "Advanced profile" },
              { id: "annotations", label: "Annotations" },
              { id: "data", label: "Data (SQL)" },
              { id: "suggestions", label: "Suggestions", hidden: !can("analytics.create") },
              { id: "versions", label: "Versions" },
            ]}
          />
          <TabPanel id={tab}>
            {tab === "schema" && <SchemaTab dataset={d} />}
            {tab === "tables" && <TablesTab dataset={d} />}
            {tab === "profile" &&
              (d.tables.length > 1 ? (
                <EmptyState title="Profile a table" action={<button type="button" className="text-sm text-brand-600 underline dark:text-brand-300" onClick={() => setTab("advanced")}>Open Advanced profile</button>}>
                  This dataset has {d.tables.length} tables. The summary profile covers single-table datasets; use the Advanced profile (with a table picker) or the Tables tab.
                </EmptyState>
              ) : (
                <ProfileTab dataset={d} />
              ))}
            {tab === "advanced" && <AdvancedProfileTab dataset={d} />}
            {tab === "annotations" && <AnnotationsTab dataset={d} />}
            {tab === "data" && <DataTab dataset={d} />}
            {tab === "suggestions" && <SuggestionsTab dataset={d} />}
            {tab === "versions" && <VersionsTab dataset={d} />}
          </TabPanel>
        </div>
      )}
    </QueryState>
  );
}
