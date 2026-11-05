"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { formatDate } from "@/i18n/format";
import { useTRPC } from "@/lib/trpc";
import { EmptyState, ErrorNotice, LoadingBlock } from "@/components/Feedback";
import { Icon } from "@/components/Icon";
import { DefinitionForm, type Definition } from "@/features/agents/DefinitionForm";
import { useWorkspace } from "../workspace-context";

type Tab = "mine" | "approvals" | "new";

function Builder() {
  const t = useT();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const { workspace } = useWorkspace();
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [def, setDef] = useState<Definition | null>(null);
  const [valid, setValid] = useState(true);
  const draft = useMutation(
    trpc.agents.draftFromPrompt.mutationOptions({
      onSuccess: (r) => {
        setName(r.name);
        setDef(r.definition);
      },
    }),
  );
  const create = useMutation(
    trpc.agents.create.mutationOptions({
      onSuccess: async (r) => {
        await qc.invalidateQueries({ queryKey: trpc.agents.list.queryKey({ workspaceId: workspace.id }) });
        router.push(`/app/agents/${r.id}`);
      },
    }),
  );
  return (
    <div className="split">
      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (prompt.trim().length >= 5) draft.mutate({ workspaceId: workspace.id, prompt: prompt.trim() });
        }}
      >
        <div className="field">
          <label htmlFor="agent-prompt">{t("agents.describe")}</label>
          <textarea id="agent-prompt" className="textarea" rows={6} value={prompt} placeholder={t("agents.describePlaceholder")} onChange={(e) => setPrompt(e.target.value)} maxLength={8000} />
        </div>
        <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }} disabled={prompt.trim().length < 5 || draft.isPending}>
          <Icon name="sparkle" size={16} /> {draft.isPending ? t("agents.drafting") : t("agents.draft")}
        </button>
        <ErrorNotice error={draft.error} service="agents" />
      </form>
      {def && (
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && valid) create.mutate({ workspaceId: workspace.id, name: name.trim(), definition: def });
          }}
        >
          <div>
            <h2 className="section-title-sm">{t("agents.review")}</h2>
            <p className="muted">{t("agents.reviewLede")}</p>
          </div>
          <div className="field">
            <label htmlFor="agent-name">{t("agents.name")}</label>
            <input id="agent-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </div>
          <DefinitionForm value={def} onChange={setDef} onValidity={setValid} />
          <ErrorNotice error={create.error} />
          <button type="submit" className="btn btn-ink" style={{ justifySelf: "start" }} disabled={!name.trim() || !valid || create.isPending}>
            {t("agents.create")}
          </button>
        </form>
      )}
    </div>
  );
}

function ApprovalsInbox() {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { workspace } = useWorkspace();
  const [status, setStatus] = useState<"pending" | "approved" | "rejected">("pending");
  const q = useQuery(trpc.agents.approvals.queryOptions({ workspaceId: workspace.id, status }));
  const decide = useMutation(trpc.agents.decide.mutationOptions({ onSuccess: () => qc.invalidateQueries({ queryKey: trpc.agents.approvals.queryKey() }) }));
  return (
    <section className="stack">
      <div className="row-between">
        <div>
          <h2 className="section-title-sm">{t("agents.approvalsTitle")}</h2>
          <p className="muted">{t("agents.approvalsLede")}</p>
        </div>
        <div className="seg" role="group" aria-label={t("agents.showDecided")}>
          {(["pending", "approved", "rejected"] as const).map((s) => (
            <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>
              {t(`agents.${s}`)}
            </button>
          ))}
        </div>
      </div>
      {q.isPending ? (
        <LoadingBlock rows={3} />
      ) : q.isError ? (
        <ErrorNotice error={q.error} />
      ) : q.data.length === 0 ? (
        <EmptyState title={t("agents.approvalsEmpty")} />
      ) : (
        <ul className="list">
          {q.data.map((a) => (
            <li key={a.id} style={{ alignItems: "flex-start" }}>
              <div className="stack grow" style={{ gap: 6 }}>
                <p>
                  <strong className="mono">{a.action}</strong> · <span className="hint">{formatDate(a.createdAt, locale)}</span>
                </p>
                <pre className="code" style={{ maxHeight: 220 }}>
                  {JSON.stringify(a.payload, null, 2)}
                </pre>
              </div>
              {a.status === "pending" ? (
                <div className="row">
                  <button type="button" className="btn btn-primary btn-sm" disabled={decide.isPending} onClick={() => decide.mutate({ approvalId: a.id, approve: true })}>
                    {t("agents.approve")}
                  </button>
                  <button type="button" className="btn btn-sm btn-danger" disabled={decide.isPending} onClick={() => decide.mutate({ approvalId: a.id, approve: false })}>
                    {t("agents.reject")}
                  </button>
                </div>
              ) : (
                <span className={`badge ${a.status === "approved" ? "badge-ok" : "badge-bad"}`}>{t(`agents.${a.status as "approved" | "rejected"}`)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorNotice error={decide.error} compact />
    </section>
  );
}

function AgentList() {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const { workspace } = useWorkspace();
  const q = useQuery(trpc.agents.list.queryOptions({ workspaceId: workspace.id }));
  if (q.isPending) return <LoadingBlock rows={3} />;
  if (q.isError) return <ErrorNotice error={q.error} />;
  if (q.data.length === 0) return <EmptyState title={t("agents.empty")} body={t("agents.emptyBody")} action={<Link className="btn btn-primary btn-sm" href="/app/agents?tab=new">{t("agents.tabs.new")}</Link>} />;
  return (
    <ul className="grid-cards" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {q.data.map((a) => {
        const def = a.definition as { description?: unknown; instructions?: unknown };
        const blurb = typeof def.description === "string" ? def.description : typeof def.instructions === "string" ? def.instructions : "";
        return (
          <li key={a.id}>
            <Link href={`/app/agents/${a.id}`} className="tile">
              <div className="row-between">
                <Icon name="agent" />
                <span className={`badge ${a.status === "active" ? "badge-ok" : "badge-warn"}`}>{t(`agents.status.${a.status as "active" | "paused"}`)}</span>
              </div>
              <h3>{a.name}</h3>
              <p className="muted" style={{ fontSize: "0.86rem", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {blurb}
              </p>
              <div className="tile-foot">
                <span className="mono">{t("agents.version", { n: a.version })}</span>
                <span>{formatDate(a.createdAt, locale, false)}</span>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export default function AgentsPage() {
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const tab = (["mine", "approvals", "new"].includes(params.get("tab") ?? "") ? params.get("tab") : "mine") as Tab;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("agents.title")}</h1>
          <p className="muted" style={{ maxWidth: 640 }}>
            {t("agents.lede")}
          </p>
        </div>
        <Link className="btn btn-primary" href="/app/agents?tab=new">
          <Icon name="plus" size={16} /> {t("agents.tabs.new")}
        </Link>
      </header>
      <div className="tabs" role="tablist" aria-label={t("agents.title")}>
        {(["mine", "approvals", "new"] as const).map((x) => (
          <button key={x} type="button" role="tab" className="tab" aria-selected={tab === x} onClick={() => router.replace(`/app/agents?tab=${x}`)}>
            {t(`agents.tabs.${x}`)}
          </button>
        ))}
      </div>
      {tab === "mine" && <AgentList />}
      {tab === "approvals" && <ApprovalsInbox />}
      {tab === "new" && <Builder />}
    </div>
  );
}
