import { useCallback, useEffect, useState } from "react";
import { trpc } from "../api";
import { kv } from "../storage";

const KEY = "forge.workspace";

/** The user's workspaces plus the selected one (persisted; defaults to the first). */
export function useWorkspace() {
  const list = trpc.workspace.list.useQuery();
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    void kv.getItem(KEY).then((v) => v && setSelected(v));
  }, []);
  const workspaces = list.data ?? [];
  const current = workspaces.find((w) => w.id === selected) ?? workspaces[0] ?? null;
  const select = useCallback((id: string) => {
    setSelected(id);
    void kv.setItem(KEY, id);
  }, []);
  return { workspaces, current, select, isLoading: list.isLoading, error: list.error, refetch: list.refetch };
}
