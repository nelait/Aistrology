"use client";
/** Saved schema history (SCH-010): save versions, browse them, load one, and diff any two. */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Schema, type SchemaFormat } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { SchemaDiffView } from "../SchemaDiffView";
import { Badge, Button, Card, EmptyState, QueryState, SelectField, TextField, cx } from "../ui";

export function SchemaHistory({ schema, sourceFormat, onLoad }: { schema: Schema | null; sourceFormat: SchemaFormat; onLoad: (s: Schema) => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["schemas"], queryFn: () => api.schemas.list() });
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!name && schema?.name) setName(schema.name);
  }, [schema, name]);

  const save = useMutation({
    mutationFn: () => api.schemas.save({ name: name.trim(), schema: schema!, message: message.trim() || undefined, source_format: sourceFormat }),
    meta: { errorPrefix: "Schema not saved" },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["schemas"] });
      qc.invalidateQueries({ queryKey: ["schema", r.schema_record.id] });
      setSelected(r.schema_record.id);
      setMessage("");
      toast.success(r.created ? `Saved “${r.schema_record.name}” v${r.version}` : `No changes since v${r.version}; nothing saved`);
    },
  });

  return (
    <Card title="Schema history">
      {can("pipelines.edit") && schema && (
        <form
          className="mb-4 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <TextField className="min-w-48" label="Save as" required value={name} onChange={(e) => setName(e.target.value)} hint="Saving under an existing name adds a version" list="schema-names" />
          <datalist id="schema-names">
            {(list.data ?? []).map((s) => (
              <option key={s.id} value={s.name} />
            ))}
          </datalist>
          <TextField className="min-w-64 flex-1" label="Change message (optional)" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Add loyalty tier" />
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!name.trim()}>
            Save version
          </Button>
        </form>
      )}
      {save.data?.diff && (
        <div className="mb-4 rounded-md border border-[var(--border)] p-3">
          <p className="mb-2 text-sm font-medium">Changes in v{save.data.version}</p>
          <SchemaDiffView diff={save.data.diff} />
        </div>
      )}
      <QueryState query={list} empty={(l) => (l.length ? null : <EmptyState title="No saved schemas yet">Save the current schema to start its version history.</EmptyState>)}>
        {(schemas) => (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,16rem)_1fr]">
            <ul className="space-y-1" aria-label="Saved schemas">
              {schemas.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-pressed={selected === s.id}
                    onClick={() => setSelected(s.id)}
                    className={cx("w-full rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]", selected === s.id && "bg-brand-50 font-medium dark:bg-brand-900/40")}
                  >
                    {s.name} <Badge className="ml-1">v{s.current_version}</Badge>
                    <span className="block text-xs text-[var(--text-2)]">updated {formatDate(s.updated_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="min-w-0">{selected ? <Versions id={selected} onLoad={onLoad} /> : <p className="text-sm text-[var(--text-2)]">Select a schema to see its versions.</p>}</div>
          </div>
        )}
      </QueryState>
    </Card>
  );
}

function Versions({ id, onLoad }: { id: string; onLoad: (s: Schema) => void }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ["schema", id], queryFn: () => api.schemas.get(id) });
  const versions = [...(q.data?.versions ?? [])].sort((a, b) => b.version - a.version);
  const latest = versions[0]?.version;
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  useEffect(() => {
    setFrom(latest && latest > 1 ? latest - 1 : null);
    setTo(latest ?? null);
  }, [id, latest]);
  const diff = useQuery({ queryKey: ["schema-diff", id, from, to], queryFn: () => api.schemas.diff(id, from!, to!), enabled: !!from && !!to && from !== to });
  const load = useMutation({
    mutationFn: (version: number) => api.schemas.version(id, version),
    onSuccess: (v) => {
      if (v.schema) {
        onLoad(v.schema);
        toast.success(`Loaded v${v.version} into the editor`);
      }
    },
  });
  const options = versions.map((v) => ({ value: String(v.version), label: `v${v.version}${v.message ? ` — ${v.message}` : ""}` }));
  return (
    <QueryState query={q}>
      {() => (
        <div className="space-y-4">
          <ol className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]" aria-label="Versions">
            {versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <Badge tone={v.version === latest ? "info" : "neutral"}>v{v.version}</Badge>
                <span className="min-w-0 flex-1">
                  {v.message || <span className="text-[var(--text-2)]">No message</span>}
                  <span className="block text-xs text-[var(--text-2)]">
                    {v.source_format ? `${v.source_format} · ` : ""}
                    {v.created_by} · {formatDate(v.created_at)}
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => load.mutate(v.version)} loading={load.isPending && load.variables === v.version}>
                  Load
                </Button>
              </li>
            ))}
          </ol>
          {versions.length > 1 ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-end gap-2">
                <SelectField label="Compare from" value={from ? String(from) : ""} onChange={(e) => setFrom(Number(e.target.value) || null)} options={options} />
                <SelectField label="to" value={to ? String(to) : ""} onChange={(e) => setTo(Number(e.target.value) || null)} options={options} />
              </div>
              {from === to ? (
                <p className="text-sm text-[var(--text-2)]">Choose two different versions.</p>
              ) : (
                <QueryState query={diff} loadingLabel="Comparing…">
                  {(d) => <SchemaDiffView diff={d} caption={`Changes from v${from} to v${to}`} />}
                </QueryState>
              )}
            </div>
          ) : (
            <p className="text-sm text-[var(--text-2)]">Only one version so far.</p>
          )}
        </div>
      )}
    </QueryState>
  );
}
