import { eq, artifacts, projects, type Db } from "@forge/db";
import { newId, type EventSink, type ObjectStore, type UsageSink } from "@forge/shared";
import type { LLMProvider } from "@forge/llm";
import { generateDeck, generateDocument, resolveDeckImages, resolveDocImages, PlaceholderImageResolver, type ImageResolver } from "@forge/slides";

export interface SlidesRequest {
  taskId: string;
  projectId: string;
  workspaceId: string;
  kind: "deck" | "document";
  prompt: string;
  slideCount?: number;
}

export interface SlidesPipelineDeps {
  db: Db;
  llm: LLMProvider;
  store: ObjectStore;
  usage: UsageSink;
  events: EventSink;
  /** Image resolver backed by the media engine (falls back to labelled placeholders). */
  images?: ImageResolver;
}

/** Generate a deck or document, resolve its images, and store the JSON as a project artifact. */
export async function runSlidesRequest(req: SlidesRequest, d: SlidesPipelineDeps): Promise<{ artifactId: string; slides?: number; sections?: number }> {
  const [project] = await d.db.select().from(projects).where(eq(projects.id, req.projectId));
  const theme = (project?.brand ?? undefined) as Record<string, unknown> | undefined;
  const images = d.images ?? new PlaceholderImageResolver();
  const id = newId("art");
  const key = `projects/${req.projectId}/${req.kind}s/${id}.json`;
  d.events.emit({ type: "phase.started", projectId: req.projectId, taskId: req.taskId, phase: "slides" });
  if (req.kind === "deck") {
    const r = await generateDeck(d.llm, { brief: req.prompt, slideCount: req.slideCount ?? 10, theme });
    const deck = await resolveDeckImages(r.value, images);
    await d.store.put(key, JSON.stringify(deck), { contentType: "application/json" });
    await d.db.insert(artifacts).values({ id, projectId: req.projectId, taskId: req.taskId, kind: "deck", storageKey: key, mimeType: "application/json", meta: { title: deck.title, slides: deck.slides.length, mock: r.mock }, costUsd: r.costUsd });
    d.events.emit({ type: "artifact.ready", projectId: req.projectId, taskId: req.taskId, artifactId: id, kind: "deck", url: await d.store.url(key) });
    return { artifactId: id, slides: deck.slides.length };
  }
  const r = await generateDocument(d.llm, { brief: req.prompt, theme });
  const doc = await resolveDocImages(r.value, images);
  await d.store.put(key, JSON.stringify(doc), { contentType: "application/json" });
  await d.db.insert(artifacts).values({ id, projectId: req.projectId, taskId: req.taskId, kind: "document", storageKey: key, mimeType: "application/json", meta: { title: doc.title, sections: doc.sections.length, mock: r.mock }, costUsd: r.costUsd });
  d.events.emit({ type: "artifact.ready", projectId: req.projectId, taskId: req.taskId, artifactId: id, kind: "document", url: await d.store.url(key) });
  return { artifactId: id, sections: doc.sections.length };
}
