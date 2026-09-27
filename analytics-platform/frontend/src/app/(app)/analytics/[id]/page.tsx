"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type Analytic } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toRecords } from "@/lib/data";
import { ChartView } from "@/components/charts/ChartView";
import { DataGrid } from "@/components/DataGrid";
import { Button, Card, CodeBlock, PageHeader, QueryState, TextField } from "@/components/ui";

export default function AnalyticPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ["analytic", id], queryFn: () => api.analytics.get(id) });
  return <QueryState query={q}>{(a) => <AnalyticView analytic={a} />}</QueryState>;
}

function AnalyticView({ analytic }: { analytic: Analytic }) {
  const { can } = useAuth();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(analytic.parameters.map((p) => [p.name, p.default === null ? "" : String(p.default)])));
  const params = () => Object.fromEntries(analytic.parameters.map((p) => [p.name, p.type === "number" && values[p.name] !== "" ? Number(values[p.name]) : values[p.name] || null]));
  const run = useMutation({ mutationFn: () => api.analytics.run(analytic.id, params()), meta: { errorPrefix: "Run failed" } });
  const initial = useQuery({ queryKey: ["analytic-run", analytic.id], queryFn: () => api.analytics.run(analytic.id, params()) });
  const result = run.data ?? initial.data;
  const rows = useMemo(() => toRecords(result), [result]);

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumb={
          <>
            <Link href="/analytics" className="hover:underline">
              Analytics
            </Link>{" "}
            / {analytic.name}
          </>
        }
        title={analytic.name}
        actions={
          can("analytics.create") && (
            <Link href={`/analytics/new?from=${analytic.id}`} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]">
              Duplicate &amp; edit
            </Link>
          )
        }
      />
      {analytic.parameters.length > 0 && (
        <Card title="Parameters">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run.mutate();
            }}
          >
            {analytic.parameters.map((p) => (
              <TextField
                key={p.name}
                label={p.name}
                type={p.type === "number" ? "number" : p.type === "date" ? "date" : "text"}
                value={values[p.name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
              />
            ))}
            <Button type="submit" variant="primary" loading={run.isPending}>
              Run
            </Button>
          </form>
        </Card>
      )}
      <Card title="Chart">
        {initial.isLoading && !run.data ? (
          <p className="text-sm text-[var(--text-2)]">Running…</p>
        ) : result ? (
          <div className="h-[420px]">
            <ChartView rows={rows} columns={result.columns} spec={analytic.chart} height={370} title={analytic.name} />
          </div>
        ) : null}
      </Card>
      {result && (
        <Card title="Data">
          <DataGrid columns={result.columns} rows={rows} exportName={analytic.name} caption="Analytic data" />
        </Card>
      )}
      <Card title="SQL">
        <CodeBlock code={analytic.sql} />
      </Card>
    </div>
  );
}
