"use client";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatBytes, formatPercent } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { Badge, Button, Card, Checkbox, KeyValue, ProgressBar, QueryState, TextField } from "../ui";

export function OrgTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["tenant"], queryFn: api.tenant.get });
  const [name, setName] = useState("");
  const [requireMfa, setRequireMfa] = useState(false);
  useEffect(() => {
    if (q.data) {
      setName(q.data.name);
      setRequireMfa(q.data.require_mfa);
    }
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.tenant.patch({ name, require_mfa: requireMfa }),
    onSuccess: (t) => {
      qc.setQueryData(["tenant"], t);
      toast.success("Organization settings saved");
    },
  });
  return (
    <QueryState query={q}>
      {(t) => (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="Organization">
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
              <Checkbox
                label="Require two-factor authentication for all users"
                hint="Users without MFA are asked to enroll before they can sign in (AUTH-006)."
                checked={requireMfa}
                onChange={(e) => setRequireMfa(e.target.checked)}
              />
              <Button type="submit" variant="primary" loading={save.isPending}>
                Save
              </Button>
            </form>
          </Card>
          <Card title="Plan & storage">
            <KeyValue
              items={[
                ["Organization ID", <span key="i" className="font-mono">{t.id}</span>],
                ["Region", t.region.toUpperCase()],
                ["Plan", t.plan],
                ["Status", <Badge key="s" tone={t.status === "active" ? "good" : "warning"}>{t.status}</Badge>],
                ["Cloud", t.cloud_provider ?? "—"],
              ]}
            />
            <div className="mt-4">
              <p className="mb-1 text-sm">
                Storage: {formatBytes(t.storage_used_bytes)} of {formatBytes(t.storage_quota_bytes)} ({formatPercent(t.storage_quota_bytes ? t.storage_used_bytes / t.storage_quota_bytes : 0)})
              </p>
              <ProgressBar value={t.storage_quota_bytes ? t.storage_used_bytes / t.storage_quota_bytes : 0} label="Storage used" />
            </div>
            {Object.keys(t.quotas ?? {}).length > 0 && (
              <div className="mt-4">
                <p className="mb-1 text-sm font-medium">Quotas</p>
                <KeyValue items={Object.entries(t.quotas).map(([k, v]) => [k, v.toLocaleString()])} />
              </div>
            )}
          </Card>
        </div>
      )}
    </QueryState>
  );
}
