"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { srcFromSelector } from "@forge/visual-edit/protocol";
import { useLocale, useT } from "@/i18n/client";
import { formatRelative } from "@/i18n/format";
import { useTRPC } from "@/lib/trpc";
import { ErrorNotice, EmptyState, LoadingBlock } from "@/components/Feedback";

export interface CommentTarget {
  selector?: string;
  path?: string;
  label: string;
}

/** Parse the line from a file-comment selector ("line:12"). */
export function lineFromSelector(selector: string | null | undefined): number | null {
  const m = /^line:(\d+)$/.exec(selector ?? "");
  return m ? Number(m[1]) : null;
}

export function CommentsPanel({ projectId, canComment, target, onClearTarget, onShowElement, onShowLine }: { projectId: string; canComment: boolean; target: CommentTarget | null; onClearTarget: () => void; onShowElement: (src: string) => void; onShowLine: (path: string, line: number | null) => void }) {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const comments = useQuery(trpc.project.comments.queryOptions({ projectId }));
  const [body, setBody] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.project.comments.queryKey({ projectId }) });
  const add = useMutation(trpc.project.addComment.mutationOptions({ onSuccess: invalidate }));
  const resolve = useMutation(trpc.project.resolveComment.mutationOptions({ onSuccess: invalidate }));
  const list = (comments.data ?? []).filter((c) => showResolved || !c.resolved);

  return (
    <div className="panel-pad stack">
      <div className="row-between">
        <h2 className="section-title-sm">{t("project.comments.title")}</h2>
        <label className="checkbox">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          {t("project.comments.showResolved")}
        </label>
      </div>
      {canComment && (
        <form
          className="stack card"
          style={{ gap: 10, padding: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!body.trim()) return;
            add.mutate(
              { projectId, body: body.trim(), selector: target?.selector, path: target?.path },
              {
                onSuccess: () => {
                  setBody("");
                  onClearTarget();
                },
              },
            );
          }}
        >
          <div className="row-between">
            <span className="badge">{target?.label ?? t("project.comments.general")}</span>
            {target && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={onClearTarget}>
                {t("common.remove")}
              </button>
            )}
          </div>
          <label htmlFor="comment-body" className="sr-only">
            {t("project.comments.placeholder")}
          </label>
          <textarea id="comment-body" className="textarea" rows={3} placeholder={t("project.comments.placeholder")} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />
          <ErrorNotice error={add.error} compact />
          <button type="submit" className="btn btn-primary btn-sm" style={{ justifySelf: "end" }} disabled={!body.trim() || add.isPending}>
            {t("project.comments.add")}
          </button>
        </form>
      )}
      {comments.isPending ? (
        <LoadingBlock rows={3} />
      ) : comments.isError ? (
        <ErrorNotice error={comments.error} />
      ) : list.length === 0 ? (
        <EmptyState title={t("project.comments.title")} body={t("project.comments.empty")} />
      ) : (
        <ul className="list">
          {list.map((c) => {
            const src = c.selector ? srcFromSelector(c.selector) : null;
            const line = lineFromSelector(c.selector);
            return (
              <li key={c.id} style={{ alignItems: "flex-start" }}>
                <div className="grow stack" style={{ gap: 4 }}>
                  <p>{c.body}</p>
                  <p className="hint">
                    {c.path ? t("project.comments.onLine", { path: c.path, line: line ?? 1 }) : src ? t("project.comments.onElement") : t("project.comments.general")} · {formatRelative(c.createdAt, locale)}
                  </p>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {(src || c.path) && (
                    <button type="button" className="btn btn-sm" onClick={() => (src ? onShowElement(src) : c.path && onShowLine(c.path, line))}>
                      {t("project.comments.show")}
                    </button>
                  )}
                  {c.resolved ? (
                    <span className="badge badge-ok">{t("project.comments.resolved")}</span>
                  ) : (
                    canComment && (
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => resolve.mutate({ projectId, commentId: c.id })}>
                        {t("project.comments.resolve")}
                      </button>
                    )
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ErrorNotice error={resolve.error} compact />
    </div>
  );
}
