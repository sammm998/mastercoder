/** Shared helper for the site integration test: compose → write → npm install → vite build. */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { MockLLMProvider } from "@forge/llm";
import {
  composeLanding,
  composePortfolio,
  generateContent,
  generateDirections,
  pickDirection,
  type ArtDirection,
  type SectionType,
  type SiteContent,
} from "../src/index.js";
import type { BENCHMARK_BRIEFS } from "./briefs.js";

const exec = promisify(execFile);

export interface BuiltSite {
  id: string;
  dir: string;
  dist: string;
  direction: ArtDirection;
  content: SiteContent;
  files: Record<string, string>;
  buildLog: string;
}

export async function writeProject(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

export async function composeSite(spec: (typeof BENCHMARK_BRIEFS)[number]) {
  const llm = new MockLLMProvider();
  const dirs = await generateDirections(llm, spec.brief);
  const direction = pickDirection(dirs, spec.brief);
  const content = await generateContent(llm, spec.brief, spec.sections ?? []);
  const files =
    spec.kind === "portfolio"
      ? composePortfolio({ brief: spec.brief, direction, content })
      : composeLanding({ brief: spec.brief, direction, content, sections: spec.sections as SectionType[] | undefined });
  return { direction, content, files, directions: dirs };
}

export async function buildSite(spec: (typeof BENCHMARK_BRIEFS)[number], root: string): Promise<BuiltSite> {
  const { direction, content, files } = await composeSite(spec);
  const dir = join(root, spec.id);
  await writeProject(dir, files);
  const env = { ...process.env, npm_config_fund: "false", npm_config_audit: "false", npm_config_update_notifier: "false" };
  const install = await exec("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline", "--loglevel=error"], { cwd: dir, env, maxBuffer: 32 * 1024 * 1024, timeout: 600_000 });
  const build = await exec("npm", ["run", "build"], { cwd: dir, env, maxBuffer: 32 * 1024 * 1024, timeout: 300_000 });
  return { id: spec.id, dir, dist: join(dir, "dist"), direction, content, files, buildLog: install.stderr + build.stdout + build.stderr };
}
