"use client";

import { useState } from "react";
import { useT } from "@/i18n/client";
import type { MessageKey, Translate } from "@/i18n/translate";
import { CREW_NAME, type CrewId } from "@/lib/crew";
import type { TeamMessage, TeamRun } from "@/lib/agent-run";
import { CrewAvatar } from "@/components/CrewAvatar";
import { Icon } from "@/components/Icon";
import { Details } from "./EventCard";

const STEPS = ["plan", "kickoff", "design", "build", "verify", "review", "finish", "chat"];

export function stepName(t: Translate, step: string) {
  return STEPS.includes(step) ? t(`project.team.step.${step}` as MessageKey) : step;
}

/** Translate a team message from its key + params; the English `text` is the fallback for unknown keys. */
export function teamText(t: Translate, m: TeamMessage): string {
  if (m.key === "team.chat.reply") return m.text;
  const out = t(m.key as MessageKey, m.params);
  return out === m.key ? m.text : out;
}

/** Whether the English fallback carries extra detail worth showing (e.g. a failure reason). */
function rawWorthShowing(m: TeamMessage) {
  return m.status === "failed" && typeof m.params.reason === "string";
}

export function TeamRow({ m }: { m: TeamMessage }) {
  const t = useT();
  const to = m.to && m.to !== "user" ? (m.to as CrewId) : null;
  return (
    <li className="team-row" data-status={m.status}>
      <CrewAvatar id={m.from} size={34} />
      <div className="team-body">
        <p className="team-meta">
          <strong className="team-name" data-crew={m.from}>
            {CREW_NAME[m.from]}
          </strong>
          <span className="team-role">{t(`crew.${m.from}.role`)}</span>
          {to && (
            <span className="team-to">
              <Icon name="arrowRight" size={11} />
              <CrewAvatar id={to} size={16} />
              {CREW_NAME[to]}
            </span>
          )}
          {m.to === "user" && (
            <span className="team-to">
              <Icon name="arrowRight" size={11} />
              {t("project.team.toUser")}
            </span>
          )}
        </p>
        <p className="team-text">{teamText(t, m)}</p>
        {rawWorthShowing(m) && (
          <Details>
            <p className="ev-raw">{String(m.params.reason)}</p>
          </Details>
        )}
      </div>
      <span className={`team-status s-${m.status}`}>
        {m.status === "working" ? <span className="spinner" aria-hidden="true" /> : m.status === "done" ? <Icon name="check" size={11} strokeWidth={2.6} /> : m.status === "failed" ? <Icon name="alert" size={11} /> : <Icon name="chat" size={11} />}
        <span>{t(`project.team.status.${m.status}`)}</span>
      </span>
    </li>
  );
}

/** Heading + progress for a team run ("Team finished in 6 steps"). */
export function teamHeadline(t: Translate, run: TeamRun): string {
  const n = run.steps.filter((s) => s.step !== "kickoff").length;
  if (run.state === "done") return t("project.team.finished", { count: n });
  if (run.state === "failed") {
    const last = run.steps[run.steps.length - 1];
    return t("project.team.failed", { step: last ? stepName(t, last.step) : "" });
  }
  return t("project.team.working", { step: Math.max(1, n), total: Math.max(n, 6) });
}

export function teamProgress(run: TeamRun): number {
  if (run.state === "done") return 1;
  const done = run.steps.filter((s) => s.step !== "kickoff" && s.status === "done").length;
  return Math.min(0.95, done / 6);
}

/** The team conversation for one task, as a collapsible card in the agent timeline. */
export function TeamThread({ run }: { run: TeamRun }) {
  const t = useT();
  const [open, setOpen] = useState(run.state !== "done");
  const crew = [...new Set(run.messages.map((m) => m.from))];
  const pct = Math.round(teamProgress(run) * 100);
  return (
    <section className="team-card" data-state={run.state} data-testid="team-thread">
      <button type="button" className="team-head" aria-expanded={open} onClick={() => setOpen((o) => !o)} aria-label={open ? t("project.team.collapse") : t("project.team.expand")}>
        <span className="team-stack" aria-hidden="true">
          {crew.slice(0, 5).map((c) => (
            <CrewAvatar key={c} id={c} size={24} />
          ))}
        </span>
        <span className="team-headline">{teamHeadline(t, run)}</span>
        <Icon name="chevron" size={14} />
      </button>
      <div className="team-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={teamHeadline(t, run)}>
        <span style={{ width: `${pct}%` }} />
      </div>
      {open && (
        <ol className="team-list">
          {run.messages.map((m) => (
            <TeamRow key={m.id} m={m} />
          ))}
        </ol>
      )}
    </section>
  );
}

/** "Last run": the run's steps with who did them and their status. */
export function TeamSteps({ run }: { run: TeamRun | undefined }) {
  const t = useT();
  if (!run) return <p className="subtle team-empty">{t("project.team.noRun")}</p>;
  const pct = Math.round(teamProgress(run) * 100);
  return (
    <div className="team-steps">
      <p className="team-steps-head">
        <span>{teamHeadline(t, run)}</span>
        <span className="mono subtle">{pct}%</span>
      </p>
      <div className="team-progress" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
      <ol>
        {run.steps.map((s) => (
          <li key={s.step} data-status={s.status}>
            <CrewAvatar id={s.from} size={22} />
            <span className="grow">{stepName(t, s.step)}</span>
            <span className={`team-status s-${s.status}`}>
              {s.status === "done" ? <Icon name="check" size={11} strokeWidth={2.6} /> : s.status === "failed" ? <Icon name="alert" size={11} /> : <span className="spinner" aria-hidden="true" />}
              <span>{t(`project.team.status.${s.status}`)}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
