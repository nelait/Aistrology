"use client";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type DatasetRecord, type ExportFormat, type GenerationOptions, type Job, type ParseResponse, type Schema, type SchemaFormat } from "@/lib/api";
import { saveBlob } from "@/lib/data";
import { buildDistributions, type DistributionDraft } from "@/lib/distributions";
import { DistributionSettings } from "@/components/generate/DistributionSettings";
import { SchemaHistory } from "@/components/generate/SchemaHistory";
import { useToast } from "@/lib/toast";
import { RequirePermission } from "@/components/RequirePermission";
import { SchemaEditor } from "@/components/SchemaEditor";
import { DataGrid } from "@/components/DataGrid";
import { JobProgress } from "@/components/JobProgress";
import { Badge, Button, Card, PageHeader, SelectField, TabPanel, Tabs, TextArea, TextField } from "@/components/ui";

const EXAMPLES: Record<SchemaFormat, string> = {
  json_schema: JSON.stringify(
    {
      title: "customers",
      type: "object",
      properties: {
        id: { type: "integer" },
        email: { type: "string", format: "email" },
        country: { type: "string", enum: ["US", "DE", "FR", "JP"] },
        signup_date: { type: "string", format: "date" },
        lifetime_value: { type: "number", minimum: 0, maximum: 5000 },
      },
      required: ["id", "email"],
    },
    null,
    2,
  ),
  xsd: `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="order">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="order_id" type="xs:integer"/>
        <xs:element name="amount" type="xs:decimal"/>
        <xs:element name="placed_at" type="xs:dateTime"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`,
  sql_ddl: `CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  country CHAR(2) CHECK (country IN ('US', 'DE', 'FR', 'JP')),
  tier TEXT DEFAULT 'bronze' CHECK (tier = ANY (ARRAY['bronze', 'silver', 'gold']))
);

CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  amount NUMERIC(10, 2) CHECK (amount BETWEEN 5 AND 500),
  placed_at TIMESTAMP NOT NULL
);`,
  natural_language: "An online store with customers (name, email, country) and orders (amount between 5 and 500, order date in 2025, status paid/refunded). Each customer has 0-5 orders.",
};

export default function GeneratePage() {
  return (
    <RequirePermission perm="data.write">
      <Generator />
    </RequirePermission>
  );
}

