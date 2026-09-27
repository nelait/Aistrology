/** Mirrors backend/app/auth/rbac.py (REQUIREMENTS.md Appendix A). The server is authoritative; this only drives the UI. */
import type { PermissionName, Role } from "./types";

const BUILDER: PermissionName[] = [
  "data.write",
  "pipelines.edit",
  "data.read",
  "analytics.create",
  "dashboards.edit",
  "view",
  "endpoints.predict",
];

const ALL: PermissionName[] = [
  "tenant.manage",
  "audit.view",
  "data.write",
  "pipelines.edit",
  "data.read",
  "analytics.create",
  "models.train",
  "endpoints.deploy",
  "dashboards.edit",
  "view",
  "endpoints.predict",
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<PermissionName>> = {
  admin: new Set(ALL),
  data_engineer: new Set([...BUILDER, "endpoints.deploy"]),
  data_scientist: new Set([...BUILDER, "models.train", "endpoints.deploy"]),
  analyst: new Set(BUILDER),
  viewer: new Set(["view", "data.read"]),
};

export const ALL_PERMISSIONS = ALL;

export function can(role: Role | null | undefined, permission: PermissionName): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  data_engineer: "Data engineer",
  data_scientist: "Data scientist",
  analyst: "Analyst",
  viewer: "Viewer",
};
