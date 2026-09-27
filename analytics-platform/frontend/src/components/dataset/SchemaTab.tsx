"use client";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type DatasetRecord, type InferenceResult, type Schema } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { SchemaEditor } from "../SchemaEditor";
import { Button, Card, EmptyState } from "../ui";

export function SchemaTab({ dataset }: { dataset: DatasetRecord }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const inference = qc.getQueryData<InferenceResult>(["inference", dataset.id]);
  const initial: Schema | null = dataset.schema ?? inference?.schema ?? null;
  const [schema, setSchema] = useState<Schema | null>(initial);
  const [dirty, setDirty] = useState(false);
  const readOnly = !can("pipelines.edit") || dataset.version !== dataset.latest_version;

  useEffect(() => {
    setSchema(dataset.schema ?? inference?.schema ?? null);
    setDirty(false);
  }, [dataset, inference]);

  const confirm = useMutation({
    mutationFn: (s: Schema) => api.datasets.putSchema(dataset.id, s),
    meta: { errorPrefix: "Schema not saved" },
    onSuccess: (rec) => {
      toast.success("Schema confirmed");
      setDirty(false);
      qc.setQueryData(["dataset", dataset.id, null], rec);
      qc.invalidateQueries({ queryKey: ["dataset", dataset.id] });
      qc.invalidateQueries({ queryKey: ["profile", dataset.id] });
      qc.invalidateQueries({ queryKey: ["datasets"] });
    },
  });

  if (!schema || !schema.entities.length)
    return <EmptyState title="No schema inferred">The file format could not be parsed. Check the upload warnings, fix the file and upload it again.</EmptyState>;

  return (
    <Card
      title="Review the inferred schema"
      actions={
        !readOnly && (
          <>
            <Button onClick={() => { setSchema(initial); setDirty(false); }} disabled={!dirty}>
              Reset
            </Button>
            <Button variant="primary" onClick={() => confirm.mutate(schema)} loading={confirm.isPending}>
              Confirm schema
            </Button>
          </>
        )
      }
    >
      <p className="mb-3 text-sm text-[var(--text-2)]">
        Check names, types and flags before confirming. Columns tagged PII are masked before any LLM call and in logs; primary keys are
        non-null and unique.
        {readOnly && dataset.version !== dataset.latest_version && " Older versions are read-only."}
      </p>
      {inference?.warnings?.length ? (
        <ul className="mb-3 space-y-1 text-xs text-amber-800 dark:text-amber-300">
          {inference.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      ) : null}
      <SchemaEditor
        schema={schema}
        reports={inference?.columns}
        readOnly={readOnly}
        onChange={(s) => {
          setSchema(s);
          setDirty(true);
        }}
      />
    </Card>
  );
}
