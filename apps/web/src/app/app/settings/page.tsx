"use client";

import { KnowledgeBase } from "@/features/knowledge/KnowledgeBase";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { formatDate } from "@/i18n/format";
import { useTRPC } from "@/lib/trpc";
import { ErrorNotice, LoadingBlock } from "@/components/Feedback";
import { useWorkspace } from "../workspace-context";
import { assignable, rank, type Role } from "@/lib/roles";


function Team() {
  const t = useT();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { workspace, user } = useWorkspace();
  const myRole = workspace.role as Role;
  const isAdmin = rank[myRole] >= rank.admin;
  const members = useQuery(trpc.workspace.members.queryOptions({ workspaceId: workspace.id }));
  const inv = () => qc.invalidateQueries({ queryKey: trpc.workspace.members.queryKey({ workspaceId: workspace.id }) });
  const invite = useMutation(trpc.workspace.invite.mutationOptions());
  const changeRole = useMutation(trpc.workspace.changeRole.mutationOptions({ onSuccess: inv }));
  const remove = useMutation(trpc.workspace.removeMember.mutationOptions({ onSuccess: inv }));
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");

  return (
    <section className="card stack" aria-labelledby="team-title">
      <div className="row-between">
        <h2 id="team-title" className="section-title-sm">
          {t("settings.members")}
        </h2>
        <span className="badge">{t(`settings.roles.${myRole}`)}</span>
      </div>
      {members.isPending ? (
        <LoadingBlock rows={3} />
      ) : members.isError ? (
        <ErrorNotice error={members.error} />
      ) : (
        <ul className="list" data-testid="members">
          {members.data.map((m) => (
            <li key={m.userId}>
              <div className="row" style={{ gap: 10 }}>
                <span className="avatar" aria-hidden="true">
                  {(m.name || m.email).slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <p style={{ fontWeight: 560 }}>
                    {m.name || m.email} {m.userId === user.id && <span className="subtle">({t("common.you")})</span>}
                  </p>
                  <p className="hint">{m.email}</p>
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                {isAdmin && m.userId !== user.id && (myRole === "owner" || rank[m.role as Role] < rank[myRole]) ? (
                  <>
                    <label className="sr-only" htmlFor={`role-${m.userId}`}>
                      {t("settings.changeRole", { name: m.name || m.email })}
                    </label>
                    <select id={`role-${m.userId}`} className="select" style={{ minHeight: 34, width: "auto" }} value={m.role} onChange={(e) => changeRole.mutate({ workspaceId: workspace.id, userId: m.userId, role: e.target.value as Role })}>
                      {assignable(myRole).map((r) => (
                        <option key={r} value={r}>
                          {t(`settings.roles.${r}`)}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => window.confirm(t("settings.removeConfirm", { name: m.name || m.email })) && remove.mutate({ workspaceId: workspace.id, userId: m.userId })}>
                      {t("settings.removeMember")}
                    </button>
                  </>
                ) : (
                  <span className="badge">{t(`settings.roles.${m.role as Role}`)}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ErrorNotice error={changeRole.error ?? remove.error} compact />
      {isAdmin && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) invite.mutate({ workspaceId: workspace.id, email: email.trim(), role });
          }}
          data-testid="invite-form"
        >
          <h3 className="label">{t("settings.invite")}</h3>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <div className="field grow" style={{ minWidth: 220 }}>
              <label htmlFor="invite-email" className="sr-only">
                {t("settings.inviteEmail")}
              </label>
              <input id="invite-email" type="email" required className="input" placeholder={t("settings.inviteEmail")} value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <label htmlFor="invite-role" className="sr-only">
              {t("settings.inviteRole")}
            </label>
            <select id="invite-role" className="select" style={{ width: "auto" }} value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {assignable(myRole).map((r) => (
                <option key={r} value={r}>
                  {t(`settings.roles.${r}`)}
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-ink" disabled={invite.isPending}>
              {t("settings.inviteSend")}
            </button>
          </div>
          <p className="hint">{t("settings.roleHelp")}</p>
          {invite.isSuccess && (
            <p className="notice notice-ok" role="status">
              {t("settings.inviteSent", { email: invite.variables?.email ?? "" })}
            </p>
          )}
          <ErrorNotice error={invite.error} compact />
        </form>
      )}
    </section>
  );
}

function Audit() {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const { workspace } = useWorkspace();
  const isAdmin = rank[workspace.role as Role] >= rank.admin;
  const log = useQuery({ ...trpc.workspace.auditLog.queryOptions({ workspaceId: workspace.id, limit: 100 }), enabled: isAdmin });
  return (
    <section className="card stack" aria-labelledby="audit-title">
      <div>
        <h2 id="audit-title" className="section-title-sm">
          {t("settings.audit")}
        </h2>
        <p className="muted">{t("settings.auditLede")}</p>
      </div>
      {!isAdmin ? (
        <p className="hint">{t("settings.adminOnly")}</p>
      ) : log.isPending ? (
        <LoadingBlock rows={4} />
      ) : log.isError ? (
        <ErrorNotice error={log.error} />
      ) : log.data.length === 0 ? (
        <p className="hint">{t("settings.auditEmpty")}</p>
      ) : (
        <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>{t("settings.auditWhen")}</th>
                <th>{t("settings.auditAction")}</th>
                <th>{t("settings.auditTarget")}</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {log.data.map((a) => (
                <tr key={a.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{formatDate(a.at, locale)}</td>
                  <td className="mono">{a.action}</td>
                  <td className="mono" style={{ wordBreak: "break-all" }}>
                    {a.target ?? "—"}
                  </td>
                  <td className="mono subtle">{a.ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Retention() {
  const t = useT();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { workspace } = useWorkspace();
  const isAdmin = rank[workspace.role as Role] >= rank.admin;
  const q = useQuery(trpc.gdpr.retention.queryOptions({ workspaceId: workspace.id }));
  const save = useMutation(trpc.gdpr.setRetention.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: trpc.gdpr.retention.queryKey({ workspaceId: workspace.id }) }) }));
  const [v, setV] = useState({ recordingDays: 30, transcriptDays: 365, eventDays: 180 });
  useEffect(() => {
    if (q.data) setV({ recordingDays: q.data.recordingDays, transcriptDays: q.data.transcriptDays, eventDays: q.data.eventDays });
  }, [q.data]);
  const field = (k: keyof typeof v, label: string) => (
    <div className="field">
      <label htmlFor={`ret-${k}`}>{label}</label>
      <input id={`ret-${k}`} className="input" type="number" min={1} max={3650} value={v[k]} disabled={!isAdmin} onChange={(e) => setV((s) => ({ ...s, [k]: Math.max(1, Math.min(3650, Number(e.target.value) || 1)) }))} />
    </div>
  );
  return (
    <form
      className="card stack"
      aria-labelledby="ret-title"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ workspaceId: workspace.id, ...v });
      }}
    >
      <div>
        <h2 id="ret-title" className="section-title-sm">
          {t("settings.retention")}
        </h2>
        <p className="muted">{t("settings.retentionLede")}</p>
      </div>
      {q.isPending ? (
        <LoadingBlock rows={2} />
      ) : (
        <div className="stats">
          {field("recordingDays", t("settings.recordingDays"))}
          {field("transcriptDays", t("settings.transcriptDays"))}
          {field("eventDays", t("settings.eventDays"))}
        </div>
      )}
      {isAdmin && (
        <button type="submit" className="btn btn-sm btn-ink" style={{ justifySelf: "start" }} disabled={save.isPending}>
          {t("common.save")}
        </button>
      )}
      {save.isSuccess && <p className="notice notice-ok">{t("settings.retentionSaved")}</p>}
      <ErrorNotice error={q.error ?? save.error} compact />
    </form>
  );
}

function Privacy() {
  const t = useT();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const { user } = useWorkspace();
  const exp = useMutation(trpc.gdpr.exportMyData.mutationOptions());
  const del = useMutation(
    trpc.gdpr.deleteMyAccount.mutationOptions({
      onSuccess: () => {
        qc.clear();
        router.replace("/?deleted=1");
      },
    }),
  );
  const [confirm, setConfirm] = useState("");
  return (
    <section className="card stack" aria-labelledby="privacy-title">
      <h2 id="privacy-title" className="section-title-sm">
        {t("settings.privacy")}
      </h2>
      <div className="stack" style={{ gap: 8 }}>
        <h3 className="label">{t("settings.export")}</h3>
        <p className="muted">{t("settings.exportLede")}</p>
        <div className="row">
          <button type="button" className="btn btn-sm" disabled={exp.isPending} onClick={() => exp.mutate()}>
            {t("settings.export")}
          </button>
          {exp.data && (
            <a className="btn btn-sm btn-primary" href={exp.data.url} target="_blank" rel="noreferrer noopener" download>
              {t("settings.exportDownload")}
            </a>
          )}
        </div>
        {exp.data && <p className="hint">{t("settings.exportReady")}</p>}
        <ErrorNotice error={exp.error} compact />
      </div>
      <hr className="rule" />
      <form
        className="stack"
        style={{ gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (confirm.trim().toLowerCase() === user.email.toLowerCase()) del.mutate({ confirmEmail: confirm.trim() });
        }}
      >
        <h3 className="label" style={{ color: "var(--danger)" }}>
          {t("settings.delete")}
        </h3>
        <p className="muted">{t("settings.deleteLede")}</p>
        <div className="field" style={{ maxWidth: 420 }}>
          <label htmlFor="del-confirm">{t("settings.deleteConfirmLabel")}</label>
          <input id="del-confirm" className="input" type="email" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={user.email} />
        </div>
        <button type="submit" className="btn btn-sm btn-danger" style={{ justifySelf: "start" }} disabled={confirm.trim().toLowerCase() !== user.email.toLowerCase() || del.isPending}>
          {t("settings.deleteButton")}
        </button>
        <ErrorNotice error={del.error} compact />
      </form>
    </section>
  );
}

export default function SettingsPage() {
  const t = useT();
  const { workspace } = useWorkspace();
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">{workspace.name}</p>
          <h1 className="page-title">{t("settings.title")}</h1>
          <p className="muted">{t("settings.lede")}</p>
        </div>
        <dl className="kv">
          <dt>{t("settings.plan")}</dt>
          <dd className="mono">{workspace.plan}</dd>
          <dt>{t("settings.region")}</dt>
          <dd className="mono">{workspace.region}</dd>
        </dl>
      </header>
      <KnowledgeBase workspaceId={workspace.id} canManage={workspace.role === "owner" || workspace.role === "admin"} />
      <div className="split">
        <div className="stack-lg">
          <Team />
          <Retention />
        </div>
        <div className="stack-lg">
          <Audit />
          <Privacy />
        </div>
      </div>
    </div>
  );
}
