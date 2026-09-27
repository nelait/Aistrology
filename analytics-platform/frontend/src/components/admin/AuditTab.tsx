"use client";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { exportRows } from "@/lib/data";
import { formatDate } from "@/lib/format";
import { Badge, Button, Card, QueryState, TextField } from "../ui";

/** Tamper-evident audit log (AUTH-005) with filter, export and hash-chain verification. */
export function AuditTab() {
  const [action, setAction] = useState("");
  const [applied, setApplied] = useState("");
  const q = useQuery({ queryKey: ["audit", applied], queryFn: () => api.tenant.audit(applied || undefined) });
  const verify = useMutation({ mutationFn: api.tenant.verifyAudit });
  return (
    <Card
      title="Audit log"
      bodyClassName="p-0"
      actions={
        <>
          {verify.data && (
            <span aria-live="polite">{verify.data.valid ? <Badge tone="good">✓ Chain intact</Badge> : <Badge tone="critical">✕ Chain broken — possible tampering</Badge>}</span>
          )}
          <Button size="sm" onClick={() => verify.mutate()} loading={verify.isPending}>
            Verify chain
          </Button>
          {q.data && (
            <Button size="sm" onClick={() => exportRows(["seq", "at", "actor", "action", "detail", "prev_hash", "hash"], q.data.map((e) => ({ ...e, detail: JSON.stringify(e.detail) })), "csv", "audit-log")}>
              Export CSV
            </Button>
          )}
        </>
      }
    >
      <form
        className="flex flex-wrap items-end gap-2 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(action.trim());
        }}
      >
        <TextField label="Filter by action" placeholder="e.g. dataset.upload" value={action} onChange={(e) => setAction(e.target.value)} />
        <Button type="submit">Filter</Button>
        {applied && (
          <Button variant="ghost" onClick={() => { setAction(""); setApplied(""); }}>
            Clear
          </Button>
        )}
      </form>
      <QueryState query={q}>
        {(entries) => (
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Audit entries</caption>
              <thead className="sticky top-0 bg-[var(--surface-2)]">
                <tr>
                  <th scope="col" className="px-3 py-2">#</th>
                  <th scope="col" className="px-3 py-2">Time</th>
                  <th scope="col" className="px-3 py-2">Actor</th>
                  <th scope="col" className="px-3 py-2">Action</th>
                  <th scope="col" className="px-3 py-2">Detail</th>
                  <th scope="col" className="px-3 py-2">Hash</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.seq} className="border-t border-[var(--border)] align-top">
                    <td className="px-3 py-1.5 tabular-nums">{e.seq}</td>
                    <td className="whitespace-nowrap px-3 py-1.5">{formatDate(e.at)}</td>
                    <td className="px-3 py-1.5 font-mono">{e.actor}</td>
                    <td className="px-3 py-1.5 font-mono">{e.action}</td>
                    <td className="max-w-md break-words px-3 py-1.5 font-mono text-[10px]">{JSON.stringify(e.detail)}</td>
                    <td className="px-3 py-1.5 font-mono text-[10px]" title={e.hash}>
                      {e.hash.slice(0, 10)}
                    </td>
                  </tr>
                ))}
                {!entries.length && (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-[var(--text-2)]">
                      No entries
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>
    </Card>
  );
}
