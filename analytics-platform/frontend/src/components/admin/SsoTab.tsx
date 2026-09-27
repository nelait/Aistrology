"use client";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ROLES, type Role } from "@/lib/api";
import { ROLE_LABELS } from "@/lib/rbac";
import { useToast } from "@/lib/toast";
import { Badge, Button, Card, QueryState, SelectField, TextField } from "../ui";

/** SSO (OIDC) just-in-time sign-up: claimed email domains and their default role (AUTH-001). */
export function SsoTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["sso"], queryFn: () => api.tenant.sso() });
  const providers = useQuery({ queryKey: ["oidc-providers"], queryFn: () => api.auth.oidcProviders(), meta: { silent: true } });
  const [domains, setDomains] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  useEffect(() => {
    if (q.data) {
      setDomains(q.data.domains.join(", "));
      setRole(q.data.default_role);
    }
  }, [q.data]);
  const save = useMutation({
    mutationFn: () =>
      api.tenant.putSso({
        domains: domains
          .split(/[,\s]+/)
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
        default_role: role,
      }),
    onSuccess: (s) => {
      qc.setQueryData(["sso"], s);
      toast.success("SSO settings saved");
    },
  });
  return (
    <Card title="Single sign-on (OIDC)">
      <QueryState query={q}>
        {() => (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <p className="text-sm">
              Identity providers enabled on this platform:{" "}
              {providers.data?.providers.length ? providers.data.providers.map((p) => <Badge key={p} className="mr-1">{p}</Badge>) : <span className="text-[var(--text-2)]">none configured</span>}
            </p>
            <TextField label="Claimed email domains" hint="People with these email domains who sign in with SSO join your organization automatically." placeholder="acme.com, acme.co.uk" value={domains} onChange={(e) => setDomains(e.target.value)} />
            <SelectField label="Default role for new SSO users" value={role} onChange={(e) => setRole(e.target.value as Role)} options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save
            </Button>
          </form>
        )}
      </QueryState>
    </Card>
  );
}
