"use client";
/** Consent (SEC-003, SOC-PRV-005), cost attribution (OBS-004) and the public-links switch (SHR-001a). */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ConsentPolicy, type CostReport } from "@/lib/api";
import { barH } from "@/lib/chartOptions";
import { formatBytes, formatDate, formatNumber } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { useToast } from "@/lib/toast";
import { EChart } from "../charts/EChart";
import { Badge, Button, Card, Checkbox, QueryState, SelectField, StatTile, TextField } from "../ui";

// -- Consent -------------------------------------------------------------------------------

export const POLICY_LABELS: Record<ConsentPolicy, string> = { terms: "Terms of service", privacy: "Privacy policy", llm_processing: "LLM processing addendum" };

export function ConsentTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ["consent-settings"], queryFn: api.governance.consentSettings });
  const [policy, setPolicy] = useState<ConsentPolicy | "">("");
  const records = useQuery({ queryKey: ["tenant-consents", policy], queryFn: () => api.governance.tenantConsents(policy || undefined) });
  const [required, setRequired] = useState(false);
  const [version, setVersion] = useState("1");
  useEffect(() => {
    if (settings.data) {
      setRequired(settings.data.llm_requires_consent);
      setVersion(settings.data.llm_addendum_version);
    }
  }, [settings.data]);
  const save = useMutation({
    mutationFn: () => api.governance.putConsentSettings({ llm_requires_consent: required, llm_addendum_version: version.trim() || "1" }),
    meta: { errorPrefix: "Consent settings not saved" },
    onSuccess: (s) => {
      qc.setQueryData(["consent-settings"], s);
      toast.success("Consent settings saved");
    },
  });
  const consent = useMutation({
    mutationFn: () => api.governance.giveConsent("llm_processing", version.trim() || "1"),
    onSuccess: () => {
      toast.success("Your consent to the LLM addendum is recorded");
      qc.invalidateQueries({ queryKey: ["consent-settings"] });
      qc.invalidateQueries({ queryKey: ["tenant-consents"] });
      qc.invalidateQueries({ queryKey: ["my-consents"] });
    },
  });
  const blocking = settings.data && settings.data.llm_requires_consent && !settings.data.llm_consent_given;
  return (
    <div className="space-y-4">
      <Card title="LLM processing consent">
        <QueryState query={settings}>
          {(s) => (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <p className="text-sm text-[var(--text-2)]">
                When required, every LLM feature (schema from text, AI suggestions, model explanations) is blocked with a <code>llm_consent_required</code> error until an admin has accepted the LLM processing addendum at
                this version. Bump the version when the addendum changes to require a fresh acceptance. Data sent to the LLM is still minimized per the LLM provider settings.
              </p>
              <Checkbox label="Require admin consent before any LLM processing" checked={required} onChange={(e) => setRequired(e.target.checked)} />
              <TextField className="max-w-xs" label="Addendum version" value={version} onChange={(e) => setVersion(e.target.value)} maxLength={32} />
              <p className="text-sm">
                Status:{" "}
                {s.llm_consent_given ? (
                  <Badge tone="good">✓ an admin consented to v{s.llm_addendum_version}</Badge>
                ) : (
                  <Badge tone={s.llm_requires_consent ? "critical" : "neutral"}>no admin consent for v{s.llm_addendum_version}</Badge>
                )}
              </p>
              {blocking && (
                <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-100">
                  LLM features are currently blocked for everyone in the organization.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" loading={save.isPending}>
                  Save settings
                </Button>
                {!s.llm_consent_given && (
                  <Button onClick={() => consent.mutate()} loading={consent.isPending}>
                    I accept the LLM addendum v{version || "1"}
                  </Button>
                )}
              </div>
            </form>
          )}
        </QueryState>
      </Card>
      <Card
        title="Consent records"
        bodyClassName="p-0 overflow-x-auto"
        actions={
          <SelectField
            label="Policy"
            srOnlyLabel
            value={policy}
            onChange={(e) => setPolicy(e.target.value as ConsentPolicy | "")}
            options={(Object.keys(POLICY_LABELS) as ConsentPolicy[]).map((p) => ({ value: p, label: POLICY_LABELS[p] }))}
            placeholder="All policies"
          />
        }
      >
        <QueryState query={records} empty={(l) => (l.length ? null : <p className="p-4 text-sm text-[var(--text-2)]">No consent records.</p>)}>
          {(list) => (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Consent records</caption>
              <thead className="bg-[var(--surface-2)] text-xs">
                <tr>
                  <th scope="col" className="px-3 py-2">User</th>
                  <th scope="col" className="px-3 py-2">Role</th>
                  <th scope="col" className="px-3 py-2">Policy</th>
                  <th scope="col" className="px-3 py-2">Version</th>
                  <th scope="col" className="px-3 py-2">Accepted</th>
                  <th scope="col" className="px-3 py-2">Withdrawn</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id} className="border-t border-[var(--border)]">
                    <td className="px-3 py-2 font-mono text-xs">{c.user_id}</td>
                    <td className="px-3 py-2 text-xs">{c.role}</td>
                    <td className="px-3 py-2">{POLICY_LABELS[c.policy] ?? c.policy}</td>
                    <td className="px-3 py-2">{c.version}</td>
                    <td className="px-3 py-2 text-xs">{formatDate(c.accepted_at)}</td>
                    <td className="px-3 py-2 text-xs">{c.withdrawn_at ? formatDate(c.withdrawn_at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </QueryState>
      </Card>
    </div>
  );
}

// -- Costs ---------------------------------------------------------------------------------

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v !== 0 && Math.abs(v) < 0.01) return `$${v.toPrecision(2)}`;
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

/** Flatten a cost report into breakdown rows (category, item, amount, cost). */
export function costRows(r: CostReport): { category: string; item: string; amount: string; cost: number | null }[] {
  const rows: { category: string; item: string; amount: string; cost: number | null }[] = [];
  for (const [model, cost] of Object.entries(r.llm.by_model)) rows.push({ category: "LLM", item: model, amount: "", cost });
  if (!Object.keys(r.llm.by_model).length) rows.push({ category: "LLM", item: "all models", amount: `${formatNumber(r.llm.input_tokens + r.llm.output_tokens)} tokens`, cost: r.llm.cost_usd });
  const perSecond = r.rates.compute_usd_per_second ?? 0;
  for (const [type, secs] of Object.entries(r.compute.by_job_type)) rows.push({ category: "Compute", item: type, amount: `${formatNumber(secs)} s`, cost: secs * perSecond });
  rows.push({ category: "Storage", item: r.storage.basis, amount: `${formatBytes(r.storage.bytes)} · ${formatNumber(r.storage.gb_months)} GB-months`, cost: r.storage.cost_usd });
  const per1k = r.rates.api_usd_per_1k_requests ?? 0;
  for (const [key, n] of Object.entries(r.api.by_key)) rows.push({ category: "API", item: key, amount: `${formatNumber(n)} requests`, cost: (n / 1000) * per1k });
  return rows;
}

export function CostsTab() {
  const { dark } = useTheme();
  const today = new Date();
  const [start, setStart] = useState(iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))));
  const [end, setEnd] = useState(iso(today));
  const [range, setRange] = useState({ start, end });
  const invalid = !start || !end || end < start;
  const q = useQuery({ queryKey: ["costs", range.start, range.end], queryFn: () => api.governance.costs(range.start, range.end) });
  const chart = useMemo(() => {
    const r = q.data;
    if (!r) return null;
    return barH(
      [
        { name: "LLM", value: r.llm.cost_usd },
        { name: "Compute", value: r.compute.cost_usd },
        { name: "Storage", value: r.storage.cost_usd },
        { name: "API", value: r.api.cost_usd },
      ],
      { dark, name: "USD" },
    );
  }, [q.data, dark]);
  return (
    <div className="space-y-4">
      <Card title="Cost attribution">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!invalid) setRange({ start, end });
          }}
        >
          <TextField label="From" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          <TextField label="To" type="date" value={end} onChange={(e) => setEnd(e.target.value)} error={invalid ? "End must be on or after start" : null} />
          <Button type="submit" variant="primary" disabled={invalid}>
            Apply
          </Button>
          <p className="text-xs text-[var(--text-2)]">Up to 366 days. Estimates from metered usage and the platform&apos;s rates.</p>
        </form>
      </Card>
      <QueryState query={q}>
        {(r) => (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <StatTile label="Total" value={usd(r.total_cost_usd)} sub={`${r.start} → ${r.end}`} />
              <StatTile label="LLM" value={usd(r.llm.cost_usd)} sub={`${formatNumber(r.llm.input_tokens)} in / ${formatNumber(r.llm.output_tokens)} out tokens${r.llm.unpriced_requests ? ` · ${r.llm.unpriced_requests} unpriced` : ""}`} />
              <StatTile label="Compute" value={usd(r.compute.cost_usd)} sub={`${formatNumber(r.compute.seconds)} job-seconds`} />
              <StatTile label="Storage" value={usd(r.storage.cost_usd)} sub={formatBytes(r.storage.bytes)} />
              <StatTile label="API" value={usd(r.api.cost_usd)} sub={`${formatNumber(r.api.requests)} requests`} />
            </div>
            <div className="grid gap-4 lg:grid-cols-[2fr_3fr]">
              <Card title="By category">{chart && <EChart height={220} option={chart} ariaLabel="Bar chart of cost per category in USD" />}</Card>
              <Card title="Breakdown" bodyClassName="p-0 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Cost breakdown</caption>
                  <thead className="bg-[var(--surface-2)] text-xs">
                    <tr>
                      <th scope="col" className="px-3 py-2">Category</th>
                      <th scope="col" className="px-3 py-2">Item</th>
                      <th scope="col" className="px-3 py-2">Usage</th>
                      <th scope="col" className="px-3 py-2 text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costRows(r).map((row, i) => (
                      <tr key={i} className="border-t border-[var(--border)]">
                        <td className="px-3 py-1.5">{row.category}</td>
                        <td className="px-3 py-1.5 font-mono text-xs">{row.item}</td>
                        <td className="px-3 py-1.5 text-xs">{row.amount}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{usd(row.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-[var(--border)] font-medium">
                      <td className="px-3 py-1.5" colSpan={3}>
                        Total
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{usd(r.total_cost_usd)}</td>
                    </tr>
                  </tfoot>
                </table>
                <p className="px-3 py-2 text-xs text-[var(--text-2)]">
                  Rates: {Object.entries(r.rates)
                    .map(([k, v]) => `${k} = ${v}`)
                    .join(" · ")}
                </p>
              </Card>
            </div>
          </>
        )}
      </QueryState>
    </div>
  );
}

// -- Sharing ---------------------------------------------------------------------------------

export function SharingTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["sharing-settings"], queryFn: api.access.sharing });
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.access.putSharing(enabled),
    onSuccess: (s) => {
      qc.setQueryData(["sharing-settings"], s);
      qc.invalidateQueries({ queryKey: ["public-links"] });
      toast.success(s.public_links_enabled ? "Public links enabled" : "Public links disabled; existing links stopped working");
    },
  });
  return (
    <Card title="Public dashboard links">
      <QueryState query={q}>
        {(s) => (
          <div className="space-y-3">
            <p className="text-sm text-[var(--text-2)]">
              Dashboard editors can create view-only links that work without signing in, with an expiry. Turning this off immediately stops every existing link (they work again if re-enabled and not expired or revoked).
            </p>
            <Checkbox label="Allow public dashboard links" checked={s.public_links_enabled} disabled={save.isPending} onChange={(e) => save.mutate(e.target.checked)} />
          </div>
        )}
      </QueryState>
    </Card>
  );
}
