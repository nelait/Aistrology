"use client";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type ChartSpec, type DatasetRecord, type Suggestion } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { ChartView } from "../charts/ChartView";
import { Badge, Button, Card, CodeBlock, EmptyState, Modal, Spinner, TextField } from "../ui";

const CATEGORY_TONE = { descriptive: "neutral", diagnostic: "info", predictive: "good", prescriptive: "warning" } as const;

export function suggestionChart(s: Suggestion): ChartSpec {
  return { type: s.chart_type, x: s.x, y: s.y, series: s.group_by?.[0] ?? null, aggregation: (s.aggregation as ChartSpec["aggregation"]) ?? null };
}

export function analyticDraftHref(datasetId: string, s: Pick<Suggestion, "title" | "sql">, chart: ChartSpec): string {
  const p = new URLSearchParams({ dataset: datasetId, name: s.title, sql: s.sql, type: String(chart.type) });
  if (chart.x) p.set("x", chart.x);
  if (chart.y) p.set("y", chart.y);
  if (chart.series) p.set("series", chart.series);
  if (chart.aggregation) p.set("agg", chart.aggregation);
  return `/analytics/new?${p.toString()}`;
}

interface Turn {
  question: string;
  suggestions: Suggestion[];
}

/** LLM-suggested analytics with accept / modify / reject and conversational refinement (LLM-001..007). */
export function SuggestionsTab({ dataset }: { dataset: DatasetRecord }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [accepting, setAccepting] = useState<Suggestion | null>(null);
  const [name, setName] = useState("");

  const ask = useMutation({
    mutationFn: (q: string) => {
      // Conversational refinement: carry the previous request as context.
      const prev = turns.filter((t) => t.question).map((t) => t.question);
      const full = prev.length && q ? `Earlier requests: ${prev.join(" | ")}. Refinement: ${q}` : q;
      return api.datasets.suggestions(dataset.id, full || undefined);
    },
    meta: { errorPrefix: "Suggestions failed" },
    onSuccess: (suggestions, q) => {
      setTurns((t) => [...t, { question: q, suggestions }]);
      setQuestion("");
    },
  });

  const save = useMutation({
    mutationFn: (s: Suggestion) => api.analytics.create({ dataset_id: dataset.id, name: name || s.title, sql: s.sql, chart: suggestionChart(s), parameters: [] }),
    onSuccess: (a) => {
      toast.success(`Saved “${a.name}” to Analytics`);
      setAccepting(null);
      qc.invalidateQueries({ queryKey: ["analytics"] });
    },
  });

  const noSchema = !dataset.schema?.entities?.length;
  const latest = turns[turns.length - 1];

  return (
    <div className="space-y-4">
      <Card title="Ask for analytics">
        {noSchema ? (
          <p className="text-sm text-amber-800 dark:text-amber-300">Confirm the dataset schema before requesting suggestions.</p>
        ) : (
          <>
            {turns.length > 0 && (
              <ol className="mb-3 space-y-1 text-sm" aria-label="Conversation">
                {turns.map((t, i) => (
                  <li key={i} className="text-[var(--text-2)]">
                    <span className="font-medium text-[var(--text)]">You:</span> {t.question || "Suggest useful analytics"} → {t.suggestions.length} suggestions
                  </li>
                ))}
              </ol>
            )}
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                ask.mutate(question.trim());
              }}
            >
              <TextField
                className="min-w-64 flex-1"
                label={turns.length ? "Refine (e.g. “break this down by region”, “compare Q1 vs Q2”)" : "Question (optional)"}
                placeholder={turns.length ? "Break this down by region" : "What drives revenue? Leave empty for general suggestions."}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
              <Button type="submit" variant="primary" loading={ask.isPending}>
                {turns.length ? "Refine" : "Suggest analytics"}
              </Button>
              {turns.length > 0 && (
                <Button onClick={() => { setTurns([]); setRejected(new Set()); }}>
                  Start over
                </Button>
              )}
            </form>
            <p className="mt-2 text-xs text-[var(--text-2)]">Sent to the LLM according to your organization&apos;s data-minimization level. PII-tagged values are masked.</p>
          </>
        )}
      </Card>

      {ask.isPending && <Spinner label="Asking the analytics assistant…" />}
      {latest && latest.suggestions.length === 0 && <EmptyState title="No suggestions">Try a more specific question.</EmptyState>}
      {latest && (
        <div className="grid gap-4 xl:grid-cols-2">
          {latest.suggestions
            .map((s, i) => ({ s, key: `${turns.length}-${i}` }))
            .filter(({ key }) => !rejected.has(key))
            .map(({ s, key }, rank) => {
              const chart = suggestionChart(s);
              return (
                <Card
                  key={key}
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-[var(--text-2)]">#{rank + 1}</span>
                      {s.title}
                      <Badge tone={CATEGORY_TONE[s.category] ?? "neutral"}>{s.category}</Badge>
                      {!s.valid && <Badge tone="critical">✕ SQL invalid</Badge>}
                    </span>
                  }
                >
                  <p className="mb-3 text-sm text-[var(--text-2)]">{s.rationale}</p>
                  {s.preview && s.preview.length > 0 ? (
                    <div className="h-64">
                      <ChartView rows={s.preview} spec={chart} height={220} title={s.title} />
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
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={!s.valid}
                      onClick={() => {
                        setAccepting(s);
                        setName(s.title);
                      }}
                    >
                      Accept
                    </Button>
                    <Link href={analyticDraftHref(dataset.id, s, chart)} className="rounded-md border border-[var(--border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface-2)]">
                      Modify
                    </Link>
                    <Button size="sm" variant="ghost" onClick={() => setRejected((r) => new Set(r).add(key))}>
                      Reject
                    </Button>
                  </div>
                </Card>
              );
            })}
        </div>
      )}

      <Modal
        open={!!accepting}
        onClose={() => setAccepting(null)}
        title="Save as analytic"
        size="sm"
        footer={
          <>
            <Button onClick={() => setAccepting(null)}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => accepting && save.mutate(accepting)}>
              Save
            </Button>
          </>
        }
      >
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      </Modal>
    </div>
  );
}
