"use client";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { UploadModelDialog } from "@/components/models/UploadModelDialog";
import { Badge, Button, Card, EmptyState, PageHeader, QueryState } from "@/components/ui";

export default function ModelsPage() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["models"], queryFn: api.models.list });
  const [uploadOpen, setUploadOpen] = useState(false);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Model registry"
        description="Versioned models with stage tags (staging, production, archived) and rollback. Register a training run, or upload your own ONNX model."
        actions={
          can("models.train") && (
            <Button variant="primary" onClick={() => setUploadOpen(true)}>
              Upload ONNX model
            </Button>
          )
        }
      />
      <Card bodyClassName="p-0">
        <QueryState query={q} empty={(l) => (l.length ? null : <div className="p-4"><EmptyState title="No registered models">Register the best run of an experiment, or upload an ONNX model.</EmptyState></div>)}>
          {(list) => (
            <ul className="divide-y divide-[var(--border)]">
              {list.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/models/${m.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">
                      {m.name}
                    </Link>
                    {m.description && <p className="truncate text-xs text-[var(--text-2)]">{m.description}</p>}
                  </div>
                  {m.production_version != null && <Badge tone="good">production v{m.production_version}</Badge>}
                  {m.latest_version != null && <span className="text-xs">latest v{m.latest_version}</span>}
                  <span className="text-xs text-[var(--text-2)]">{formatDate(m.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Card>
      <UploadModelDialog open={uploadOpen} onClose={() => setUploadOpen(false)} />
    </div>
  );
}
