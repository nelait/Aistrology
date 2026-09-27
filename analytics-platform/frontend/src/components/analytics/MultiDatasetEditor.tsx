"use client";
/** LLM-008: query several datasets by alias, and ask for join suggestions with key-overlap scores. */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type ChartSpec, type DatasetRecord, type Suggestion } from "@/lib/api";
import { aliasMap, MAX_DATASETS, suggestAlias, validateAliases, type AliasEntry } from "@/lib/aliases";
import { schemaColumns, toRecords } from "@/lib/data";
import { formatPercent } from "@/lib/format";
import { ChartView } from "../charts/ChartView";
import { DataGrid } from "../DataGrid";
import { SqlEditor } from "../SqlEditor";
import { suggestionChart } from "../dataset/SuggestionsTab";
import { Badge, Button, Card, CodeBlock, EmptyState, ProgressBar, SelectField, Spinner, TextField, cx } from "../ui";
import { ChartConfig } from "./ChartConfig";
import { FeedbackButtons, PreferencesCard, type Verdict } from "./SuggestionFeedback";

function exampleSql(entries: AliasEntry[], datasets: DatasetRecord[]): string {
  if (!entries.length) return "";
  const first = entries[0].alias || "t1";
  if (entries.length === 1) return `SELECT *\nFROM ${first}\nLIMIT 100`;
  const second = entries[1].alias || "t2";
  const colsA = schemaColumns(datasets.find((d) => d.id === entries[0].datasetId)?.schema).map((c) => c.name);
  const colsB = new Set(schemaColumns(datasets.find((d) => d.id === entries[1].datasetId)?.schema).map((c) => c.name));
  const key = colsA.find((c) => colsB.has(c) && /(^id$|_id$|_key$)/i.test(c)) ?? colsA.find((c) => colsB.has(c)) ?? "id";
  return `SELECT a.*, b.*\nFROM ${first} a\nJOIN ${second} b ON a.${key} = b.${key}\nLIMIT 100`;
}

