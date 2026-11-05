"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useT } from "@/i18n/client";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import { stripAnsi, type ForgeEvent } from "@/lib/events";
import { initials, type Peer } from "@/lib/collab";
import { ErrorNotice, LoadingBlock } from "@/components/Feedback";
import { Icon } from "@/components/Icon";
import { buildTree, validPath, type TreeNode } from "./file-tree";
import type { CollabHandle, CollabStatus } from "./CollabEditor";

const CollabEditor = dynamic(() => import("./CollabEditor"), { ssr: false, loading: () => <div className="monaco-host skeleton" /> });
const DiffView = dynamic(() => import("./DiffView"), { ssr: false, loading: () => <div className="monaco-host skeleton" /> });

type View = "code" | "diff" | "terminal";

function Tree({ nodes, open, toggle, active, onOpen, depth = 0 }: { nodes: TreeNode[]; open: Set<string>; toggle: (p: string) => void; active: string | null; onOpen: (p: string) => void; depth?: number }) {
  return (
    <ul className="tree" role={depth === 0 ? "tree" : "group"}>
      {nodes.map((n) =>
        n.children ? (
          <li key={n.path} role="treeitem" aria-expanded={open.has(n.path)} aria-selected={false}>
            <button type="button" className="tree-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(n.path)}>
              <Icon name="folder" size={14} />
              {n.name}
            </button>
            {open.has(n.path) && <Tree nodes={n.children} open={open} toggle={toggle} active={active} onOpen={onOpen} depth={depth + 1} />}
          </li>
        ) : (
          <li key={n.path} role="treeitem" aria-selected={active === n.path}>
            <button type="button" className="tree-row" data-active={active === n.path} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onOpen(n.path)} data-testid={`file-${n.path}`}>
              <Icon name="file" size={14} />
              {n.name}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

export function CodePane({
  projectId,
  userName,
  canWrite,
  events,
  onCollab,
  requestedFile,
  onCommentLine,
}: {
  projectId: string;
  userName: string;
  canWrite: boolean;
  events: ForgeEvent[];
  onCollab: (path: string | null, h: CollabHandle | null) => void;
  requestedFile?: { path: string; line?: number; nonce: number } | null;
  onCommentLine: (path: string, line: number) => void;
}) {
  const t = useT();
  const trpc = useTRPC();
  const client = useTRPCClient();
  const qc = useQueryClient();
  const files = useQuery(trpc.project.files.queryOptions({ projectId }));
  const [active, setActive] = useState<string | null>(null);
  const [view, setView] = useState<View>("code");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [peers, setPeers] = useState<Peer[]>([]);
  const [status, setStatus] = useState<CollabStatus>("connecting");
  const [newPath, setNewPath] = useState("");
  const handle = useRef<CollabHandle | null>(null);
  const baselines = useRef(new Map<string, { content: string; label: string }>());
  const [diff, setDiff] = useState<{ original: string; modified: string; label: string } | null>(null);
  const writeFile = useMutation(trpc.project.writeFile.mutationOptions());

  const tree = useMemo(() => buildTree((files.data ?? []).map((f) => f.path)), [files.data]);

  // Refresh the file list when files change (agent writes, visual edits, other editors).
  const lastFileEvent = useMemo(() => [...events].reverse().find((e) => e.type === "file.changed")?.id, [events]);
  useEffect(() => {
    if (lastFileEvent) void qc.invalidateQueries({ queryKey: trpc.project.files.queryKey({ projectId }) });
  }, [lastFileEvent, qc, trpc, projectId]);

  // A new checkpoint resets the diff baseline: changes are shown relative to it from now on.
  const lastCheckpoint = useMemo(() => [...events].reverse().find((e) => e.type === "checkpoint.created"), [events]);
  useEffect(() => {
    if (lastCheckpoint) baselines.current.clear();
  }, [lastCheckpoint]);

  const openFile = (path: string) => {
    setActive(path);
    if (view === "terminal") setView("code");
    const parts = path.split("/");
    setOpen((cur) => {
      const next = new Set(cur);
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  };

  useEffect(() => {
    if (requestedFile) openFile(requestedFile.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedFile?.nonce]);

  useEffect(() => {
    if (!files.data?.length || active) return;
    const preferred = ["src/App.tsx", "app/page.tsx", "src/app/page.tsx", "index.html", "README.md"].find((p) => files.data.some((f) => f.path === p));
    if (preferred) openFile(preferred);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.data]);

  // Capture a baseline the first time a file is opened (or after a checkpoint).
  useEffect(() => {
    if (!active || baselines.current.has(active)) return;
    let cancelled = false;
    void client.project.readFile.query({ projectId, path: active }).then(
      (f) => {
        if (!cancelled && !baselines.current.has(active))
          baselines.current.set(active, { content: f.content, label: lastCheckpoint?.type === "checkpoint.created" ? lastCheckpoint.label : "" });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [active, client, projectId, lastCheckpoint]);

  const showDiff = async () => {
    setView("diff");
    if (!active) return;
    const base = baselines.current.get(active);
    const current = handle.current ? handle.current.ytext.toString() : (await client.project.readFile.query({ projectId, path: active })).content;
    setDiff({ original: base?.content ?? current, modified: current, label: base?.label ?? "" });
  };

  const terminal = useMemo(() => events.filter((e): e is Extract<ForgeEvent, { type: "terminal.output" }> => e.type === "terminal.output").slice(-1500), [events]);
  const termRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = termRef.current;
    if (el && view === "terminal") el.scrollTop = el.scrollHeight;
  }, [terminal.length, view]);

  const createFile = (e: React.FormEvent) => {
    e.preventDefault();
    const p = newPath.trim().replace(/^\.\//, "");
    if (!validPath(p)) return;
    writeFile.mutate(
      { projectId, path: p, content: "" },
      {
        onSuccess: async () => {
          setNewPath("");
          await qc.invalidateQueries({ queryKey: trpc.project.files.queryKey({ projectId }) });
          openFile(p);
        },
      },
    );
  };

  return (
    <div className="code-pane">
      <aside className="code-files" aria-label={t("project.code.files")}>
        <div className="code-files-head">
          <span className="eyebrow">{t("project.code.files")}</span>
        </div>
        {files.isPending ? (
          <div style={{ padding: 12 }}>
            <LoadingBlock rows={4} />
          </div>
        ) : files.isError ? (
          <div style={{ padding: 12 }}>
            <ErrorNotice error={files.error} compact />
          </div>
        ) : files.data.length === 0 ? (
          <p className="subtle" style={{ padding: 12, fontSize: "0.84rem" }}>
            {t("project.code.noFiles")}
          </p>
        ) : (
          <Tree nodes={tree} open={open} toggle={(p) => setOpen((cur) => (cur.has(p) ? new Set([...cur].filter((x) => x !== p)) : new Set([...cur, p])))} active={active} onOpen={openFile} />
        )}
        {canWrite && (
          <form className="code-newfile" onSubmit={createFile}>
            <label htmlFor="new-file" className="sr-only">
              {t("project.code.newFile")}
            </label>
            <input id="new-file" className="input" placeholder={t("project.code.newFilePlaceholder")} value={newPath} onChange={(e) => setNewPath(e.target.value)} aria-invalid={newPath.length > 0 && !validPath(newPath.trim())} data-testid="new-file-path" />
            <button type="submit" className="btn btn-sm btn-icon" aria-label={t("project.code.newFile")} disabled={!validPath(newPath.trim()) || writeFile.isPending} data-testid="new-file-submit">
              <Icon name="plus" size={14} />
            </button>
          </form>
        )}
        <ErrorNotice error={writeFile.error} compact />
      </aside>
      <section className="code-main" aria-label={active ?? t("project.code.editor")}>
        <div className="code-toolbar">
          <div className="tabs" role="tablist" aria-label={t("project.code.views")}>
            {(["code", "diff", "terminal"] as const).map((v) => (
              <button key={v} type="button" role="tab" className="tab" aria-selected={view === v} onClick={() => (v === "diff" ? void showDiff() : setView(v))}>
                {t(`project.code.view.${v}`)}
              </button>
            ))}
          </div>
          <span className="mono subtle code-path">{active}</span>
          {view === "code" && active && (
            <div className="row" style={{ gap: 8 }} data-testid="editor-presence" data-count={peers.length}>
              <span className={`dot status-${status}`} title={t(`project.code.status.${status}`)} aria-label={t(`project.code.status.${status}`)} />
              <div className="avatars" aria-label={t("project.code.editingNow", { count: peers.length })}>
                {peers.map((p) => (
                  <span key={p.clientId} className="avatar" style={{ ["--c" as string]: p.color }} title={p.self ? `${p.name} (${t("common.you")})` : p.name} data-peer={p.name}>
                    {initials(p.name)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="code-body">
          {view === "terminal" ? (
            <pre ref={termRef} className="log terminal" aria-live="off" tabIndex={0} aria-label={t("project.code.view.terminal")} data-testid="terminal">
              {terminal.length === 0 ? (
                <span className="dim">{t("project.code.terminalEmpty")}</span>
              ) : (
                terminal.map((e) => (
                  <span key={e.id} className={e.stream === "stderr" ? "err" : undefined}>
                    {stripAnsi(e.text)}
                  </span>
                ))
              )}
            </pre>
          ) : !active ? (
            <div className="code-empty">
              <p className="muted">{t("project.code.pickFile")}</p>
            </div>
          ) : view === "diff" ? (
            <div className="code-diff">
              <p className="hint" style={{ padding: "6px 12px" }}>
                {diff?.label ? t("project.code.diffSinceCheckpoint", { label: diff.label }) : t("project.code.diffSinceOpened")}
              </p>
              {diff && <DiffView path={active} original={diff.original} modified={diff.modified} />}
            </div>
          ) : status === "denied" ? (
            <div className="code-empty">
              <ErrorNotice error={new Error(t("project.code.denied"))} />
            </div>
          ) : (
            <CollabEditor
              key={`${projectId}:${active}`}
              projectId={projectId}
              path={active}
              userName={userName}
              readOnly={!canWrite}
              onPeers={setPeers}
              onStatus={setStatus}
              onReady={(h) => {
                handle.current = h;
                onCollab(h ? active : null, h);
              }}
              onCommentLine={(line) => onCommentLine(active, line)}
              commentLabel={t("project.code.commentLine")}
            />
          )}
        </div>
      </section>
    </div>
  );
}
