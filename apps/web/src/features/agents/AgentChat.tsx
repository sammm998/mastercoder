"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useT } from "@/i18n/client";
import { useTRPC } from "@/lib/trpc";
import { ErrorNotice } from "@/components/Feedback";
import { Icon } from "@/components/Icon";

type Turn = { role: "user" | "assistant"; text: string; status?: "pending" | "failed" | "approval" };

const key = (agentId: string) => `forge.agentChat.${agentId}`;

function load(agentId: string): Turn[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(key(agentId)) ?? "[]") as Turn[];
    return Array.isArray(v) ? v.filter((x) => x.status !== "pending").slice(-40) : [];
  } catch {
    return [];
  }
}

/** Plain text with clickable https links (no HTML is ever injected). */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)\]]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer noopener">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** ChatGPT-style conversation with a user agent. Each message runs the agent with the conversation so far. */
export function AgentChat({ agentId, agentName, disabled }: { agentId: string; agentName: string; disabled?: boolean }) {
  const t = useT();
  const trpc = useTRPC();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => setTurns(load(agentId)), [agentId]);
  useEffect(() => {
    try {
      window.localStorage.setItem(key(agentId), JSON.stringify(turns.filter((x) => x.status !== "pending").slice(-40)));
    } catch {
      /* not persisted */
    }
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [turns, agentId]);

  const send = useMutation(trpc.agents.chat.mutationOptions());
  const runs = useQuery({ ...trpc.agents.runs.queryOptions({ agentId, limit: 10 }), enabled: !!waitingFor, refetchInterval: waitingFor ? 1500 : false });

  // The reply is the run whose input carries this chat message's id.
  const reply = useMemo(() => {
    if (!waitingFor) return null;
    const r = runs.data?.find((x) => x.trigger === "chat" && (x.input as { chatId?: string } | null)?.chatId === waitingFor);
    return r && r.status !== "running" ? r : null;
  }, [runs.data, waitingFor]);

  useEffect(() => {
    if (!reply) return;
    setTurns((cur) => {
      const rest = cur.filter((x) => x.status !== "pending");
      if (reply.status === "succeeded") return [...rest, { role: "assistant", text: reply.output?.trim() || "…" }];
      if (reply.status === "awaiting_approval") return [...rest, { role: "assistant", text: t("agents.chat.approval"), status: "approval" }];
      return [...rest, { role: "assistant", text: reply.output?.trim() || t("agents.chat.failed"), status: "failed" }];
    });
    setWaitingFor(null);
  }, [reply, t]);

  const submit = () => {
    const message = draft.trim();
    if (!message || waitingFor || disabled) return;
    const chatId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const history = turns.filter((x) => !x.status).map(({ role, text }) => ({ role, text: text.slice(0, 8000) })).slice(-20);
    setTurns((cur) => [...cur, { role: "user", text: message }, { role: "assistant", text: "", status: "pending" }]);
    setDraft("");
    setWaitingFor(chatId);
    send.mutate(
      { agentId, chatId, message, history },
      {
        onError: () => {
          setTurns((cur) => cur.filter((x) => x.status !== "pending"));
          setWaitingFor(null);
        },
      },
    );
  };

  return (
    <section className="card agent-chat" aria-label={t("agents.chat.title", { name: agentName })}>
      <div className="row-between">
        <h2 className="section-title-sm">
          <Icon name="chat" size={16} /> {t("agents.chat.title", { name: agentName })}
        </h2>
        {turns.length > 0 && (
          <button type="button" className="btn btn-sm btn-ghost" disabled={!!waitingFor} onClick={() => setTurns([])}>
            {t("agents.chat.new")}
          </button>
        )}
      </div>
      <div className="agent-chat-log" role="log" aria-live="polite">
        {turns.length === 0 ? (
          <p className="hint agent-chat-empty">{t("agents.chat.empty")}</p>
        ) : (
          turns.map((m, i) => (
            <div key={i} className={`agent-chat-msg agent-chat-${m.role}`} data-status={m.status}>
              {m.status === "pending" ? (
                <span className="agent-chat-typing" aria-label={t("agents.chat.thinking")}>
                  <span />
                  <span />
                  <span />
                </span>
              ) : (
                <Linkified text={m.text} />
              )}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
      <form
        className="agent-chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor={`agent-chat-${agentId}`} className="sr-only">
          {t("agents.chat.placeholder")}
        </label>
        <textarea
          id={`agent-chat-${agentId}`}
          className="textarea"
          rows={2}
          value={draft}
          maxLength={8000}
          placeholder={disabled ? t("agents.chat.paused") : t("agents.chat.placeholder")}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          data-testid="agent-chat-input"
        />
        <button type="submit" className="btn btn-primary btn-icon" disabled={!draft.trim() || !!waitingFor || disabled} aria-label={t("agents.chat.send")} title={t("agents.chat.send")}>
          <Icon name="send" size={16} />
        </button>
      </form>
      <ErrorNotice error={send.error} compact />
    </section>
  );
}
