"use client";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { Button, Modal, SelectField, TextField } from "../ui";

/** Share inside the tenant with view or edit rights (SHR-001, SHR-002). */
export function ShareDialog({ dashboardId, open, onClose }: { dashboardId: string; open: boolean; onClose: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const users = useQuery({ queryKey: ["users"], queryFn: api.tenant.users, enabled: open && can("tenant.manage"), meta: { silent: true } });
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
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
          <SelectField label="Person" value={userId} onChange={(e) => setUserId(e.target.value)} options={users.data.filter((u) => !u.disabled).map((u) => ({ value: u.id, label: `${u.name ?? u.email} (${u.email})` }))} placeholder="Choose a teammate…" />
        ) : (
          <TextField label="User ID" value={userId} onChange={(e) => setUserId(e.target.value)} hint="Ask an admin for the teammate's user ID." />
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
      </div>
    </Modal>
  );
}
