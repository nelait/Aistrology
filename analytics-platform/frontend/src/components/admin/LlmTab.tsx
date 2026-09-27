"use client";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DataMinimization, type LLMConfig, type ProviderConfig, type ProviderKind } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { Badge, Button, Card, Checkbox, ConfirmDialog, QueryState, SelectField, TextField, cx } from "../ui";

const KINDS: { value: ProviderKind; label: string }[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Google Gemini" },
  { value: "openai_compatible", label: "OpenAI-compatible (self-hosted / other)" },
  { value: "mock", label: "Mock (testing)" },
];

export const LEVELS: { value: DataMinimization; title: string; text: string }[] = [
  { value: "L0", title: "L0 · Schema only", text: "Only column names and types are sent. Most private; suggestions are more generic." },
  { value: "L1", title: "L1 · + aggregated profile", text: "Adds aggregate statistics (counts, ranges, distributions). No row-level values." },
  { value: "L2", title: "L2 · + masked samples (default)", text: "Adds up to 20 sample rows with PII-tagged columns masked. Best balance of quality and privacy." },
  { value: "L3", title: "L3 · + unmasked samples", text: "Adds up to 20 unmasked sample rows, including PII. Requires explicit admin opt-in and is recorded in the audit log." },
];

/** LLM provider fallback chain, data minimization (LLM-NFR-004) and write-only BYOK secrets (SEC-005). */
export function LlmTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["llm-config"], queryFn: api.tenant.llmConfig });
  const secrets = useQuery({ queryKey: ["secrets"], queryFn: api.tenant.secrets });
  const [cfg, setCfg] = useState<LLMConfig | null>(null);
  const [confirmL3, setConfirmL3] = useState(false);
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");

  useEffect(() => {
    if (q.data) setCfg(q.data);
  }, [q.data]);

  const save = useMutation({
    mutationFn: (c: LLMConfig) =>
      api.tenant.putLlmConfig({
        ...c,
        chain: c.chain.map((p) => ({ kind: p.kind, model: p.model || null, base_url: p.kind === "openai_compatible" ? p.base_url || null : null, secret_name: p.secret_name || null })),
      }),
    meta: { errorPrefix: "LLM settings not saved" },
    onSuccess: (c) => {
      qc.setQueryData(["llm-config"], c);
      toast.success("LLM settings saved");
    },
  });
  const putSecret = useMutation({
    mutationFn: () => api.tenant.putSecret(secretName.trim(), secretValue),
    onSuccess: () => {
      toast.success(`Secret “${secretName}” stored`);
      setSecretValue("");
      setSecretName("");
      qc.invalidateQueries({ queryKey: ["secrets"] });
    },
  });
  const delSecret = useMutation({
    mutationFn: (name: string) => api.tenant.deleteSecret(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["secrets"] }),
  });

  const setProvider = (i: number, patch: Partial<ProviderConfig>) => cfg && setCfg({ ...cfg, chain: cfg.chain.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const move = (i: number, d: -1 | 1) => {
    if (!cfg) return;
    const chain = [...cfg.chain];
    [chain[i], chain[i + d]] = [chain[i + d], chain[i]];
    setCfg({ ...cfg, chain });
  };
  const names = secrets.data?.names ?? [];

  return (
    <QueryState query={q}>
      {() =>
        cfg && (
          <div className="space-y-5">
            <Card title="Provider fallback chain">
              <p className="mb-3 text-sm text-[var(--text-2)]">Providers are tried in order; the next one is used when a provider is unavailable. Up to 5.</p>
              <ol className="space-y-3">
                {cfg.chain.map((p, i) => (
                  <li key={i} className="rounded-md border border-[var(--border)] p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <Badge tone={i === 0 ? "info" : "neutral"}>{i === 0 ? "Primary" : `Fallback ${i}`}</Badge>
                      <span className="flex-1" />
                      <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move provider ${i + 1} up`}>
                        ↑
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === cfg.chain.length - 1} aria-label={`Move provider ${i + 1} down`}>
                        ↓
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setCfg({ ...cfg, chain: cfg.chain.filter((_, j) => j !== i) })} disabled={cfg.chain.length <= 1} aria-label={`Remove provider ${i + 1}`}>
                        ✕
                      </Button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <SelectField label="Provider" value={p.kind} onChange={(e) => setProvider(i, { kind: e.target.value as ProviderKind })} options={KINDS} />
                      <TextField label="Model" value={p.model ?? ""} onChange={(e) => setProvider(i, { model: e.target.value })} placeholder={p.kind === "openai_compatible" ? "required" : "provider default"} />
                      {p.kind === "openai_compatible" && <TextField label="Base URL" type="url" value={p.base_url ?? ""} onChange={(e) => setProvider(i, { base_url: e.target.value })} placeholder="https://…" hint="Must use https://" />}
                      {p.kind !== "mock" && (
                        <SelectField
                          label="API key secret"
                          value={p.secret_name ?? ""}
                          onChange={(e) => setProvider(i, { secret_name: e.target.value || null })}
                          options={names.map((n) => ({ value: n, label: n }))}
                          placeholder="Platform key"
                          hint="Bring your own key (stored below)"
                        />
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              <Button className="mt-3" size="sm" disabled={cfg.chain.length >= 5} onClick={() => setCfg({ ...cfg, chain: [...cfg.chain, { kind: "anthropic" }] })}>
                + Add fallback provider
              </Button>
            </Card>

            <Card title="Data minimization">
              <fieldset>
                <legend className="mb-2 text-sm text-[var(--text-2)]">What may be sent to the LLM. Raw full datasets are never sent.</legend>
                <div className="grid gap-2 md:grid-cols-2">
                  {LEVELS.map((l) => (
                    <label key={l.value} className={cx("flex cursor-pointer gap-3 rounded-md border p-3 focus-within:outline focus-within:outline-2 focus-within:outline-brand-500", cfg.data_minimization === l.value ? "border-brand-500 bg-brand-50 dark:bg-brand-900/30" : "border-[var(--border)]")}>
                      <input
                        type="radio"
                        name="dm"
                        className="mt-1 accent-brand-600"
                        checked={cfg.data_minimization === l.value}
                        onChange={() => (l.value === "L3" ? setConfirmL3(true) : setCfg({ ...cfg, data_minimization: l.value }))}
                      />
                      <span>
                        <span className="block text-sm font-medium">{l.title}</span>
                        <span className="block text-xs text-[var(--text-2)]">{l.text}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Checkbox className="mt-3" label="Cache identical LLM requests" hint="Reduces cost and latency; cache entries are tenant-scoped." checked={cfg.cache_enabled} onChange={(e) => setCfg({ ...cfg, cache_enabled: e.target.checked })} />
            </Card>

            <div className="flex justify-end gap-2">
              <Button onClick={() => q.data && setCfg(q.data)}>Reset</Button>
              <Button variant="primary" onClick={() => save.mutate(cfg)} loading={save.isPending}>
                Save LLM settings
              </Button>
            </div>

            <Card title="Provider API keys (BYOK)">
              <p className="mb-3 text-sm text-[var(--text-2)]">Keys are stored in the secret manager and are write-only: they are never shown again. Reference them by name in the chain above.</p>
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  putSecret.mutate();
                }}
              >
                <TextField label="Secret name" value={secretName} onChange={(e) => setSecretName(e.target.value.replace(/[^A-Za-z0-9_.-]/g, "-"))} placeholder="anthropic-key" />
                <TextField className="min-w-64 flex-1" label="Value" type="password" autoComplete="off" value={secretValue} onChange={(e) => setSecretValue(e.target.value)} />
                <Button type="submit" variant="primary" disabled={!secretName.trim() || !secretValue} loading={putSecret.isPending}>
                  Store secret
                </Button>
              </form>
              <ul className="mt-4 divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                {names.length === 0 && <li className="px-3 py-2 text-sm text-[var(--text-2)]">No secrets stored.</li>}
                {names.map((n) => (
                  <li key={n} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="flex-1 font-mono">{n}</span>
                    <span className="text-xs text-[var(--text-2)]">••••••••</span>
                    <Button size="sm" variant="ghost" onClick={() => delSecret.mutate(n)} aria-label={`Delete secret ${n}`}>
                      Delete
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>

            <ConfirmDialog
              open={confirmL3}
              onClose={() => setConfirmL3(false)}
              onConfirm={() => {
                setCfg({ ...cfg, data_minimization: "L3" });
                setConfirmL3(false);
              }}
              title="Allow unmasked sample rows?"
              confirmLabel="Opt in to L3"
              danger
              typedConfirmation="L3"
            >
              <p>Up to 20 unmasked rows — including PII — may be sent to your LLM provider. This choice is recorded in the audit log.</p>
            </ConfirmDialog>
          </div>
        )
      }
    </QueryState>
  );
}
