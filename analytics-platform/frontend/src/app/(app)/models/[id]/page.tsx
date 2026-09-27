"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Stage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatNumber } from "@/lib/format";
import { signatureFields } from "@/lib/signature";
import { useToast } from "@/lib/toast";
import { Badge, Card, PageHeader, QueryState, SelectField } from "@/components/ui";

const STAGE_TONE = { none: "neutral", staging: "warning", production: "good", archived: "neutral" } as const;

export default function ModelPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["model", id], queryFn: () => api.models.get(id) });
  const stage = useMutation({
    mutationFn: ({ version, stage }: { version: number; stage: Stage }) => api.models.setStage(id, version, stage),
    onSuccess: (_r, v) => {
      toast.success(`v${v.version} → ${v.stage}`);
      qc.invalidateQueries({ queryKey: ["model", id] });
    },
  });

  return (
    <QueryState query={q}>
      {({ model, versions }) => (
        <div className="space-y-5">
          <PageHeader
            breadcrumb={
              <>
                <Link href="/models" className="hover:underline">
                  Models
                </Link>{" "}
                / {model.name}
              </>
            }
            title={model.name}
            description={model.description ?? undefined}
            actions={
              can("endpoints.deploy") && (
                <Link href={`/endpoints?deploy=${encodeURIComponent(model.id)}`} className="rounded-md bg-brand-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-700">
                  Deploy
                </Link>
              )
            }
          />
          <Card title="Versions" bodyClassName="p-0 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Model versions</caption>
              <thead className="bg-[var(--surface-2)] text-xs">
                <tr>
                  <th scope="col" className="px-3 py-2">Version</th>
                  <th scope="col" className="px-3 py-2">Stage</th>
                  <th scope="col" className="px-3 py-2">Metrics</th>
                  <th scope="col" className="px-3 py-2">Inputs</th>
                  <th scope="col" className="px-3 py-2">Run</th>
                  <th scope="col" className="px-3 py-2">Created</th>
                  <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {[...versions]
                  .sort((a, b) => b.version - a.version)
                  .map((v) => (
                    <tr key={v.version} className="border-t border-[var(--border)] align-top">
                      <td className="px-3 py-2 font-medium">
                        v{v.version}
                        {v.algorithm && <span className="block text-xs font-normal text-[var(--text-2)]">{v.algorithm}</span>}
                      </td>
                      <td className="px-3 py-2">
                        {can("endpoints.deploy") ? (
                          <SelectField
                            label={`Stage of v${v.version}`}
                            srOnlyLabel
                            value={v.stage}
                            onChange={(e) => stage.mutate({ version: v.version, stage: e.target.value as Stage })}
                            options={["none", "staging", "production", "archived"].map((s) => ({ value: s, label: s }))}
                          />
                        ) : (
                          <Badge tone={STAGE_TONE[v.stage] ?? "neutral"}>{v.stage}</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {Object.entries(v.metrics ?? {})
                          .slice(0, 5)
                          .map(([k, m]) => (
                            <span key={k} className="mr-2 whitespace-nowrap">
                              <span className="font-mono">{k}</span> {formatNumber(m, 4)}
                            </span>
                          ))}
                      </td>
                      <td className="max-w-xs px-3 py-2 text-xs">
                        {signatureFields(v.signature)
                          .map((f) => `${f.name}:${f.type}`)
                          .join(", ") || "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{v.run_id?.slice(0, 8)}</td>
                      <td className="px-3 py-2 text-xs">{formatDate(v.created_at)}</td>
                      <td className="px-3 py-2">
                        {can("endpoints.deploy") && (
                          <Link href={`/endpoints?deploy=${encodeURIComponent(model.id)}&version=${v.version}`} className="text-xs text-brand-600 underline dark:text-brand-300">
                            Deploy v{v.version}
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </Card>
          <p className="text-xs text-[var(--text-2)]">Rollback: move an earlier version back to “production”. Endpoints serving the model follow the production stage unless pinned to a version.</p>
        </div>
      )}
    </QueryState>
  );
}
