"use client";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, API_URL } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { Button, Checkbox, CopyButton, Modal, SelectField, TextField } from "../ui";

/** Share inside the tenant with view or edit rights (SHR-001, SHR-002). */
export function ShareDialog({ dashboardId, open, onClose }: { dashboardId: string; open: boolean; onClose: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const users = useQuery({ queryKey: ["users"], queryFn: api.tenant.users, enabled: open && can("tenant.manage"), meta: { silent: true } });
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const embed = useMutation({ mutationFn: () => api.dashboards.embedToken(dashboardId, 24 * 60) });
  const share = useMutation({
    mutationFn: () => api.dashboards.share(dashboardId, userId, role),
    onSuccess: () => {
      toast.success("Dashboard shared");
      setUserId("");
      onClose();
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Share dashboard"
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => share.mutate()} loading={share.isPending} disabled={!userId}>
            Share
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {users.data ? (
          <SelectField
            label="Share with"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            options={[{ value: "*", label: "Everyone in the organization" }, ...users.data.filter((u) => !u.disabled).map((u) => ({ value: u.id, label: `${u.name ?? u.email} (${u.email})` }))]}
            placeholder="Choose a teammate…"
          />
        ) : (
          <>
            <Checkbox label="Everyone in the organization" checked={userId === "*"} onChange={(e) => setUserId(e.target.checked ? "*" : "")} />
            {userId !== "*" && <TextField label="User ID" value={userId} onChange={(e) => setUserId(e.target.value)} hint="Ask an admin for the teammate's user ID." />}
          </>
        )}
        <SelectField
          label="Permission"
          value={role}
          onChange={(e) => setRole(e.target.value as "viewer" | "editor")}
          options={[
            { value: "viewer", label: "Can view" },
            { value: "editor", label: "Can edit" },
          ]}
        />
        <div className="border-t border-[var(--border)] pt-3">
          <p className="mb-2 text-sm font-medium">Embed in another site</p>
          <Button size="sm" onClick={() => embed.mutate()} loading={embed.isPending}>
            Create signed embed link (valid 24 h)
          </Button>
          {embed.data && (
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-[var(--surface-2)] p-2 font-mono text-[10px]">{`${API_URL}${embed.data.embed_path}`}</code>
              <CopyButton text={`${API_URL}${embed.data.embed_path}`} />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
