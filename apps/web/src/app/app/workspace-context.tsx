"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTRPC, type RouterOutputs } from "@/lib/trpc";

export type SessionUser = NonNullable<RouterOutputs["auth"]["me"]>;
export type WorkspaceRow = RouterOutputs["workspace"]["list"][number];

interface WorkspaceValue {
  user: SessionUser;
  workspaces: WorkspaceRow[];
  workspace: WorkspaceRow;
  setWorkspaceId(id: string): void;
}

const Ctx = createContext<WorkspaceValue | null>(null);
const STORAGE_KEY = "forge_ws";

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Picks the active workspace (remembered per browser) from the user's memberships. */
export function useWorkspaceSelection(workspaces: WorkspaceRow[] | undefined) {
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    setSelected(readStored());
  }, []);
  const current = useMemo(() => {
    if (!workspaces?.length) return null;
    return workspaces.find((w) => w.id === selected) ?? workspaces[0]!;
  }, [workspaces, selected]);
  const set = useCallback((id: string) => {
    setSelected(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* storage unavailable */
    }
  }, []);
  return { current, set };
}

export function WorkspaceProvider({ user, workspaces, workspace, setWorkspaceId, children }: WorkspaceValue & { children: ReactNode }) {
  const value = useMemo(() => ({ user, workspaces, workspace, setWorkspaceId }), [user, workspaces, workspace, setWorkspaceId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace must be used inside the app shell");
  return v;
}

/** Workspace list query shared by the shell and pages. */
export function useWorkspacesQuery(enabled: boolean) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.workspace.list.queryOptions(), enabled });
}
