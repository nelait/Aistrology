"use client";
/** Prompt templates (LPA-008): shipped defaults, tenant overrides with provider variants, activate/deactivate. */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PromptTemplate } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { Badge, Button, Card, CodeBlock, QueryState, SelectField, TextArea, TextField, cx } from "../ui";

const PROVIDERS = [
  { value: "", label: "Any provider" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "openai_compatible", label: "OpenAI-compatible" },
  { value: "gemini", label: "Gemini" },
  { value: "mock", label: "Mock" },
];

/** Placeholders used in a prompt, e.g. {{schema}}. */
export function placeholders(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g), (m) => m[1]))).sort();
}

export function PromptsTab() {
  const list = useQuery({ queryKey: ["prompts"], queryFn: api.llmAdmin.prompts });
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <QueryState query={list}>
      {(templates) => {
        const current = selected ?? templates[0]?.template_id ?? null;
        return (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,16rem)_1fr]">
            <Card title="Templates" bodyClassName="p-2">
              <ul className="space-y-1">
                {templates.map((t) => (
                  <li key={t.template_id}>
                    <button
                      type="button"
                      aria-pressed={current === t.template_id}
                      onClick={() => setSelected(t.template_id)}
                      className={cx("w-full rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]", current === t.template_id && "bg-brand-50 font-medium dark:bg-brand-900/40")}
                    >
                      <span className="font-mono">{t.template_id}</span>
                      <span className="block text-xs text-[var(--text-2)]">
                        in effect: {t.effective?.ref ?? t.default.ref} ({t.effective?.source ?? "default"})
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
            {current && <TemplateDetail id={current} />}
          </div>
        );
      }}
    </QueryState>
  );
}

function TemplateDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["prompt", id], queryFn: () => api.llmAdmin.prompt(id) });
  const [system, setSystem] = useState<string | null>(null);
  const [provider, setProvider] = useState("");
  const [description, setDescription] = useState("");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["prompt", id] });
    qc.invalidateQueries({ queryKey: ["prompts"] });
  };
  const create = useMutation({
    mutationFn: (text: string) => api.llmAdmin.createPromptVersion(id, { system: text, provider: provider || undefined, description: description.trim() || undefined }),
    meta: { errorPrefix: "Prompt version not created" },
    onSuccess: (v) => {
      toast.success(`Created ${v.ref} (active)`);
      setSystem(null);
      setDescription("");
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: ({ version, active }: { version: number; active: boolean }) => api.llmAdmin.setPromptActive(id, version, active),
    onSuccess: (_r, v) => {
      toast.success(v.active ? "Version activated" : "Version deactivated");
      refresh();
    },
  });
  return (
    <QueryState query={q}>
      {(t) => <Detail t={t} system={system} setSystem={setSystem} provider={provider} setProvider={setProvider} description={description} setDescription={setDescription} create={create} toggle={toggle} />}
    </QueryState>
  );
}

function Detail({
  t,
  system,
  setSystem,
  provider,
  setProvider,
  description,
  setDescription,
  create,
  toggle,
}: {
  t: PromptTemplate;
  system: string | null;
  setSystem: (s: string | null) => void;
  provider: string;
  setProvider: (s: string) => void;
  description: string;
  setDescription: (s: string) => void;
  create: { mutate: (text: string) => void; isPending: boolean };
  toggle: { mutate: (v: { version: number; active: boolean }) => void; isPending: boolean };
}) {
  const text = system ?? t.default.system;
  const used = useMemo(() => placeholders(text), [text]);
  const expected = [...t.variables].sort();
  const missing = expected.filter((v) => !used.includes(v));
  const unknown = used.filter((v) => !expected.includes(v));
  const valid = !missing.length && !unknown.length && text.trim().length > 0;
  return (
    <div className="min-w-0 space-y-4">
      <Card title={<span className="font-mono">{t.template_id}</span>}>
        <p className="mb-2 text-sm text-[var(--text-2)]">{t.description}</p>
        <p className="mb-2 text-xs">
          Variables:{" "}
          {t.variables.map((v) => (
            <code key={v} className="mr-1 rounded bg-[var(--surface-2)] px-1">{`{{${v}}}`}</code>
          ))}
          · In effect: <Badge tone="info">{t.effective?.ref ?? t.default.ref}</Badge> <span className="text-[var(--text-2)]">({t.effective?.source ?? "default"})</span>
        </p>
        <details>
          <summary className="cursor-pointer text-sm">Shipped default ({t.default.ref})</summary>
          <div className="mt-2">
            <CodeBlock code={t.default.system} label="Default system prompt" />
          </div>
        </details>
        <p className="mt-2 text-xs text-[var(--text-2)]">Resolution: tenant provider-specific → tenant any-provider → platform provider-specific → platform any-provider → shipped default.</p>
      </Card>

      <Card title="Tenant versions" bodyClassName="p-0">
        {t.tenant_versions?.length ? (
          <ul className="divide-y divide-[var(--border)]">
            {[...t.tenant_versions]
              .sort((a, b) => b.version - a.version)
              .map((v) => (
                <li key={v.ref} className="space-y-1 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{v.ref}</span>
                    <Badge>{v.provider || "any provider"}</Badge>
                    {v.active ? <Badge tone="good">active</Badge> : <Badge>inactive</Badge>}
                    <span className="flex-1 text-xs text-[var(--text-2)]">
                      {v.description ? `${v.description} · ` : ""}
                      {v.created_by} · {formatDate(v.created_at)}
                    </span>
                    <Button size="sm" onClick={() => toggle.mutate({ version: v.version, active: !v.active })} disabled={toggle.isPending}>
                      {v.active ? "Deactivate" : "Activate"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setSystem(v.system)}>
                      Edit as new
                    </Button>
                  </div>
                  <details>
                    <summary className="cursor-pointer text-xs">Show prompt</summary>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface-2)] p-2 font-mono text-xs">{v.system}</pre>
                  </details>
                </li>
              ))}
          </ul>
        ) : (
          <p className="p-4 text-sm text-[var(--text-2)]">No tenant overrides: the {t.effective?.source === "platform" ? "platform" : "shipped"} version is used.</p>
        )}
        {t.platform_versions?.length ? <p className="border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--text-2)]">{t.platform_versions.length} platform-wide version(s) managed by operators.</p> : null}
      </Card>

      <Card title="New tenant override">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) create.mutate(text);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField label="Provider variant" value={provider} onChange={(e) => setProvider(e.target.value)} options={PROVIDERS} hint="A provider-specific version wins over an any-provider one" />
            <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Shorter answers for analysts" />
          </div>
          <TextArea label="System prompt" mono rows={14} value={text} onChange={(e) => setSystem(e.target.value)} spellCheck={false} />
          {!valid && (
            <p role="alert" className="text-xs text-red-700 dark:text-red-400">
              {missing.length ? `Missing placeholders: ${missing.map((v) => `{{${v}}}`).join(", ")}. ` : ""}
              {unknown.length ? `Unknown placeholders: ${unknown.map((v) => `{{${v}}}`).join(", ")}.` : ""}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!valid}>
              Create &amp; activate
            </Button>
            {system !== null && <Button onClick={() => setSystem(null)}>Reset to default</Button>}
          </div>
        </form>
      </Card>
    </div>
  );
}
