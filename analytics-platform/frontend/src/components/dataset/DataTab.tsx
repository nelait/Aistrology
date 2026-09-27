"use client";
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, type DatasetRecord } from "@/lib/api";
import { schemaColumns, toRecords } from "@/lib/data";
import { quoteIdent } from "@/lib/sql";
import { DataGrid } from "../DataGrid";
import { SqlEditor } from "../SqlEditor";
import { Badge, Button, Card, SelectField } from "../ui";

export function DataTab({ dataset }: { dataset: DatasetRecord }) {
  const columns = useMemo(() => schemaColumns(dataset.schema), [dataset.schema]);
  const [sql, setSql] = useState(() => `SELECT ${columns.slice(0, 8).map((c) => quoteIdent(c.name)).join(", ") || "*"}\nFROM data\nLIMIT 100`);
  const [limit, setLimit] = useState("1000");
  const run = useMutation({ mutationFn: () => api.datasets.query(dataset.id, sql, Number(limit), dataset.version), meta: { errorPrefix: "Query failed" } });
  const rows = useMemo(() => (run.data ? toRecords(run.data) : []), [run.data]);

  return (
    <div className="space-y-4">
      <Card
        title="SQL"
        actions={
          <>
            <SelectField
              label="Row limit"
              srOnlyLabel
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              options={["100", "1000", "5000", "10000"].map((v) => ({ value: v, label: `${Number(v).toLocaleString()} rows max` }))}
            />
            <Button variant="primary" onClick={() => run.mutate()} loading={run.isPending}>
              Run (Ctrl+Enter)
            </Button>
          </>
        }
      >
        <p className="mb-2 text-xs text-[var(--text-2)]">
          Read-only DuckDB SQL over the table <code className="font-mono">data</code>. Column names autocomplete as you type.
        </p>
        <SqlEditor value={sql} onChange={setSql} columns={columns} onRun={() => run.mutate()} />
      </Card>
      {run.data && (
        <Card
          title={
            <span className="flex items-center gap-2">
              Results <Badge>{run.data.row_count.toLocaleString()} rows</Badge>
              {run.data.truncated && <Badge tone="warning">truncated to row limit</Badge>}
            </span>
          }
        >
          <DataGrid columns={run.data.columns} rows={rows} exportName={`${dataset.name}-query`} caption="Query results" />
        </Card>
      )}
    </div>
  );
}
