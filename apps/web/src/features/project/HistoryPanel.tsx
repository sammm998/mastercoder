"use client";

import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { formatDate } from "@/i18n/format";
import { useTRPC } from "@/lib/trpc";
import type { ForgeEvent } from "@/lib/events";
import { ErrorNotice, EmptyState, LoadingBlock } from "@/components/Feedback";

/** Checkpoint timeline with one-click restore (code + database branch, via the build worker). */
export function HistoryPanel({ projectId, events, canWrite, restore }: { projectId: string; events: ForgeEvent[]; canWrite: boolean; restore: { run: (id: string, label: string) => void; pendingId: string | null; error: unknown; doneId: string | null } }) {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const checkpoints = useQuery({ ...trpc.project.checkpoints.queryOptions({ projectId }), enabled: canWrite });
  const lastCp = useMemo(() => [...events].reverse().find((e) => e.type === "checkpoint.created")?.id, [events]);
  useEffect(() => {
    if (lastCp) void qc.invalidateQueries({ queryKey: trpc.project.checkpoints.queryKey({ projectId }) });
  }, [lastCp, qc, trpc, projectId]);

  return (
    <div className="panel-pad stack">
      <div>
        <h2 className="section-title-sm">{t("project.history.title")}</h2>
        <p className="muted">{t("project.history.lede")}</p>
      </div>
      {restore.doneId && (
        <p className="notice notice-ok" role="status">
          {t("project.history.queued")}
        </p>
      )}
      <ErrorNotice error={restore.error} />
      {checkpoints.isPending ? (
        <LoadingBlock rows={4} />
      ) : checkpoints.isError ? (
        <ErrorNotice error={checkpoints.error} />
      ) : checkpoints.data.length === 0 ? (
        <EmptyState title={t("project.history.title")} body={t("project.history.empty")} />
      ) : (
        <ol className="timeline" data-testid="checkpoints">
          {checkpoints.data.map((cp) => (
            <li key={cp.id}>
              <div className="row-between">
                <div>
                  <p style={{ fontWeight: 560 }}>{cp.label}</p>
                  <p className="hint">
                    {formatDate(cp.createdAt, locale)} · <span className="mono">{t("project.history.commit", { sha: cp.commitSha.slice(0, 7) })}</span>
                  </p>
                </div>
                {canWrite && (
                  <button type="button" className="btn btn-sm" disabled={restore.pendingId === cp.id} onClick={() => restore.run(cp.id, cp.label)}>
                    {t("project.history.restore")}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Shared restore action (used by the timeline and checkpoint cards in chat). */
export function useRestore(projectId: string) {
  const t = useT();
  const trpc = useTRPC();
  const m = useMutation(trpc.project.restoreCheckpoint.mutationOptions());
  return {
    run: (checkpointId: string, label: string) => {
      if (window.confirm(t("project.history.confirm", { label }))) m.mutate({ projectId, checkpointId });
    },
    pendingId: m.isPending ? (m.variables?.checkpointId ?? null) : null,
    doneId: m.isSuccess ? (m.variables?.checkpointId ?? null) : null,
    error: m.error,
  };
}