function Generator() {
  const toast = useToast();
  const qc = useQueryClient();
  const [format, setFormat] = useState<SchemaFormat>("json_schema");
  const [content, setContent] = useState(EXAMPLES.json_schema);
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [schema, setSchema] = useState<Schema | null>(null);
  const [opts, setOpts] = useState({ count: "100", seed: "42", null_rate: "0.05", cmin: "0", cmax: "5", anomaly_rate: "0" });
  const [dists, setDists] = useState<Record<string, DistributionDraft>>({});
  const built = buildDistributions(dists);
  const distErrors = Object.keys(built.errors).length;
  const [exportFormat, setExportFormat] = useState<ExportFormat>("csv");
  const [saveAs, setSaveAs] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [saved, setSaved] = useState<DatasetRecord | null>(null);
  const [refine, setRefine] = useState("");

  const options = (): GenerationOptions => ({
    count: Math.max(1, Number(opts.count) || 100),
    seed: Math.max(0, Number(opts.seed) || 0),
    null_rate: Math.min(1, Math.max(0, Number(opts.null_rate) || 0)),
    children_per_parent: [Math.max(0, Number(opts.cmin) || 0), Math.max(Number(opts.cmin) || 0, Number(opts.cmax) || 0)],
    anomaly_rate: Math.min(0.5, Math.max(0, Number(opts.anomaly_rate) || 0)),
    distributions: Object.keys(built.distributions).length ? built.distributions : undefined,
  });

  const parse = useMutation({
    mutationFn: (body: { content: string; current?: Schema }) => api.schemas.parse({ format: body.current ? "natural_language" : format, content: body.content, current: body.current }),
    meta: { errorPrefix: "Schema not parsed" },
    onSuccess: (r) => {
      setParsed(r);
      setSchema(r.schema);
      setRefine("");
      preview.reset();
    },
  });

  const preview = useMutation({ mutationFn: () => api.generate.preview(schema!, { ...options(), count: Math.min(50, options().count) }), meta: { errorPrefix: "Preview failed" } });

  const generate = useMutation({
    mutationFn: () => api.generate.run(schema!, options(), exportFormat, saveAs.trim() || undefined),
    meta: { errorPrefix: "Generation failed" },
    onSuccess: (r) => {
      if (r.kind === "file") {
        saveBlob(r.blob, r.filename);
        toast.success(`Downloaded ${r.filename}`);
      } else if (r.kind === "dataset") {
        setSaved(r.dataset);
        qc.invalidateQueries({ queryKey: ["datasets"] });
        toast.success(`Saved dataset “${r.dataset.name}”`);
      } else {
        setJob(r.job);
        toast.toast("Large run: generating in the background");
      }
    },
  });

  const setOpt = (k: keyof typeof opts) => (e: React.ChangeEvent<HTMLInputElement>) => setOpts((o) => ({ ...o, [k]: e.target.value }));

  return (
    <div className="space-y-5">
      <PageHeader title="Sample data generator" description="Turn a JSON Schema, XSD, SQL DDL or a plain-English description into realistic sample data." />

      <Card title="1. Schema input">
        <Tabs
          label="Schema format"
          active={format}
          onChange={(id) => {
            setFormat(id as SchemaFormat);
            setContent(EXAMPLES[id as SchemaFormat]);
          }}
          tabs={[
            { id: "json_schema", label: "JSON Schema" },
            { id: "xsd", label: "XSD" },
            { id: "sql_ddl", label: "SQL DDL" },
            { id: "natural_language", label: "Natural language" },
          ]}
        />
        <TabPanel id={format}>
          <TextArea
            label={format === "natural_language" ? "Describe your data" : format === "sql_ddl" ? "CREATE TABLE statements" : "Schema"}
            hint={format === "sql_ddl" ? "PostgreSQL, MySQL/MariaDB, SQLite, SQL Server, BigQuery or Snowflake. Keys, REFERENCES, ENUM and CHECK constraints are mapped; DEFAULT is ignored." : undefined}
            mono={format !== "natural_language"}
            rows={format === "natural_language" ? 4 : 12}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={() => parse.mutate({ content })} loading={parse.isPending} disabled={!content.trim()}>
              Parse schema
            </Button>
            {format !== "natural_language" && (
              <label className="cursor-pointer rounded-md border border-[var(--border)] px-3.5 py-2 text-sm hover:bg-[var(--surface-2)]">
                Load file…
                <input
                  type="file"
                  className="sr-only"
                  accept={format === "xsd" ? ".xsd,.xml" : format === "sql_ddl" ? ".sql,.ddl,.txt" : ".json"}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) setContent(await f.text());
                  }}
                />
              </label>
            )}
          </div>
        </TabPanel>
      </Card>

      {schema && (
        <Card title="2. Review schema">
          {parsed?.warnings?.length ? (
            <ul className="mb-3 space-y-1 text-xs">
              {parsed.warnings.map((w, i) => (
                <li key={i} className={w.severity === "error" ? "text-red-700 dark:text-red-400" : "text-amber-800 dark:text-amber-300"}>
                  ⚠ {w.path ? <span className="font-mono">{w.path}: </span> : null}
                  {w.message}
                </li>
              ))}
            </ul>
          ) : null}
          <SchemaEditor schema={schema} onChange={setSchema} />
          <form
            className="mt-4 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (refine.trim()) parse.mutate({ content: refine, current: schema });
            }}
          >
            <TextField className="min-w-64 flex-1" label="Refine with an instruction" placeholder="Add a loyalty_tier field with bronze/silver/gold" value={refine} onChange={(e) => setRefine(e.target.value)} />
            <Button type="submit" loading={parse.isPending} disabled={!refine.trim()}>
              Apply
            </Button>
          </form>
        </Card>
      )}

      {schema && (
        <Card title="3. Options & preview">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <TextField label="Rows per root entity" type="number" min={1} max={1000000} value={opts.count} onChange={setOpt("count")} />
            <TextField label="Seed" type="number" min={0} value={opts.seed} onChange={setOpt("seed")} hint="Same seed → same data" />
            <TextField label="Null rate" type="number" min={0} max={1} step={0.01} value={opts.null_rate} onChange={setOpt("null_rate")} hint="For nullable fields" />
            <TextField label="Children per parent (min)" type="number" min={0} value={opts.cmin} onChange={setOpt("cmin")} />
            <TextField label="Children per parent (max)" type="number" min={0} max={1000} value={opts.cmax} onChange={setOpt("cmax")} />
            <TextField
              label="Anomaly rate"
              type="number"
              min={0}
              max={0.5}
              step={0.01}
              value={opts.anomaly_rate}
              onChange={setOpt("anomaly_rate")}
              hint="0–0.5: share of non-key values replaced by edge cases (out-of-range numbers, odd strings, 1900/2099 dates)"
              error={Number(opts.anomaly_rate) > 0.5 || Number(opts.anomaly_rate) < 0 ? "Must be between 0 and 0.5" : null}
            />
          </div>
          <details className="mt-4 rounded-md border border-[var(--border)] p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Value distributions {Object.keys(built.distributions).length ? `(${Object.keys(built.distributions).length} customized)` : ""}
            </summary>
            <div className="mt-3">
              <DistributionSettings schema={schema} value={dists} onChange={setDists} />
            </div>
          </details>
          {distErrors > 0 && (
            <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
              Fix {distErrors} distribution setting{distErrors === 1 ? "" : "s"} before previewing or generating.
            </p>
          )}
          <Button className="mt-3" onClick={() => preview.mutate()} loading={preview.isPending} disabled={distErrors > 0}>
            Preview 50 rows
          </Button>
          {preview.data && (
            <div className="mt-4 space-y-4">
              <p className="text-sm">
                Planned rows:{" "}
                {Object.entries(preview.data.planned_rows).map(([k, v]) => (
                  <Badge key={k} className="mr-1">
                    {k}: {v.toLocaleString()}
                  </Badge>
                ))}
              </p>
              {Object.entries(preview.data.entities).map(([entity, rows]) => (
                <div key={entity}>
                  <h3 className="mb-1 text-sm font-semibold">{entity}</h3>
                  <DataGrid columns={rows[0] ? Object.keys(rows[0]) : []} rows={rows} pageSize={10} dense caption={`Preview of ${entity}`} />
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {schema && (
        <Card title="4. Generate">
          <div className="flex flex-wrap items-end gap-3">
            <SelectField
              label="File format"
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
              options={["csv", "json", "jsonl", "parquet", "sql", "xml"].map((v) => ({ value: v, label: v.toUpperCase() }))}
            />
            <TextField label="Save as dataset (optional)" placeholder="Leave empty to download" value={saveAs} onChange={(e) => setSaveAs(e.target.value)} />
            <Button variant="primary" onClick={() => generate.mutate()} loading={generate.isPending} disabled={distErrors > 0}>
              {saveAs.trim() ? "Generate & save" : "Generate & download"}
            </Button>
          </div>
          {job && (
            <div className="mt-4">
              <JobProgress
                jobId={job.id}
                title="Generating data"
                onDone={(j) => {
                  setJob(j);
                  qc.invalidateQueries({ queryKey: ["datasets"] });
                  if (j.status === "succeeded") toast.success("Generated data saved as a dataset");
                }}
              />
              {job && typeof job.result?.dataset_id === "string" && (
                <Link href={`/datasets/${job.result.dataset_id}`} className="mt-2 inline-block text-sm text-brand-600 underline dark:text-brand-300">
                  Open dataset
                </Link>
              )}
              <p className="mt-2 text-xs text-[var(--text-2)]">
                Large runs are saved as a dataset. Track them on the <Link href="/jobs" className="underline">Jobs</Link> page.
              </p>
            </div>
          )}
          {saved && (
            <p className="mt-3 text-sm">
              ✓ Saved as{" "}
              <Link href={`/datasets/${saved.id}`} className="font-medium text-brand-600 underline dark:text-brand-300">
                {saved.name}
              </Link>
            </p>
          )}
        </Card>
      )}

      <SchemaHistory
        schema={schema}
        sourceFormat={format}
        onLoad={(s) => {
          setSchema(s);
          setParsed(null);
          preview.reset();
        }}
      />
    </div>
  );
}
