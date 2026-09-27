"use client";
/** Upload the next version of a dataset (INF-007/008): append rows or replace tables, then review the column diff. */
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type DatasetRecord } from "@/lib/api";
import { MAX_DATASET_BYTES, TOO_LARGE_MESSAGE } from "@/lib/constants";
import { useToast } from "@/lib/toast";
import { FileDrop } from "../FileDrop";
import { SchemaDiffView } from "../SchemaDiffView";
import { Card, ProgressBar } from "../ui";
import { IngestNotes } from "./IngestNotes";

export function AddVersion({ dataset }: { dataset: DatasetRecord }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [progress, setProgress] = useState<number | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => {
      if (file.size > MAX_DATASET_BYTES) throw new Error(TOO_LARGE_MESSAGE);
      return api.datasets.uploadVersion(dataset.id, file, mode, (p) => setProgress(p.total ? p.loaded / p.total : null));
    },
    meta: { errorPrefix: "New version not uploaded" },
    onSettled: () => setProgress(null),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["versions", dataset.id] });
      qc.invalidateQueries({ queryKey: ["dataset", dataset.id] });
      qc.invalidateQueries({ queryKey: ["datasets"] });
      qc.setQueryData(["inference", dataset.id], r.inference);
      toast.success(`Created v${r.dataset.version} (${r.mode})`);
    },
  });
  const r = upload.data;
  return (
    <Card title="Add a version">
      <fieldset className="mb-3">
        <legend className="mb-1 text-xs font-medium text-[var(--text-2)]">Mode</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {(
            [
              ["append", "Append", "Add the file's rows to the matching table; other tables are carried over."],
              ["replace", "Replace", "Keep only the file's tables."],
            ] as const
          ).map(([value, label, help]) => (
            <label key={value} className="flex max-w-sm items-start gap-2">
              <input type="radio" name="version-mode" className="mt-1 accent-brand-600" value={value} checked={mode === value} onChange={() => setMode(value)} />
              <span>
                {label}
                <span className="block text-xs text-[var(--text-2)]">{help}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <FileDrop multiple={false} disabled={upload.isPending} onFiles={(f) => upload.mutate(f[0])} label={`Drop a file to create v${dataset.latest_version + 1}`} hint="Same formats as a new upload. Columns whose type didn't change keep their confirmed definitions and annotations." />
      {upload.isPending && <ProgressBar className="mt-2" value={progress ?? 1} label="Upload progress for the new version" />}
      {r && (
        <div className="mt-4 space-y-3" aria-live="polite">
          <p className="text-sm">
            ✓ v{r.previous_version} →{" "}
            <Link href={`/datasets/${dataset.id}?version=${r.dataset.version}&tab=schema`} className="font-medium text-brand-600 underline dark:text-brand-300">
              v{r.dataset.version}
            </Link>{" "}
            ({r.mode})
          </p>
          <IngestNotes tables={r.dataset.tables} />
          <SchemaDiffView diff={r.diff} caption="Column changes in the new version" />
          {r.inference.warnings.length > 0 && (
            <ul className="text-xs text-amber-800 dark:text-amber-300">
              {r.inference.warnings.map((w, i) => (
                <li key={i}>⚠ {w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
