"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { formatRelative } from "@/i18n/format";
import { useTRPC } from "@/lib/trpc";
import { PromptComposer, type ComposerSubmit } from "@/components/PromptComposer";
import { taskCreateInput } from "@/lib/task-input";
import { CrewAvatar } from "@/components/CrewAvatar";
import { EmptyState, ErrorNotice, LoadingBlock } from "@/components/Feedback";
import { Icon } from "@/components/Icon";
import { useWorkspace } from "./workspace-context";
import { TEMPLATES, projectNameFrom } from "./templates";

export default function Dashboard() {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const { workspace, user } = useWorkspace();
  const projects = useQuery(trpc.project.list.queryOptions({ workspaceId: workspace.id }));
  const gallery = useQuery(trpc.project.gallery.queryOptions({ limit: 12 }));
  const createProject = useMutation(trpc.project.create.mutationOptions());
  const createTask = useMutation(trpc.task.create.mutationOptions());
  const remix = useMutation(trpc.project.remix.mutationOptions());
  const [template, setTemplate] = useState<string | undefined>();
  const [pendingProject, setPendingProject] = useState<string | null>(null);
  const draftProject = useRef<Promise<string> | null>(null);
  const [newName, setNewName] = useState("");

  const refresh = () => qc.invalidateQueries({ queryKey: trpc.project.list.queryKey({ workspaceId: workspace.id }) });

  /** The mic needs a project for its audio socket, so create one lazily (once). */
  const ensureProject = () => {
    if (!draftProject.current) {
      draftProject.current = createProject.mutateAsync({ workspaceId: workspace.id, name: t("dashboard.voiceProjectName"), template }).then((r) => r.id);
      draftProject.current.catch(() => (draftProject.current = null));
    }
    return draftProject.current;
  };

  const submit = async (s: ComposerSubmit) => {
    const { prompt } = s;
    const projectId = draftProject.current ? await draftProject.current : (await createProject.mutateAsync({ workspaceId: workspace.id, name: projectNameFrom(prompt), template })).id;
    draftProject.current = null;
    setPendingProject(projectId);
    void refresh();
    await createTask.mutateAsync(taskCreateInput(projectId, prompt, s));
    router.push(`/app/p/${projectId}`);
  };

  const busy = createProject.isPending || createTask.isPending;
  const firstName = (user.name || "").split(" ")[0];

  return (
    <div className="page">
      <section className="prompt-hero" aria-labelledby="dash-title">
        <div className="prompt-hero-glow" aria-hidden="true" />
        <img className="prompt-hero-mascot" src="/brand/scoutr-hero.webp" width={180} height={180} alt="" aria-hidden="true" decoding="async" />
        <p className="prompt-hero-greet">
          <CrewAvatar id="scoutr" size={26} />
          {firstName ? t("dashboard.greeting", { name: firstName }) : t("dashboard.greetingAnon")}
        </p>
        <h1 id="dash-title">
          {t("dashboard.title1")} <span className="grad-text">{t("dashboard.title2")}</span>
        </h1>
        <PromptComposer
          onSubmit={(s) => submit(s).catch(() => undefined)}
          ensureProject={ensureProject}
          busy={busy}
        />
        {(createProject.error || createTask.error) && (
          <div className="stack" style={{ gap: 8 }}>
            <ErrorNotice error={createTask.error ?? createProject.error} service={createTask.error ? "intent" : undefined} />
            {pendingProject && (
              <Link className="btn btn-sm" href={`/app/p/${pendingProject}`} style={{ justifySelf: "start", color: "inherit" }}>
                {t("dashboard.openAnyway")}
              </Link>
            )}
          </div>
        )}
        <div className="chips" role="group" aria-label={t("dashboard.templates")}>
          {TEMPLATES.map((tp) => (
            <button key={tp.id} type="button" className="chip" aria-pressed={template === tp.id} onClick={() => setTemplate((cur) => (cur === tp.id ? undefined : tp.id))}>
              {t(`dashboard.template.${tp.id}`)}
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="projects-title">
        <div className="section-head">
          <h2 id="projects-title">{t("dashboard.projects")}</h2>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newName.trim()) return;
              createProject.mutate(
                { workspaceId: workspace.id, name: newName.trim(), template },
                {
                  onSuccess: (r) => {
                    setNewName("");
                    void refresh();
                    router.push(`/app/p/${r.id}`);
                  },
                },
              );
            }}
          >
            <label htmlFor="new-project" className="sr-only">
              {t("dashboard.newProjectName")}
            </label>
            <input id="new-project" className="input" style={{ minHeight: 36, width: 220 }} placeholder={t("dashboard.newProjectName")} value={newName} onChange={(e) => setNewName(e.target.value)} data-testid="new-project-name" />
            <button type="submit" className="btn btn-sm btn-ink" disabled={!newName.trim() || createProject.isPending} data-testid="new-project-submit">
              <Icon name="plus" size={14} /> {t("dashboard.newProject")}
            </button>
          </form>
        </div>
        {projects.isPending ? (
          <LoadingBlock rows={3} />
        ) : projects.isError ? (
          <ErrorNotice error={projects.error} onRetry={() => void projects.refetch()} />
        ) : projects.data.length === 0 ? (
          <EmptyState title={t("dashboard.emptyTitle")} body={t("dashboard.emptyBody")} />
        ) : (
          <ul className="grid-cards" style={{ listStyle: "none", padding: 0, margin: 0 }} data-testid="project-grid">
            {projects.data.map((p, i) => (
              <li key={p.id}>
                <Link href={`/app/p/${p.id}`} className="tile" style={{ ["--sx" as string]: `${(i * 37) % 100}%`, ["--sy" as string]: `${(i * 61) % 100}%` }}>
                  <div className="tile-swatch" aria-hidden="true" />
                  <h3>{p.name}</h3>
                  <div className="tile-foot">
                    <span>{p.template ? t(`dashboard.template.${p.template}` as never) : t("dashboard.blank")}</span>
                    <span>{formatRelative(p.createdAt, locale)}</span>
                  </div>
                  {p.isPublic && <span className="badge" style={{ position: "absolute", top: 16, right: 16 }}>{t("dashboard.public")}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="explore-title">
        <div className="section-head">
          <h2 id="explore-title">{t("dashboard.explore")}</h2>
          <p className="subtle">{t("dashboard.exploreLede")}</p>
        </div>
        {gallery.isPending ? (
          <LoadingBlock rows={2} />
        ) : gallery.isError ? (
          <ErrorNotice error={gallery.error} />
        ) : gallery.data.length === 0 ? (
          <EmptyState title={t("dashboard.exploreEmpty")} body={t("dashboard.exploreEmptyBody")} />
        ) : (
          <ul className="grid-cards" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {gallery.data.map((p) => (
              <li key={p.id} className="tile">
                <h3>{p.name}</h3>
                <p className="subtle" style={{ fontSize: "0.82rem" }}>
                  {p.remixOf ? t("dashboard.remixed") : t("dashboard.original")} · {formatRelative(p.createdAt, locale)}
                </p>
                <div className="tile-foot">
                  <Link href={`/app/p/${p.id}`}>{t("common.view")}</Link>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={remix.isPending}
                    onClick={() =>
                      remix.mutate(
                        { projectId: p.id, workspaceId: workspace.id },
                        {
                          onSuccess: (r) => {
                            void refresh();
                            router.push(`/app/p/${r.id}`);
                          },
                        },
                      )
                    }
                  >
                    {t("dashboard.remix")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <ErrorNotice error={remix.error} />
      </section>
    </div>
  );
}