export function MultiDatasetEditor() {
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api.datasets.list() });
  const list = useMemo(() => (datasets.data ?? []).filter((d) => d.tables.length <= 1), [datasets.data]);
  const [entries, setEntries] = useState<AliasEntry[]>([]);
  const [sql, setSql] = useState("");
  const [chart, setChart] = useState<ChartSpec>({ type: "bar" });
  const [question, setQuestion] = useState("");
  const [verdicts, setVerdicts] = useState<Record<number, Verdict>>({});

  const validation = validateAliases(entries, 1);
  const suggestValidation = validateAliases(entries, 2);
  const columns = useMemo(
    () => entries.flatMap((e) => schemaColumns(list.find((d) => d.id === e.datasetId)?.schema).map((c) => ({ name: c.name, type: `${e.alias} · ${c.type}` }))),
    [entries, list],
  );

  const run = useMutation({
    mutationFn: () => api.analytics.multiQuery(aliasMap(entries), sql, 5000),
    meta: { errorPrefix: "Query failed" },
  });
  const suggest = useMutation({
    mutationFn: () => api.analytics.multiSuggestions(aliasMap(entries), question.trim() || undefined),
    meta: { errorPrefix: "Suggestions failed" },
    onSuccess: () => setVerdicts({}),
  });
  const rows = useMemo(() => (run.data ? toRecords(run.data) : []), [run.data]);
  const notConfirmed = entries.filter((e) => {
    const d = list.find((x) => x.id === e.datasetId);
    return d && !d.schema?.entities?.length;
  });

  const add = () => {
    const d = list.find((x) => !entries.some((e) => e.datasetId === x.id));
    setEntries((es) => [...es, { alias: d ? suggestAlias(d.name, es.map((e) => e.alias)) : suggestAlias(`t${es.length + 1}`, es.map((e) => e.alias)), datasetId: d?.id ?? "" }]);
  };
  const patch = (i: number, p: Partial<AliasEntry>) => setEntries((es) => es.map((e, j) => (j === i ? { ...e, ...p } : e)));

  const applySuggestion = (s: Suggestion) => {
    setSql(s.sql);
    const c = suggestionChart(s);
    setChart(c);
    run.reset();
  };

  if (datasets.isLoading) return <Spinner label="Loading datasets…" />;
  if (!list.length) return <EmptyState title="No single-table datasets">Only single-table datasets can be joined. Upload a dataset first.</EmptyState>;

  return (
    <div className="space-y-5">
      <Card
        title="Datasets"
        actions={
          <Button size="sm" onClick={add} disabled={entries.length >= MAX_DATASETS}>
            + Add dataset
          </Button>
        }
      >
        <p className="mb-3 text-sm text-[var(--text-2)]">Each dataset becomes a table named by its alias. Aliases use lowercase letters, digits and underscores and can&apos;t be SQL keywords. Up to {MAX_DATASETS} datasets.</p>
        {entries.length === 0 ? (
          <EmptyState title="No datasets yet" action={<Button onClick={add}>+ Add dataset</Button>}>
            Add two or more datasets to join them, or one to query it by alias.
          </EmptyState>
        ) : (
          <ul className="space-y-2">
            {entries.map((e, i) => (
              <li key={i} className="grid items-start gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto]">
                <SelectField
                  label={`Dataset ${i + 1}`}
                  value={e.datasetId}
                  onChange={(ev) => {
                    const d = list.find((x) => x.id === ev.target.value);
                    patch(i, { datasetId: ev.target.value, ...(d ? { alias: suggestAlias(d.name, entries.filter((_, j) => j !== i).map((x) => x.alias)) } : {}) });
                  }}
                  options={list.map((d) => ({ value: d.id, label: `${d.name} (v${d.latest_version})` }))}
                  placeholder="Choose a dataset…"
                />
                <TextField label="Alias" className="font-mono" value={e.alias} onChange={(ev) => patch(i, { alias: ev.target.value })} error={validation.errors[i]} spellCheck={false} autoComplete="off" />
                <Button size="sm" variant="ghost" className="sm:mt-5" onClick={() => setEntries((es) => es.filter((_, j) => j !== i))} aria-label={`Remove dataset ${i + 1}`}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {validation.formError && entries.length > 0 && <p className="mt-2 text-xs text-red-700 dark:text-red-400">{validation.formError}</p>}
      </Card>

      {entries.length > 0 && (
        <Card
          title="SQL across datasets"
          actions={
            <Button size="sm" onClick={() => setSql(exampleSql(entries, list))} disabled={!validation.valid}>
              Insert example
            </Button>
          }
        >
          <SqlEditor key={entries.map((e) => e.alias).join(",")} value={sql} onChange={setSql} columns={columns} tables={entries.map((e) => e.alias).filter(Boolean)} onRun={() => validation.valid && sql.trim() && run.mutate()} label="Multi-dataset SQL" />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => run.mutate()} loading={run.isPending} disabled={!validation.valid || !sql.trim()}>
              Run
            </Button>
            <span className="text-xs text-[var(--text-2)]">Read-only SELECT, same sandbox rules as single-dataset queries. Tables: {entries.map((e) => e.alias).join(", ")}</span>
          </div>
          {run.isError && (
            <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
              {run.error instanceof Error ? run.error.message : String(run.error)}
            </p>
          )}
        </Card>
      )}

      {run.data && (
        <>
          <Card title="Visualization">
            <ChartConfig spec={chart} onChange={setChart} columns={run.data.columns} />
            {rows.length > 0 && (
              <div className="mt-4 h-96">
                <ChartView rows={rows} columns={run.data.columns} spec={chart} height={340} title="multi-dataset query" />
              </div>
            )}
          </Card>
          <Card title={<span className="flex items-center gap-2">Results ({run.data.row_count.toLocaleString()} rows) {run.data.truncated && <Badge tone="warning">truncated</Badge>}</span>}>
            <DataGrid columns={run.data.columns} rows={rows} exportName="multi-dataset-query" caption="Multi-dataset query results" />
          </Card>
        </>
      )}

      {entries.length > 0 && (
        <Card title="Suggest joins and analytics">
          {entries.length < 2 ? (
            <p className="text-sm text-[var(--text-2)]">Add at least two datasets to get join suggestions.</p>
          ) : (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                suggest.mutate();
              }}
            >
              <TextField className="min-w-64 flex-1" label="Question (optional)" placeholder="Which customers generate the most revenue?" value={question} onChange={(e) => setQuestion(e.target.value)} />
              <Button type="submit" variant="primary" loading={suggest.isPending} disabled={!suggestValidation.valid || notConfirmed.length > 0}>
                Suggest joins
              </Button>
            </form>
          )}
          {notConfirmed.length > 0 && (
            <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">Confirm the schema of {notConfirmed.map((e) => e.alias).join(", ")} first (dataset → Schema tab).</p>
          )}
          <p className="mt-2 text-xs text-[var(--text-2)]">Table context is sent to the LLM according to your organization&apos;s data-minimization level. Every suggested query is validated and previewed in the sandbox.</p>
        </Card>
      )}

      {suggest.isPending && <Spinner label="Looking for join keys and analytics…" />}
      {suggest.data && (
        <>
          <Card title={`Join candidates (${suggest.data.join_candidates.length})`}>
            {suggest.data.join_candidates.length === 0 ? (
              <p className="text-sm text-[var(--text-2)]">No key-like column pairs with compatible types were found.</p>
            ) : (
              <ul className="space-y-2">
                {[...suggest.data.join_candidates]
                  .sort((a, b) => b.containment - a.containment)
                  .map((j, i) => (
                    <li key={i} className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto]">
                      <code className="font-mono text-xs">
                        {j.left_table}.{j.left_column} → {j.right_table}.{j.right_column}
                      </code>
                      <span className="flex items-center gap-2">
                        <ProgressBar value={j.containment} label={`Overlap of ${j.left_table}.${j.left_column} in ${j.right_table}.${j.right_column}`} />
                        <span className={cx("w-12 text-right text-xs tabular-nums", j.containment < 0.5 && "text-amber-800 dark:text-amber-300")}>{formatPercent(j.containment, 0)}</span>
                      </span>
                      <Button
                        size="sm"
                        onClick={() => setSql(`SELECT *\nFROM ${j.left_table} l\nJOIN ${j.right_table} r ON l."${j.left_column}" = r."${j.right_column}"\nLIMIT 100`)}
                      >
                        Use in SQL
                      </Button>
                    </li>
                  ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-[var(--text-2)]">Overlap = share of distinct left values found on the right. Low overlap means many rows won&apos;t match an inner join.</p>
          </Card>
          {suggest.data.suggestions.length === 0 ? (
            <EmptyState title="No suggestions">Try a more specific question.</EmptyState>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {suggest.data.suggestions.map((s, i) =>
                verdicts[i] === "rejected" ? null : (
                  <Card
                    key={i}
                    title={
                      <span className="flex flex-wrap items-center gap-2">
                        {s.title} <Badge>{s.category}</Badge> {!s.valid && <Badge tone="critical">✕ SQL invalid</Badge>}
                      </span>
                    }
                  >
                    <p className="mb-3 text-sm text-[var(--text-2)]">{s.rationale}</p>
                    {s.preview?.length ? (
                      <div className="h-64">
                        <ChartView rows={s.preview} spec={suggestionChart(s)} height={220} title={s.title} />
                      </div>
                    ) : (
                      <p className="text-sm text-[var(--text-2)]">{s.validation_error ?? "No preview rows."}</p>
                    )}
                    <details className="mt-3">
                      <summary className="cursor-pointer text-sm font-medium">Show SQL</summary>
                      <div className="mt-2">
                        <CodeBlock code={s.sql} label="Suggested SQL" />
                      </div>
                    </details>
                    <div className="mt-3">
                      <FeedbackButtons
                        datasetId={entries[0].datasetId}
                        suggestion={s}
                        verdict={verdicts[i]}
                        acceptLabel="Accept & open in SQL"
                        acceptDisabled={!s.valid}
                        onVerdict={(v) => setVerdicts((x) => ({ ...x, [i]: v }))}
                        onAccept={() => applySuggestion(s)}
                      />
                    </div>
                  </Card>
                ),
              )}
            </div>
          )}
        </>
      )}
      <PreferencesCard />
    </div>
  );
}
