export const ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];
export const rank: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

/** Mirrors the API's rule: you may grant roles strictly below your own (owners may grant owner). */
export function assignable(actor: Role): Role[] {
  return ROLES.filter((r) => actor === "owner" || rank[actor] > rank[r]);
}

export function atLeast(role: string | null | undefined, min: Role): boolean {
  return !!role && role in rank && rank[role as Role] >= rank[min];
}
