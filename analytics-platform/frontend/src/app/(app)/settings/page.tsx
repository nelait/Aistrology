"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, NOTIFICATION_KINDS, type ConsentPolicy } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { POLICY_LABELS } from "@/components/admin/GovernanceTabs";
import { Badge, Button, Card, Checkbox, PageHeader, QueryState, SelectField, TextField } from "@/components/ui";

const KIND_LABELS: Record<string, string> = {
  "job.succeeded": "A job I started succeeded",
  "job.failed": "A job I started failed",
  "model.registered": "A model version was registered",
  "endpoint.deployed": "An endpoint was deployed",
  "dataset.version_created": "A dataset version was created",
  "endpoint.threshold": "An endpoint crossed a threshold (errors, latency, drift)",
};

/** Personal settings: email notification preferences (NTF-002) and consents (SEC-003). */
export default function SettingsPage() {
  const { me } = useAuth();
  return (
    <div className="space-y-5">
      <PageHeader title="Your settings" description={me?.email ? `Signed in as ${me.email}` : undefined} />
      <NotificationPreferences />
      <MyConsents />
      <Card title="Security">
        <Link href="/settings/mfa" className="text-sm text-brand-600 underline dark:text-brand-300">
          Two-factor authentication {me?.mfa_enabled ? "(enabled)" : "(not enabled)"}
        </Link>
      </Card>
    </div>
  );
}

function NotificationPreferences() {
  const toast = useToast();
  const q = useQuery({ queryKey: ["notification-preferences"], queryFn: api.notifications.preferences });
  const [kinds, setKinds] = useState<string[]>([]);
  useEffect(() => {
    if (q.data) setKinds(q.data.email);
  }, [q.data]);
  const all = kinds.includes("*");
  const save = useMutation({
    mutationFn: () => api.notifications.putPreferences(kinds),
    meta: { errorPrefix: "Preferences not saved" },
    onSuccess: () => toast.success("Email preferences saved"),
  });
  const toggle = (k: string) => setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur.filter((x) => x !== "*"), k]));
  return (
    <Card title="Email notifications">
      <QueryState query={q}>
        {() => (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <p className="text-sm text-[var(--text-2)]">In-app notifications are always on. Choose which ones are also emailed to you.</p>
            <Checkbox label={<strong>Email me about everything</strong>} checked={all} onChange={(e) => setKinds(e.target.checked ? ["*"] : [])} />
            <fieldset className="space-y-2 pl-6" disabled={all}>
              <legend className="sr-only">Notification kinds</legend>
              {NOTIFICATION_KINDS.map((k) => (
                <Checkbox key={k} label={KIND_LABELS[k] ?? k} hint={k} checked={all || kinds.includes(k)} onChange={() => toggle(k)} />
              ))}
            </fieldset>
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save preferences
            </Button>
          </form>
        )}
      </QueryState>
    </Card>
  );
}

function MyConsents() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["my-consents"], queryFn: api.governance.consents });
  const [policy, setPolicy] = useState<ConsentPolicy>("terms");
  const [version, setVersion] = useState("1");
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["my-consents"] });
    qc.invalidateQueries({ queryKey: ["consent-settings"] });
  };
  const give = useMutation({
    mutationFn: () => api.governance.giveConsent(policy, version.trim()),
    meta: { errorPrefix: "Consent not recorded" },
    onSuccess: () => {
      toast.success(`Consent to ${POLICY_LABELS[policy]} v${version} recorded`);
      invalidate();
    },
  });
  const withdraw = useMutation({
    mutationFn: (p: ConsentPolicy) => api.governance.withdrawConsent(p),
    onSuccess: (_r, p) => {
      toast.success(`Consent to ${POLICY_LABELS[p]} withdrawn (the record is kept)`);
      invalidate();
    },
  });
  return (
    <Card title="Consents">
      <form
        className="mb-4 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          give.mutate();
        }}
      >
        <SelectField label="Policy" value={policy} onChange={(e) => setPolicy(e.target.value as ConsentPolicy)} options={(Object.keys(POLICY_LABELS) as ConsentPolicy[]).map((p) => ({ value: p, label: POLICY_LABELS[p] }))} />
        <TextField className="w-28" label="Version" value={version} onChange={(e) => setVersion(e.target.value)} maxLength={32} required />
        <Button type="submit" variant="primary" loading={give.isPending} disabled={!version.trim()}>
          I agree
        </Button>
      </form>
      <p className="mb-3 text-xs text-[var(--text-2)]">Consents are recorded with a timestamp and your IP address. Withdrawing keeps the record for audit but marks it withdrawn.</p>
      <QueryState query={q} empty={(l) => (l.length ? null : <p className="text-sm text-[var(--text-2)]">You haven&apos;t recorded any consent yet.</p>)}>
        {(list) => (
          <ul className="divide-y divide-[var(--border)]">
            {list.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="font-medium">{POLICY_LABELS[c.policy] ?? c.policy}</span>
                <Badge>v{c.version}</Badge>
                {c.withdrawn_at ? <Badge tone="warning">withdrawn {formatDate(c.withdrawn_at)}</Badge> : <Badge tone="good">active</Badge>}
                <span className="flex-1 text-xs text-[var(--text-2)]">accepted {formatDate(c.accepted_at)}</span>
                {!c.withdrawn_at && (
                  <Button size="sm" variant="ghost" onClick={() => withdraw.mutate(c.policy)} loading={withdraw.isPending && withdraw.variables === c.policy}>
                    Withdraw
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </Card>
  );
}
