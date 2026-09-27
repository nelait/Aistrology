"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { DeployForm } from "@/components/DeployForm";
import { Badge, Button, Card, EmptyState, Modal, PageHeader, QueryState } from "@/components/ui";

export default function EndpointsPage() {
  const { can } = useAuth();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const toast = useToast();
  const deployModel = params.get("deploy");
  const deployVersion = params.get("version");
  const q = useQuery({ queryKey: ["endpoints"], queryFn: api.endpoints.list });
  const models = useQuery({ queryKey: ["models"], queryFn: api.models.list });
  const open = params.has("deploy");

  return (
    <div className="space-y-5">
      <PageHeader
        title="Endpoints"
        description="Serve registered models over REST with autoscaling, A/B routing, usage metrics and per-endpoint OpenAPI docs."
        actions={
          can("endpoints.deploy") && (
            <Button variant="primary" onClick={() => router.replace(`${pathname}?deploy=`)}>
              Deploy a model
            </Button>
          )
        }
      />
      <Card bodyClassName="p-0">
        <QueryState query={q} empty={(l) => (l.length ? null : <div className="p-4"><EmptyState title="No endpoints">Deploy a registered model to get a prediction URL.</EmptyState></div>)}>
          {(list) => (
            <ul className="divide-y divide-[var(--border)]">
              {list.map((e) => (
                <li key={e.name} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/endpoints/${encodeURIComponent(e.name)}`} className="font-mono font-medium text-brand-700 hover:underline dark:text-brand-300">
                      {e.name}
                    </Link>
                    <p className="text-xs text-[var(--text-2)]">
                      {e.routes
                        .map((r) => `${models.data?.find((m) => m.id === r.model_id)?.name ?? r.model_id} v${r.version}${e.routes.length > 1 ? ` (${r.weight}%)` : ""}`)
                        .join(" · ")}
                    </p>
                  </div>
                  <Badge tone={e.status === "active" ? "good" : "warning"}>{e.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Card>
      <Modal open={open} onClose={() => router.replace(pathname)} title="Deploy a model" size="lg">
        {open && (
          <DeployForm
            initialModel={deployModel || undefined}
            initialVersion={deployVersion ? Number(deployVersion) : undefined}
            onDone={(e) => {
              toast.success(`Deployed ${e.name}`);
              qc.invalidateQueries({ queryKey: ["endpoints"] });
              router.push(`/endpoints/${encodeURIComponent(e.name)}`);
            }}
          />
        )}
      </Modal>
    </div>
  );
}
