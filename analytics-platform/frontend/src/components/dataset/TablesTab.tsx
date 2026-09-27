"use client";
/** Multi-table datasets (INF-004/005): table picker with preview, ingest details and the relationship diagram. */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DatasetRecord, type InferenceResult } from "@/lib/api";
import { toRecords } from "@/lib/data";
import { formatBytes } from "@/lib/format";
import { quoteIdent } from "@/lib/sql";
import { DataGrid } from "../DataGrid";
import { EntityDiagram } from "../EntityDiagram";
import { Card, EmptyState, KeyValue, QueryState, SelectField } from "../ui";
import { IngestNotes, tableEncoding } from "./IngestNotes";

export function TablesTab({ dataset }: { dataset: DatasetRecord }) {
  const qc = useQueryClient();
  const [table, setTable] = useState(dataset.tables[0]?.name ?? "");
  const t = dataset.tables.find((x) => x.name === table) ?? dataset.tables[0];
  const preview = useQuery({
    queryKey: ["table-preview", dataset.id, dataset.version, t?.name],
    queryFn: () => api.datasets.query(dataset.id, `SELECT * FROM ${quoteIdent(t!.name)} LIMIT 100`, 100, dataset.version),
    enabled: !!t,
  });
  // Relationship scores are only returned by the upload; later the schema's `references` carry the FKs.
  const inference = qc.getQueryData<InferenceResult>(["inference", dataset.id]);

  if (!t) return <EmptyState title="No tables">This dataset has no stored tables.</EmptyState>;
  return (
    <div className="space-y-4">
      <Card title={`Tables (${dataset.tables.length})`}>
        <div className="grid gap-4 md:grid-cols-[minmax(0,16rem)_1fr]">
          <div className="space-y-3">
            <SelectField label="Table" value={t.name} onChange={(e) => setTable(e.target.value)} options={dataset.tables.map((x) => ({ value: x.name, label: `${x.name}${x.row_count ? ` (${x.row_count.toLocaleString()} rows)` : ""}` }))} />
            <KeyValue
              items={[
                ["Format", t.source_format && t.source_format !== t.format ? `${t.source_format} → ${t.format}` : t.format],
                ["Encoding", tableEncoding(t) ? `${tableEncoding(t)}${t.source_encoding ? " (transcoded to UTF-8)" : ""}` : "UTF-8"],
                ["Rows", t.row_count?.toLocaleString() ?? "—"],
                ["Size", formatBytes(t.size_bytes)],
                ...(t.original_filename ? ([["Original file", t.original_filename]] as [string, string][]) : []),
              ]}
            />
            <IngestNotes tables={[t]} compact />
          </div>
          <div className="min-w-0">
            <QueryState query={preview} loadingLabel="Loading preview…">
              {(r) => <DataGrid caption={`First rows of ${t.name}`} columns={r.columns} rows={toRecords(r)} pageSize={10} dense />}
            </QueryState>
          </div>
        </div>
      </Card>
      {dataset.schema && dataset.schema.entities.length > 1 && (
        <Card title="Relationships">
          <p className="mb-3 text-xs text-[var(--text-2)]">Primary keys are detected per table; foreign keys across tables from name similarity plus ≥ 95% value containment. Edit them in the Schema tab.</p>
          <EntityDiagram schema={dataset.schema} relationships={inference?.relationships} title={`Entity diagram of ${dataset.name}`} />
        </Card>
      )}
    </div>
  );
}
