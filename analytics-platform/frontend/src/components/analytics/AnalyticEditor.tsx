"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AnalyticParameter, type ChartSpec } from "@/lib/api";
import { schemaColumns, toRecords } from "@/lib/data";
import { bindParameters, generateSql, sqlParameters, type QueryModel } from "@/lib/sql";
import { useToast } from "@/lib/toast";
import { ChartView } from "../charts/ChartView";
import { DataGrid } from "../DataGrid";
import { SqlEditor } from "../SqlEditor";
import { Badge, Button, Card, CodeBlock, EmptyState, SelectField, TabPanel, Tabs, TextField } from "../ui";
import { ChartConfig } from "./ChartConfig";
import { QueryBuilder } from "./QueryBuilder";

export interface AnalyticDraft {
  datasetId?: string;
  name?: string;
  sql?: string;
  chart?: ChartSpec;
  parameters?: AnalyticParameter[];
}

const EMPTY_MODEL: QueryModel = { dimensions: [], measures: [{ column: "*", aggregation: "count" }], filters: [], orderBy: null, limit: 1000 };

/** Query builder + raw SQL mode, chart picker, parameters, run & save (USR-001/003/005/006). */
export function AnalyticEditor({ draft }: { draft: AnalyticDraft }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [datasetId, setDatasetId] = useState(draft.datasetId ?? "");
  const [name, setName] = useState(draft.name ?? "");
  const [mode, setMode] = useState<"builder" | "sql">(draft.sql ? "sql" : "builder");
  const [model, setModel] = useState<QueryModel>(EMPTY_MODEL);
  const [sql, setSql] = useState(draft.sql ?? "");
  const [chart, setChart] = useState<ChartSpec>(draft.chart ?? { type: "bar" });
  const [params, setParams] = useState<AnalyticParameter[]>(draft.parameters ?? []);

  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api.datasets.list() });
  const dataset = datasets.data?.find((d) => d.id === datasetId);
  const columns = useMemo(() => schemaColumns(dataset?.schema), [dataset]);

  const effectiveSql = mode === "builder" ? generateSql(model) : sql;
  const paramNames = useMemo(() => sqlParameters(effectiveSql), [effectiveSql]);

  // keep the parameter list in sync with the SQL
  useEffect(() => {
    setParams((prev) => paramNames.map((n) => prev.find((p) => p.name === n) ?? { name: n, type: "string", default: "" }));
  }, [paramNames]);

  const run = useMutation({
    mutationFn: () => {
      const values = Object.fromEntries(params.map((p) => [p.name, p.type === "number" && p.default !== "" && p.default !== null ? Number(p.default) : p.default]));
      return api.datasets.query(datasetId, bindParameters(effectiveSql, values), 5000);
    },
    meta: { errorPrefix: "Query failed" },
  });
  const rows = useMemo(() => (run.data ? toRecords(run.data) : []), [run.data]);
  const resultCols = run.data?.columns ?? [];

  const save = useMutation({
    mutationFn: () =>
      api.analytics.create({
        dataset_id: datasetId,
        name: name.trim(),
        sql: effectiveSql,
        chart,
        parameters: params.map((p) => ({ ...p, default: p.type === "number" && p.default !== "" && p.default !== null ? Number(p.default) : p.default })),
      }),
    onSuccess: (a) => {
      toast.success("Analytic saved");
      qc.invalidateQueries({ queryKey: ["analytics"] });
      router.push(`/analytics/${a.id}`);
    },
  });

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <SelectField
            label="Dataset"
            className="min-w-64"
            value={datasetId}
            onChange={(e) => {
              setDatasetId(e.target.value);
              setModel(EMPTY_MODEL);
              run.reset();
            }}
            options={(datasets.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
            placeholder="Choose a dataset…"
          />
          <TextField label="Name" className="min-w-64 flex-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Revenue by region" />
        </div>
      </Card>

      {!datasetId ? (
        <EmptyState title="Pick a dataset to start" />
      ) : (
        <>
          <Card title="Query">
            <Tabs
              label="Query mode"
              active={mode}
              onChange={(m) => {
                if (m === "sql" && mode === "builder") setSql(generateSql(model));
                setMode(m as "builder" | "sql");
              }}
              tabs={[
                { id: "builder", label: "Builder" },
                { id: "sql", label: "SQL" },
              ]}
            />
            <TabPanel id={mode}>
              {mode === "builder" ? (
                <div className="space-y-4">
                  <QueryBuilder model={model} onChange={setModel} columns={columns} />
                  <div>
                    <p className="mb-1 text-xs font-medium text-[var(--text-2)]">Generated SQL</p>
                    <CodeBlock code={effectiveSql} label="Generated SQL" />
                  </div>
                </div>
              ) : (
                <SqlEditor value={sql} onChange={setSql} columns={columns} onRun={() => run.mutate()} />
              )}
            </TabPanel>
            {params.length > 0 && (
              <fieldset className="mt-4 space-y-2">
                <legend className="text-sm font-semibold">Parameters</legend>
                <p className="text-xs text-[var(--text-2)]">Referenced as :name in the SQL. Defaults are used for the preview and when the analytic runs without inputs.</p>
                {params.map((p, i) => (
                  <div key={p.name} className="flex flex-wrap items-end gap-2">
                    <Badge className="mb-2 font-mono">:{p.name}</Badge>
                    <SelectField
                      label="Type"
                      value={p.type}
                      onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, type: e.target.value as AnalyticParameter["type"] } : x)))}
                      options={[
                        { value: "string", label: "Text" },
                        { value: "number", label: "Number" },
                        { value: "date", label: "Date" },
                      ]}
                    />
                    <TextField
                      label="Default"
                      type={p.type === "number" ? "number" : p.type === "date" ? "date" : "text"}
                      value={p.default === null ? "" : String(p.default)}
                      onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, default: e.target.value } : x)))}
                    />
                  </div>
                ))}
              </fieldset>
            )}
            <div className="mt-4 flex gap-2">
              <Button variant="primary" onClick={() => run.mutate()} loading={run.isPending}>
                Run
              </Button>
              <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim() || !effectiveSql.trim()}>
                Save analytic
              </Button>
            </div>
          </Card>

          <Card title="Visualization">
            <ChartConfig spec={chart} onChange={setChart} columns={resultCols.length ? resultCols : columns.map((c) => c.name)} />
            <div className="mt-4">
              {run.data ? (
                <div className="h-96">
                  <ChartView rows={rows} columns={resultCols} spec={chart} height={340} title={name || "analytic"} />
                </div>
              ) : (
                <p className="text-sm text-[var(--text-2)]">Run the query to preview the chart.</p>
              )}
            </div>
          </Card>

          {run.data && (
            <Card title={<span className="flex items-center gap-2">Results {run.data.truncated && <Badge tone="warning">truncated</Badge>}</span>}>
              <DataGrid columns={resultCols} rows={rows} exportName={name || "analytic"} caption="Analytic results" />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
