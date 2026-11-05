export const ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

const rank: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export type Permission =
  | "project.read"
  | "project.write"
  | "project.deploy"
  | "project.delete"
  | "members.manage"
  | "billing.manage"
  | "agents.manage"
  | "integrations.manage"
  | "workspace.delete";

const minRole: Record<Permission, Role> = {
  "project.read": "viewer",
  "project.write": "editor",
  "project.deploy": "editor",
  "agents.manage": "editor",
  "integrations.manage": "admin",
  "project.delete": "admin",
  "members.manage": "admin",
  "billing.manage": "owner",
  "workspace.delete": "owner",
};

export function can(role: Role | null | undefined, perm: Permission): boolean {
  if (!role) return false;
  return rank[role] >= rank[minRole[perm]];
}

/** An actor may only grant roles strictly below their own (owners may grant owner). */
export function canAssign(actor: Role, target: Role): boolean {
  return actor === "owner" || rank[actor] > rank[target];
}
