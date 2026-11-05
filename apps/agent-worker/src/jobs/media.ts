import { readFile } from "node:fs/promises";
import { and, eq, artifacts, projects, type Db } from "@forge/db";
import { newId, type EventSink, type ObjectStore, type UsageSink } from "@forge/shared";
import { MediaJobService, generateLogo, styleFromBrand, type Brand, type MediaJob, type MediaProvider, type Artifact } from "@forge/media";

export interface MediaPipelineDeps {
  db: Db;
  provider: MediaProvider;
  store: ObjectStore;
  usage: UsageSink;
  events: EventSink;
  /** Lazily loaded so workers without Remotion deps still run image/video jobs. */
  renderRemotion?: (opts: { composition: "Explainer" | "ProductDemo" | "AnimatedText"; props: unknown; durationSec: number }) => Promise<{ outputPath: string; durationSec: number }>;
}

export interface MediaRequest {
  taskId: string;
  projectId: string;
  workspaceId: string;
  kind: "image" | "image-set" | "logo" | "video" | "remotion";
  prompt: string;
  options?: Record<string, unknown>;
}

/** Brand from the project's design tokens (or a neutral default). */
export function brandFromProject(brand: unknown): Brand {
  const b = (brand ?? {}) as { palette?: Record<string, string> | string[]; colors?: Record<string, string>; mood?: string; fontFamily?: string; fonts?: { display?: string } };
  const palette = b.palette ?? b.colors ?? ["#101010", "#f4f1ea", "#c8553d"];
  return { palette, mood: b.mood ?? "clean, modern, Scandinavian", fontFamily: b.fontFamily ?? b.fonts?.display };
}

/** Shot variations so an image set covers different compositions in one shared style. */
export function setPrompts(prompt: string, n: number): string[] {
  const shots = ["hero product shot", "close-up detail", "lifestyle scene in use", "flat lay from above", "packaging on a shelf", "in-hand shot"];
  return Array.from({ length: n }, (_, i) => `${prompt}, ${shots[i % shots.length]}`);
}

async function saveArtifacts(db: Db, projectId: string, taskId: string, list: Artifact[]): Promise<void> {
  if (!list.length) return;
  await db.insert(artifacts).values(list.map((a) => ({ id: a.id, projectId, taskId, kind: a.kind, storageKey: a.storageKey, mimeType: a.mimeType, meta: a.meta, costUsd: a.costUsd })));
}

export async function runMediaRequest(req: MediaRequest, d: MediaPipelineDeps): Promise<Artifact[]> {
  const [project] = await d.db.select().from(projects).where(eq(projects.id, req.projectId));
  const brand = brandFromProject(project?.brand);
  const style = styleFromBrand(brand);
  const svc = new MediaJobService({ provider: d.provider, store: d.store, sink: d.usage, events: d.events });
  const ctx = { projectId: req.projectId, taskId: req.taskId, workspaceId: req.workspaceId };
  const o = req.options ?? {};
  let out: Artifact[] = [];
  if (req.kind === "image" || req.kind === "image-set") {
    const n = req.kind === "image-set" ? Math.min(8, Number(o.n ?? 4)) : 1;
    const prompts = req.kind === "image-set" ? setPrompts(req.prompt, n) : [req.prompt];
    for (const p of prompts) {
      const job: MediaJob = { type: "text-to-image", prompt: p, width: Number(o.width ?? 1024), height: Number(o.height ?? 1024), n: 1, style: style.suffix, seed: style.seed, palette: Array.isArray(brand.palette) ? brand.palette : Object.values(brand.palette) };
      out.push(...(await svc.run(job, ctx)));
    }
  } else if (req.kind === "video") {
    out = await svc.run({ type: "text-to-video", prompt: `${req.prompt}. ${style.suffix}`, durationSec: Number(o.durationSec ?? 10), aspectRatio: "16:9" }, ctx);
  } else if (req.kind === "logo") {
    const logo = await generateLogo(d.provider, { name: String(o.name ?? project?.name ?? req.prompt.slice(0, 40)), brand, tagline: o.tagline as string | undefined });
    for (const [size, bytes] of Object.entries(logo.sizes)) {
      const id = newId("art");
      const key = `projects/${req.projectId}/media/${id}-logo-${size}.png`;
      await d.store.put(key, bytes, { contentType: "image/png" });
      out.push({ id, kind: "image", storageKey: key, mimeType: "image/png", meta: { logo: true, size: Number(size) }, costUsd: 0 });
    }
    d.usage.record({ kind: "image_count", quantity: 1, costUsd: logo.costUsd ?? 0, provider: d.provider.name, projectId: req.projectId, taskId: req.taskId, workspaceId: req.workspaceId });
  } else {
    if (!d.renderRemotion) throw new Error("Remotion rendering is not available on this worker");
    const { videoThemeFrom } = await import("@forge/media/remotion");
    const theme = videoThemeFrom({ colors: Array.isArray(brand.palette) ? { bg: brand.palette[0], text: brand.palette[1], accent: brand.palette[2] } : brand.palette, fonts: brand.fontFamily ? { display: brand.fontFamily, body: brand.fontFamily } : undefined });
    const shots = await d.db.select().from(artifacts).where(and(eq(artifacts.projectId, req.projectId), eq(artifacts.kind, "screenshot")));
    const durationSec = Number(o.durationSec ?? 20);
    d.events.emit({ type: "job.progress", projectId: req.projectId, taskId: req.taskId, jobId: req.taskId, progress: 0.1, label: "rendering with Remotion" });
    const r = shots.length
      ? await d.renderRemotion({
          composition: "ProductDemo",
          durationSec,
          props: { theme, title: project?.name ?? "Product tour", device: "browser", screenshots: await Promise.all(shots.slice(0, 8).map(async (s) => ({ src: `data:${s.mimeType};base64,${Buffer.from(await d.store.get(s.storageKey)).toString("base64")}`, caption: String((s.meta as { caption?: string } | null)?.caption ?? "") }))) },
        })
      : await d.renderRemotion({ composition: "Explainer", durationSec, props: { theme, title: project?.name ?? "Explainer", sections: req.prompt.split(/[.!?]\s+/).filter(Boolean).slice(0, 5).map((s, i) => ({ heading: `Step ${i + 1}`, bullets: [s.slice(0, 120)] })) } });
    const id = newId("art");
    const key = `projects/${req.projectId}/media/${id}.mp4`;
    await d.store.put(key, await readFile(r.outputPath), { contentType: "video/mp4" });
    out = [{ id, kind: "video", storageKey: key, mimeType: "video/mp4", meta: { remotion: true, durationSec: r.durationSec, composition: shots.length ? "ProductDemo" : "Explainer" }, costUsd: 0 }];
    d.usage.record({ kind: "media_seconds", quantity: r.durationSec, costUsd: 0, provider: "remotion", projectId: req.projectId, taskId: req.taskId, workspaceId: req.workspaceId });
    d.events.emit({ type: "artifact.ready", projectId: req.projectId, taskId: req.taskId, artifactId: id, kind: "video", url: await d.store.url(key) });
  }
  await saveArtifacts(d.db, req.projectId, req.taskId, out);
  return out;
}
