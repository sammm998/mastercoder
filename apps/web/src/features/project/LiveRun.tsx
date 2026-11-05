"use client";

import { useMemo } from "react";
import { useT } from "@/i18n/client";
import { stripAnsi, type ForgeEvent } from "@/lib/events";
import { eventsOf, liveFiles, phaseSteps, terminalTail, type TeamRun } from "@/lib/agent-run";
import { Icon } from "@/components/Icon";
import { CrewAvatar } from "@/components/CrewAvatar";
import { PhaseStepper } from "../chat/RunWidgets";
import { TeamRow, TeamSteps } from "../chat/TeamThread";

/**
 * "Watch it build": what the team is doing right now — phase progress, the team's steps, files as they
 * are written and the latest terminal output. Shown in Preview until `preview.ready`, and as the Run tab.
 */
export function LiveRun({ events, taskId, run, variant }: { events: ForgeEvent[]; taskId: string | undefined; run: TeamRun | undefined; variant: "preview" | "tab" }) {
  const t = useT();
  const taskEvents = useMemo(() => eventsOf(events, taskId), [events, taskId]);
  const steps = useMemo(() => phaseSteps(taskEvents), [taskEvents]);
  const files = useMemo(() => liveFiles(taskEvents).slice(0, 40), [taskEvents]);
  const term = useMemo(() => terminalTail(taskEvents, 40), [taskEvents]);

  if (!taskId) {
    return (
      <div className="live-idle" data-testid="live-idle">
        <span className="orb live-orb" aria-hidden="true">
          <img src="/brand/avatars/byggo.webp" alt="" width={96} height={96} className="orb-mascot" />
        </span>
        <h2>{t("project.live.idleTitle")}</h2>
        <p className="muted">{t("project.live.idleBody")}</p>
      </div>
    );
  }

  return (
    <div className={`live live-${variant}`} data-testid="live-run">
      <header className="live-head">
        <div className="live-title">
          <CrewAvatar id="byggo" size={36} />
          <div>
            <h2>{t("project.live.title")}</h2>
            {variant === "preview" && <p className="muted">{t("project.live.lede")}</p>}
          </div>
        </div>
        <PhaseStepper steps={steps} />
      </header>
      <div className="live-grid">
        {variant === "tab" && run && !run.chat && (
          <section className="live-panel live-convo" aria-labelledby="live-convo-h">
            <h3 id="live-convo-h" className="live-h">
              <Icon name="users" size={14} />
              {t("project.team.title")}
            </h3>
            <ol className="team-list">
              {run.messages.map((m) => (
                <TeamRow key={m.id} m={m} />
              ))}
            </ol>
          </section>
        )}
        <section className="live-panel" aria-labelledby="live-run-h">
          <h3 id="live-run-h" className="live-h">
            <Icon name="list" size={14} />
            {t("project.team.lastRun")}
          </h3>
          <TeamSteps run={run} />
        </section>
        <section className="live-panel" aria-labelledby="live-files-h">
          <h3 id="live-files-h" className="live-h">
            <Icon name="file" size={14} />
            {t("project.live.files")}
          </h3>
          {files.length === 0 ? (
            <p className="subtle">{t("project.live.noFiles")}</p>
          ) : (
            <ul className="live-files" data-testid="live-files">
              {files.map((f, i) => (
                <li key={f.path} data-change={f.change} style={{ ["--i" as string]: i }}>
                  <Icon name="file" size={13} />
                  <code>{f.path}</code>
                  <span className={`badge ${f.change === "created" ? "badge-ok" : f.change === "deleted" ? "badge-bad" : "badge-accent"}`}>
                    {f.change === "created" ? t("project.live.new") : f.change === "deleted" ? t("project.live.deleted") : t("project.live.changed")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="live-panel live-term" aria-labelledby="live-term-h">
          <h3 id="live-term-h" className="live-h">
            <Icon name="terminal" size={14} />
            {t("project.live.terminal")}
          </h3>
          <pre className="log live-log" tabIndex={0} aria-labelledby="live-term-h" data-testid="live-terminal">
            {term.length === 0 ? (
              <span className="dim">{t("project.live.noTerminal")}</span>
            ) : (
              term.map((e) => (
                <span key={e.id} className={e.stream === "stderr" ? "err" : undefined}>
                  {stripAnsi(e.text)}
                  {"\n"}
                </span>
              ))
            )}
          </pre>
        </section>
      </div>
    </div>
  );
}
