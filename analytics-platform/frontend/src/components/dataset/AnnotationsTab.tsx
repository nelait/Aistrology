"use client";
/** Column annotations editor (ANA-010): pii / sensitive / derived / target / id per column. */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, COLUMN_ANNOTATIONS, type ColumnAnnotation, type DatasetRecord } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { Badge, Button, Card, EmptyState, QueryState, SelectField } from "../ui";

const HELP: Record<ColumnAnnotation, string> = {
  pii: "Personal data: masked before reaching an LLM",
  sensitive: "Confidential: also treated as PII",
  derived: "Computed from other columns",
  target: "Label / outcome to predict",
  id: "Identifier, not a feature",
};

export function AnnotationsTab({ dataset }: { dataset: DatasetRecord }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const editable = can("pipelines.edit");
  const entities = dataset.schema?.entities ?? [];
  const [entity, setEntity] = useState(entities[0]?.name ?? "");
  const q = useQuery({ queryKey: ["annotations", dataset.id, dataset.version], queryFn: () => api.datasets.annotations(dataset.id, dataset.version), enabled: entities.length > 0 });
  const [draft, setDraft] = useState<Record<string, ColumnAnnotation[]>>({});
  const current = useMemo(() => q.data?.annotations?.[entity] ?? {}, [q.data, entity]);
  useEffect(() => setDraft(current), [current]);
  const fields = entities.find((e) => e.name === entity)?.fields ?? [];
  const dirty = JSON.stringify(normalize(draft)) !== JSON.stringify(normalize(current));

  const save = useMutation({
    mutationFn: () =>
      api.datasets.putAnnotations(dataset.id, {
        entity: entities.length > 1 ? entity : undefined,
        version: dataset.version,
        replace: true,
        // send every column so removed annotations are cleared
        columns: Object.fromEntries(fields.map((f) => [f.name, draft[f.name] ?? []])),
      }),
    meta: { errorPrefix: "Annotations not saved" },
    onSuccess: (r) => {
      qc.setQueryData(["annotations", dataset.id, dataset.version], r);
      qc.invalidateQueries({ queryKey: ["dataset", dataset.id] });
      toast.success("Annotations saved");
    },
  });

  if (!entities.length) return <EmptyState title="No schema yet">Confirm the dataset schema before annotating columns.</EmptyState>;

  const toggle = (col: string, a: ColumnAnnotation) =>
    setDraft((d) => {
      const has = (d[col] ?? []).includes(a);
      return { ...d, [col]: has ? (d[col] ?? []).filter((x) => x !== a) : [...(d[col] ?? []), a] };
    });

  return (
    <Card
      title="Column annotations"
      actions={
        editable && (
          <>
            <Button size="sm" onClick={() => setDraft(current)} disabled={!dirty}>
              Reset
            </Button>
            <Button size="sm" variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
              Save annotations
            </Button>
          </>
        )
      }
    >
      <p className="mb-3 text-sm text-[var(--text-2)]">
        Annotations are stored on this version&apos;s schema. <strong>pii</strong> and <strong>sensitive</strong> also flag the column as PII; annotations never clear an existing PII flag (edit the schema for that).
      </p>
      {entities.length > 1 && <SelectField className="mb-3 max-w-xs" label="Entity (table)" value={entity} onChange={(e) => setEntity(e.target.value)} options={entities.map((e) => ({ value: e.name, label: e.name }))} />}
      <QueryState query={q}>
        {() => (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Annotations per column of {entity}</caption>
              <thead className="bg-[var(--surface-2)] text-xs">
                <tr>
                  <th scope="col" className="px-3 py-2">Column</th>
                  {COLUMN_ANNOTATIONS.map((a) => (
                    <th key={a} scope="col" className="px-3 py-2 text-center" title={HELP[a]}>
                      {a}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => (
                  <tr key={f.name} className="border-t border-[var(--border)]">
                    <th scope="row" className="px-3 py-1.5 text-left font-normal">
                      <span className="font-mono text-xs">{f.name}</span> <span className="text-xs text-[var(--text-2)]">{f.type}</span>
                      {f.pii && (
                        <Badge tone="warning" className="ml-1">
                          PII
                        </Badge>
                      )}
                    </th>
                    {COLUMN_ANNOTATIONS.map((a) => (
                      <td key={a} className="px-3 py-1.5 text-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-brand-600"
                          aria-label={`${f.name}: ${a} (${HELP[a]})`}
                          checked={(draft[f.name] ?? []).includes(a)}
                          disabled={!editable}
                          onChange={() => toggle(f.name, a)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>
    </Card>
  );
}

function normalize(d: Record<string, ColumnAnnotation[]>): Record<string, ColumnAnnotation[]> {
  return Object.fromEntries(
    Object.entries(d)
      .filter(([, v]) => v.length)
      .map(([k, v]) => [k, [...v].sort()])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
}
