"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translate";
import { useTRPC } from "@/lib/trpc";
import { ErrorNotice, LoadingBlock } from "@/components/Feedback";
import { Icon } from "@/components/Icon";

const CATEGORIES = ["all", "crm", "chat", "email", "productivity", "calendar", "dev", "payments", "database"] as const;
type Category = (typeof CATEGORIES)[number];

/** Stable pastel hue per app for its monogram (no third-party logos are bundled). */
function hueFor(slug: string): number {
  let h = 0;
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function Monogram({ app, name }: { app: string; name: string }) {
  return (
    <span className="ig-mono" style={{ ["--h" as string]: String(hueFor(app)) }} aria-hidden="true">
      {name.replace(/^Microsoft /, "").slice(0, 1)}
    </span>
  );
}

type Conn = { id: string; app: string; status: string; scope: "project" | "workspace"; provider: string; scopes: unknown; createdAt: string | Date };

/**
 * App catalog + connections. With `projectId` connections are made for that project only (its own
 * accounts, used by its builds); without it they are shared by every project in the workspace.
 */
export function AppCatalog({ workspaceId, projectId, canConnect, canManageShared }: { workspaceId: string; projectId?: string; canConnect: boolean; canManageShared: boolean }) {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const apps = useQuery(trpc.integrations.apps.queryOptions({ locale }));
  const connQuery = trpc.integrations.connections.queryOptions({ workspaceId, projectId });
  const conns = useQuery(connQuery);
  const inv = () => qc.invalidateQueries({ queryKey: connQuery.queryKey });
  const connect = useMutation(trpc.integrations.connect.mutationOptions({ onSuccess: (r) => window.location.assign(r.redirectUrl) }));
  const revoke = useMutation(trpc.integrations.revoke.mutationOptions({ onSuccess: inv }));
  const refresh = useMutation(trpc.integrations.refresh.mutationOptions({ onSuccess: inv }));
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<Category>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, Set<string>>>({});

  // Back from the provider's consent screen (?connected=<id>): confirm the status once.
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current) return;
    const id = new URLSearchParams(window.location.search).get("connected");
    if (!id) return;
    checked.current = true;
    refresh.mutate({ connectionId: id });
  }, [refresh]);

  const live = useMemo(() => ((conns.data ?? []) as Conn[]).filter((c) => c.status !== "revoked"), [conns.data]);
  const byApp = useMemo(() => {
    const m = new Map<string, Conn>();
    // A project's own connection wins over a shared one for the same app.
    for (const c of live) if (!m.has(c.app) || (c.scope === "project" && m.get(c.app)?.scope !== "project")) m.set(c.app, c);
    return m;
  }, [live]);
  const list = useMemo(
    () =>
      (apps.data ?? []).filter(
        (a) => (cat === "all" || a.category === cat) && (!q || a.name.toLowerCase().includes(q.toLowerCase()) || a.app.includes(q.toLowerCase())),
      ),
    [apps.data, q, cat],
  );
  const present = useMemo(() => new Set((apps.data ?? []).map((a) => a.category)), [apps.data]);
  const scopesFor = (app: string, all: string[]) => picked[app] ?? new Set(all);
  const appName = (slug: string) => apps.data?.find((a) => a.app === slug)?.name ?? slug;
  const canRevoke = (c: Conn) => (c.scope === "project" ? canConnect : canManageShared);

  return (
    <div className="ig">
      <section className="ig-connected card" aria-labelledby="ig-connected-title">
        <div className="ig-head">
          <h2 id="ig-connected-title" className="section-title-sm">
            {projectId ? t("integrations.inProject") : t("integrations.connections")}
          </h2>
          <span className="hint">{projectId ? t("integrations.projectHint") : t("integrations.workspaceHint")}</span>
        </div>
        {conns.isPending ? (
          <LoadingBlock rows={2} />
        ) : conns.isError ? (
          <ErrorNotice error={conns.error} service="connectors" />
        ) : live.length === 0 ? (
          <p className="ig-empty">{t("integrations.noConnections")}</p>
        ) : (
          <ul className="ig-conn-list">
            {live.map((c) => (
              <li key={c.id} className="ig-conn">
                <Monogram app={c.app} name={appName(c.app)} />
                <div className="ig-conn-text">
                  <strong>{appName(c.app)}</strong>
                  <span className="hint">
                    {c.scope === "project" ? t("integrations.scopeProject") : t("integrations.scopeWorkspace")} · {t("integrations.provider", { provider: c.provider })}
                  </span>
                </div>
                <span className={`badge ${c.status === "active" ? "badge-ok" : c.status === "failed" || c.status === "expired" ? "badge-bad" : "badge-warn"}`}>
                  {t(`integrations.status.${c.status}` as MessageKey)}
                </span>
                {c.provider !== "openapi" && c.provider !== "mcp" && (
                  <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={t("integrations.refresh")} title={t("integrations.refresh")} onClick={() => refresh.mutate({ connectionId: c.id })}>
                    <Icon name="refresh" size={14} />
                  </button>
                )}
                {canRevoke(c) && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => window.confirm(t("integrations.revokeConfirm", { app: appName(c.app) })) && revoke.mutate({ connectionId: c.id })}>
                    {t("integrations.revoke")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <ErrorNotice error={revoke.error ?? refresh.error} service="connectors" compact />
      </section>

      <section className="ig-catalog" aria-labelledby="ig-catalog-title">
        <div className="ig-toolbar">
          <h2 id="ig-catalog-title" className="section-title-sm">
            {t("integrations.catalog")}
          </h2>
          <label className="ig-search">
            <Icon name="search" size={14} />
            <span className="sr-only">{t("integrations.search")}</span>
            <input type="search" placeholder={t("integrations.search")} value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        </div>
        <div className="ig-cats" role="group" aria-label={t("integrations.categories")}>
          {CATEGORIES.filter((c) => c === "all" || present.has(c)).map((c) => (
            <button key={c} type="button" className="ig-cat" aria-pressed={cat === c} onClick={() => setCat(c)}>
              {t(`integrations.category.${c}` as MessageKey)}
            </button>
          ))}
        </div>
        {apps.isPending ? (
          <LoadingBlock rows={3} />
        ) : apps.isError ? (
          <ErrorNotice error={apps.error} service="connectors" />
        ) : list.length === 0 ? (
          <p className="ig-empty">{t("integrations.noMatch")}</p>
        ) : (
          <ul className="ig-grid">
            {list.map((a) => {
              const all = a.scopes.map((s) => s.id);
              const selected = scopesFor(a.app, all);
              const conn = byApp.get(a.app);
              const expanded = open === a.app;
              const busy = connect.isPending && connect.variables?.app === a.app;
              return (
                <li key={a.app} className="ig-card" data-connected={!!conn}>
                  <div className="ig-card-top">
                    <Monogram app={a.app} name={a.name} />
                    <div className="ig-card-title">
                      <h3>{a.name}</h3>
                      <span className="hint">{t(`integrations.category.${a.category}` as MessageKey)}</span>
                    </div>
                    {conn && <span className={`badge ${conn.status === "active" ? "badge-ok" : "badge-warn"}`}>{conn.scope === "project" ? t("integrations.connectedHere") : t("integrations.connectedShared")}</span>}
                  </div>
                  <button type="button" className="ig-perm-toggle" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : a.app)}>
                    <Icon name="key" size={12} />
                    {t("integrations.permissionCount", { count: selected.size, total: all.length })}
                    <span className="ig-chev" data-open={expanded}>
                      <Icon name="chevron" size={12} />
                    </span>
                  </button>
                  {expanded && (
                    <fieldset className="ig-perms">
                      <legend className="sr-only">{t("integrations.scopes")}</legend>
                      {a.scopes.map((s) => (
                        <label key={s.id} className="ig-perm">
                          <input
                            type="checkbox"
                            checked={selected.has(s.id)}
                            onChange={(e) =>
                              setPicked((cur) => {
                                const next = new Set(scopesFor(a.app, all));
                                if (e.target.checked) next.add(s.id);
                                else next.delete(s.id);
                                return { ...cur, [a.app]: next };
                              })
                            }
                          />
                          <span>
                            {s.description}
                            <code>{s.id}</code>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <div className="ig-card-foot">
                    <button
                      type="button"
                      className={`btn btn-sm ${conn?.scope === "project" || (!projectId && conn) ? "btn-ghost" : "btn-primary"}`}
                      disabled={!canConnect || busy || selected.size === 0}
                      onClick={() => connect.mutate({ workspaceId, projectId, app: a.app, scopes: [...selected] })}
                    >
                      {busy ? t("integrations.connecting") : conn && (conn.scope === "project" || !projectId) ? t("integrations.reconnect") : t("integrations.connect")}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <ErrorNotice error={connect.error} service="connectors" compact />
      </section>
    </div>
  );
}
