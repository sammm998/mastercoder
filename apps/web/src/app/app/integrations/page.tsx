"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { formatDate } from "@/i18n/format";
import type { MessageKey } from "@/i18n/translate";
import { useTRPC } from "@/lib/trpc";
import { atLeast } from "@/lib/roles";
import { ErrorNotice, LoadingBlock } from "@/components/Feedback";
import { Icon } from "@/components/Icon";
import { useWorkspace } from "../workspace-context";

const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

function Catalog({ canManage }: { canManage: boolean }) {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const { workspace } = useWorkspace();
  const apps = useQuery(trpc.integrations.apps.queryOptions({ locale }));
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Record<string, Set<string>>>({});
  const connect = useMutation(trpc.integrations.connect.mutationOptions({ onSuccess: (r) => window.location.assign(r.redirectUrl) }));
  const list = useMemo(() => (apps.data ?? []).filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()) || a.app.includes(q.toLowerCase())), [apps.data, q]);
  const scopesFor = (app: string, all: string[]) => picked[app] ?? new Set(all);

  return (
    <section className="stack">
      <div className="row-between">
        <h2 className="section-title-sm">{t("integrations.catalog")}</h2>
        <div className="field" style={{ width: 260 }}>
          <label htmlFor="app-search" className="sr-only">
            {t("integrations.search")}
          </label>
          <input id="app-search" className="input" type="search" placeholder={t("integrations.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {apps.isPending ? (
        <LoadingBlock rows={3} />
      ) : apps.isError ? (
        <ErrorNotice error={apps.error} service="connectors" />
      ) : (
        <ul className="grid-cards" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {list.map((a) => {
            const selected = scopesFor(
              a.app,
              a.scopes.map((s) => s.id),
            );
            return (
              <li key={a.app} className="tile">
                <h3>{a.name}</h3>
                <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
                  <legend className="label" style={{ marginBottom: 6 }}>
                    {t("integrations.scopes")}
                  </legend>
                  {a.scopes.map((s) => (
                    <label key={s.id} className="checkbox" style={{ alignItems: "flex-start", fontSize: "0.82rem" }}>
                      <input
                        type="checkbox"
                        checked={selected.has(s.id)}
                        onChange={(e) =>
                          setPicked((cur) => {
                            const next = new Set(scopesFor(a.app, a.scopes.map((x) => x.id)));
                            if (e.target.checked) next.add(s.id);
                            else next.delete(s.id);
                            return { ...cur, [a.app]: next };
                          })
                        }
                      />
                      <span>
                        {s.description} <span className="mono subtle">({s.id})</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <div className="tile-foot">
                  <span />
                  <button type="button" className="btn btn-sm btn-ink" disabled={!canManage || connect.isPending} onClick={() => connect.mutate({ workspaceId: workspace.id, app: a.app, scopes: [...selected] })}>
                    {connect.isPending && connect.variables?.app === a.app ? t("integrations.connecting") : t("integrations.connect")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ErrorNotice error={connect.error} compact />
    </section>
  );
}

function Connections({ canManage }: { canManage: boolean }) {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { workspace } = useWorkspace();
  const q = useQuery(trpc.integrations.connections.queryOptions({ workspaceId: workspace.id }));
  const inv = () => qc.invalidateQueries({ queryKey: trpc.integrations.connections.queryKey({ workspaceId: workspace.id }) });
  const revoke = useMutation(trpc.integrations.revoke.mutationOptions({ onSuccess: inv }));
  const refresh = useMutation(trpc.integrations.refresh.mutationOptions({ onSuccess: inv }));
  return (
    <section className="card stack">
      <h2 className="section-title-sm">{t("integrations.connections")}</h2>
      {q.isPending ? (
        <LoadingBlock rows={2} />
      ) : q.isError ? (
        <ErrorNotice error={q.error} />
      ) : q.data.length === 0 ? (
        <p className="hint">{t("integrations.noConnections")}</p>
      ) : (
        <ul className="list">
          {q.data.map((c) => {
            const scopes = Array.isArray(c.scopes) ? (c.scopes as string[]) : [];
            const ops = (c.config as { operations?: unknown[] } | null)?.operations;
            return (
              <li key={c.id}>
                <div className="stack" style={{ gap: 4 }}>
                  <strong>{c.app}</strong>
                  <span className="hint">
                    {t("integrations.provider", { provider: c.provider })} · {formatDate(c.createdAt, locale, false)}
                    {Array.isArray(ops) && ` · ${t("integrations.operations", { count: ops.length })}`}
                  </span>
                  {scopes.length > 0 && <span className="mono subtle" style={{ fontSize: "0.72rem" }}>{scopes.join(", ")}</span>}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <span className={`badge ${c.status === "active" ? "badge-ok" : c.status === "revoked" ? "badge-bad" : "badge-warn"}`}>{t(`integrations.status.${c.status}` as MessageKey)}</span>
                  {c.status !== "revoked" && (
                    <>
                      <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={t("integrations.refresh")} title={t("integrations.refresh")} onClick={() => refresh.mutate({ connectionId: c.id })}>
                        <Icon name="refresh" size={14} />
                      </button>
                      {canManage && (
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => window.confirm(t("integrations.revokeConfirm", { app: c.app })) && revoke.mutate({ connectionId: c.id })}>
                          {t("integrations.revoke")}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ErrorNotice error={revoke.error ?? refresh.error} service="connectors" compact />
    </section>
  );
}

function OpenApiImport({ canManage }: { canManage: boolean }) {
  const t = useT();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { workspace } = useWorkspace();
  const [url, setUrl] = useState("");
  const [json, setJson] = useState("");
  const [name, setName] = useState("");
  const m = useMutation(trpc.integrations.importOpenApi.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: trpc.integrations.connections.queryKey({ workspaceId: workspace.id }) }) }));
  let parsed: Record<string, unknown> | null = null;
  let invalid = false;
  if (json.trim()) {
    try {
      const v = JSON.parse(json) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) parsed = v as Record<string, unknown>;
      else invalid = true;
    } catch {
      invalid = true;
    }
  }
  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault();
        const source = parsed ?? (url.trim() || null);
        if (source) m.mutate({ workspaceId: workspace.id, source, name: name.trim() || undefined });
      }}
    >
      <h2 className="section-title-sm">{t("integrations.openapi")}</h2>
      <p className="muted">{t("integrations.openapiLede")}</p>
      <div className="field">
        <label htmlFor="oa-url">{t("integrations.openapiUrl")}</label>
        <input id="oa-url" className="input" type="url" placeholder="https://api.example.se/openapi.json" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!!json.trim()} />
      </div>
      <div className="field">
        <label htmlFor="oa-json">{t("integrations.openapiPaste")}</label>
        <textarea id="oa-json" className="textarea mono" rows={5} value={json} onChange={(e) => setJson(e.target.value)} aria-invalid={invalid} />
        {invalid && <p className="hint" style={{ color: "var(--danger)" }}>{t("integrations.invalidJson")}</p>}
      </div>
      <div className="field">
        <label htmlFor="oa-name">{t("integrations.openapiName")}</label>
        <input id="oa-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </div>
      <button type="submit" className="btn btn-sm btn-ink" style={{ justifySelf: "start" }} disabled={!canManage || invalid || (!parsed && !url.trim()) || m.isPending}>
        {t("integrations.import")}
      </button>
      {m.isSuccess && <p className="notice notice-ok">{t("integrations.imported", { title: m.data.title, count: m.data.operations.length })}</p>}
      <ErrorNotice error={m.error} service="openapi" compact />
    </form>
  );
}

function McpServers({ canManage }: { canManage: boolean }) {
  const t = useT();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { workspace } = useWorkspace();
  const [v, setV] = useState({ name: "", transport: "http" as "http" | "stdio", url: "", command: "", args: "" });
  const m = useMutation(trpc.integrations.addMcpServer.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: trpc.integrations.connections.queryKey({ workspaceId: workspace.id }) }) }));
  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate({
          workspaceId: workspace.id,
          name: v.name.trim(),
          transport: v.transport,
          url: v.transport === "http" ? v.url.trim() || undefined : undefined,
          command: v.transport === "stdio" ? v.command.trim() || undefined : undefined,
          args: v.transport === "stdio" ? v.args.split("\n").map((s) => s.trim()).filter(Boolean) : [],
        });
      }}
    >
      <h2 className="section-title-sm">{t("integrations.mcp")}</h2>
      <p className="muted">{t("integrations.mcpLede")}</p>
      <div className="vedit-grid">
        <div className="field">
          <label htmlFor="mcp-name">{t("integrations.mcpName")}</label>
          <input id="mcp-name" className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required maxLength={80} />
        </div>
        <div className="field">
          <label htmlFor="mcp-transport">{t("integrations.transport")}</label>
          <select id="mcp-transport" className="select" value={v.transport} onChange={(e) => setV({ ...v, transport: e.target.value as "http" | "stdio" })}>
            <option value="http">HTTP</option>
            <option value="stdio">stdio</option>
          </select>
        </div>
      </div>
      {v.transport === "http" ? (
        <div className="field">
          <label htmlFor="mcp-url">{t("integrations.mcpUrl")}</label>
          <input id="mcp-url" className="input" type="url" value={v.url} onChange={(e) => setV({ ...v, url: e.target.value })} placeholder="https://mcp.example.se/sse" />
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="mcp-cmd">{t("integrations.mcpCommand")}</label>
            <input id="mcp-cmd" className="input mono" value={v.command} onChange={(e) => setV({ ...v, command: e.target.value })} placeholder="npx" />
          </div>
          <div className="field">
            <label htmlFor="mcp-args">{t("integrations.mcpArgs")}</label>
            <textarea id="mcp-args" className="textarea mono" rows={3} value={v.args} onChange={(e) => setV({ ...v, args: e.target.value })} />
          </div>
        </>
      )}
      <button type="submit" className="btn btn-sm btn-ink" style={{ justifySelf: "start" }} disabled={!canManage || !v.name.trim() || m.isPending}>
        {t("integrations.addMcp")}
      </button>
      {m.isSuccess && <p className="notice notice-ok">{t("integrations.mcpAdded")}</p>}
      <ErrorNotice error={m.error} compact />
    </form>
  );
}

function Secrets({ canManage }: { canManage: boolean }) {
  const t = useT();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { workspace } = useWorkspace();
  const projects = useQuery(trpc.project.list.queryOptions({ workspaceId: workspace.id }));
  const [projectId, setProjectId] = useState("");
  const scope = { workspaceId: workspace.id, projectId: projectId || undefined };
  const names = useQuery(trpc.integrations.secretNames.queryOptions(scope));
  const inv = () => qc.invalidateQueries({ queryKey: trpc.integrations.secretNames.queryKey(scope) });
  const save = useMutation(trpc.integrations.setSecret.mutationOptions({ onSuccess: inv }));
  const del = useMutation(trpc.integrations.deleteSecret.mutationOptions({ onSuccess: inv }));
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  return (
    <section className="card stack">
      <h2 className="section-title-sm">
        <Icon name="key" /> {t("integrations.secrets")}
      </h2>
      <p className="muted">{t("integrations.secretsLede")}</p>
      <div className="field" style={{ maxWidth: 320 }}>
        <label htmlFor="sec-scope">{t("integrations.secretScope")}</label>
        <select id="sec-scope" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">{t("integrations.workspaceScope")}</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {names.isPending ? (
        <LoadingBlock rows={2} />
      ) : names.isError ? (
        <ErrorNotice error={names.error} service="vault" compact />
      ) : names.data.length === 0 ? (
        <p className="hint">{t("integrations.noSecrets")}</p>
      ) : (
        <ul className="list">
          {names.data.map((n) => (
            <li key={n}>
              <span className="mono">{n}</span>
              <span className="row" style={{ gap: 8 }}>
                <span className="mono subtle" aria-hidden="true">
                  ••••••••
                </span>
                {canManage && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => window.confirm(t("integrations.deleteSecretConfirm", { name: n })) && del.mutate({ ...scope, name: n })}>
                    {t("common.delete")}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (SECRET_NAME.test(name) && value) save.mutate({ ...scope, name, value }, { onSuccess: () => (setName(""), setValue("")) });
        }}
        autoComplete="off"
      >
        <div className="vedit-grid">
          <div className="field">
            <label htmlFor="sec-name">{t("integrations.secretName")}</label>
            <input id="sec-name" className="input mono" value={name} onChange={(e) => setName(e.target.value.toUpperCase())} aria-invalid={!!name && !SECRET_NAME.test(name)} aria-describedby="sec-name-hint" />
          </div>
          <div className="field">
            <label htmlFor="sec-value">{t("integrations.secretValue")}</label>
            <input id="sec-value" className="input mono" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" />
          </div>
        </div>
        <p id="sec-name-hint" className="hint">
          {t("integrations.secretNameHint")}
        </p>
        <button type="submit" className="btn btn-sm btn-ink" style={{ justifySelf: "start" }} disabled={!SECRET_NAME.test(name) || !value || save.isPending || (!canManage && !projectId)}>
          {t("integrations.saveSecret")}
        </button>
        {save.isSuccess && <p className="notice notice-ok">{t("integrations.secretSaved")}</p>}
        <ErrorNotice error={save.error ?? del.error} service="vault" compact />
      </form>
    </section>
  );
}

export default function IntegrationsPage() {
  const t = useT();
  const { workspace } = useWorkspace();
  const canManage = atLeast(workspace.role, "admin");
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("integrations.title")}</h1>
          <p className="muted" style={{ maxWidth: 680 }}>
            {t("integrations.lede")}
          </p>
        </div>
      </header>
      {!canManage && <p className="notice">{t("settings.adminOnly")}</p>}
      <Catalog canManage={canManage} />
      <div className="split">
        <div className="stack-lg">
          <Connections canManage={canManage} />
          <Secrets canManage={canManage} />
        </div>
        <div className="stack-lg">
          <OpenApiImport canManage={canManage} />
          <McpServers canManage={canManage} />
        </div>
      </div>
    </div>
  );
}
