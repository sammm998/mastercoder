import { z } from "zod";
import { defineTool, type ForgeTool } from "@forge/llm";
import type { AgentDeps, TemplateManifestLike } from "./ports.js";
import type { RepoMap } from "./context/repo-map.js";
import type { VectorIndex } from "./context/embeddings.js";

export interface ToolRuntime {
  deps: AgentDeps;
  projectId: string;
  taskId: string;
  repoMap: RepoMap;
  index: VectorIndex;
  manifest: () => TemplateManifestLike | null;
  previewUrl: () => string | null;
  /** Files written during this task (for review diffs and checkpoints). */
  touched: Set<string>;
}

const RelPath = z
  .string()
  .min(1)
  .max(400)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes("..") && !p.includes("\0"), "Path must be relative to the project root");

const MAX_OUT = 12_000;
const clip = (s: string, n = MAX_OUT) => (s.length > n ? `${s.slice(0, n / 2)}\n…[${s.length - n} chars truncated]…\n${s.slice(-n / 2)}` : s);

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function afterWrite(rt: ToolRuntime, path: string, content: string, change: "created" | "modified") {
  rt.touched.add(path);
  await rt.repoMap.update(path, content);
  await rt.index.upsertFile(rt.projectId, path, content);
  rt.deps.events.emit({ type: "file.changed", projectId: rt.projectId, taskId: rt.taskId, path, change });
}

async function exists(rt: ToolRuntime, path: string): Promise<boolean> {
  try {
    await rt.deps.sandbox.readFile(path);
    return true;
  } catch {
    return false;
  }
}

export function buildTools(rt: ToolRuntime): ForgeTool<unknown>[] {
  const { deps } = rt;
  const sb = deps.sandbox;
  const exec = async (cmd: string, timeoutSec = 300) => {
    const r = await sb.exec(cmd, { timeoutMs: timeoutSec * 1000 });
    const text = `$ ${cmd}\nexit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`;
    deps.events.emit({ type: "terminal.output", projectId: rt.projectId, taskId: rt.taskId, stream: r.exitCode === 0 ? "stdout" : "stderr", text: clip(text, 4000) });
    return { ...r, text: clip(text) };
  };
  const manifestCmd = (key: "test" | "e2e" | "typecheck" | "lint" | "build") => {
    const m = rt.manifest();
    const cmd = m?.[key];
    if (!cmd) throw new Error(`This project has no ${key} command in forge.json`);
    return cmd;
  };

  const tools: ForgeTool<unknown>[] = [
    defineTool({
      name: "read_file",
      description: "Read a file (optionally a line range). Returns numbered lines.",
      input: z.object({ path: RelPath, startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional() }),
      run: async ({ path, startLine, endLine }) => {
        const lines = (await sb.readFile(path)).split("\n");
        const s = (startLine ?? 1) - 1;
        const e = Math.min(endLine ?? lines.length, s + 1500);
        return lines.slice(s, e).map((l, i) => `${String(s + i + 1).padStart(5)}  ${l}`).join("\n");
      },
    }),
    defineTool({
      name: "write_file",
      description: "Create or overwrite a file with the full content.",
      input: z.object({ path: RelPath, content: z.string().max(400_000) }),
      run: async ({ path, content }) => {
        const existed = await exists(rt, path);
        await sb.writeFile(path, content);
        await afterWrite(rt, path, content, existed ? "modified" : "created");
        return `${existed ? "Updated" : "Created"} ${path} (${content.split("\n").length} lines)`;
      },
    }),
    defineTool({
      name: "edit_file",
      description: "Replace an exact snippet in a file. oldText must match exactly and be unique unless replaceAll is true.",
      input: z.object({ path: RelPath, oldText: z.string().min(1), newText: z.string(), replaceAll: z.boolean().default(false) }),
      run: async ({ path, oldText, newText, replaceAll }) => {
        const src = await sb.readFile(path);
        const count = src.split(oldText).length - 1;
        if (count === 0) throw new Error(`oldText not found in ${path}. Re-read the file and copy the snippet exactly.`);
        if (count > 1 && !replaceAll) throw new Error(`oldText occurs ${count} times in ${path}; add surrounding context or set replaceAll.`);
        const next = replaceAll ? src.split(oldText).join(newText) : src.replace(oldText, () => newText);
        await sb.writeFile(path, next);
        await afterWrite(rt, path, next, "modified");
        return `Edited ${path} (${count} replacement${count > 1 ? "s" : ""})`;
      },
    }),
    defineTool({
      name: "list_files",
      description: "List files in a directory (recursive by default, excluding node_modules/.git).",
      input: z.object({ dir: z.string().max(400).default("."), recursive: z.boolean().default(true) }),
      run: async ({ dir, recursive }) => {
        const files = (await sb.listFiles(dir, { recursive })).filter((f) => !/(^|\/)(node_modules|\.git|\.next|dist)(\/|$)/.test(f));
        return clip(files.join("\n") || "(empty)");
      },
    }),
    defineTool({
      name: "search_code",
      description: "Search the codebase. mode=semantic uses the vector index; mode=text runs grep for an exact string or regex.",
      input: z.object({ query: z.string().min(1).max(500), mode: z.enum(["semantic", "text"]).default("semantic") }),
      run: async ({ query, mode }) => {
        if (mode === "semantic") {
          const hits = await rt.index.search(rt.projectId, query, 8);
          return hits.map((h) => `${h.path}#${h.chunk} (${h.score.toFixed(2)})\n${h.preview}`).join("\n---\n") || "No matches";
        }
        const r = await exec(`grep -rnE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next -m 200 ${shellQuote(query)} . || true`, 60);
        return r.stdout || "No matches";
      },
    }),
    defineTool({
      name: "run_command",
      description: "Run a shell command in the project sandbox (network limited to an allowlist).",
      input: z.object({ command: z.string().min(1).max(4000), timeoutSec: z.number().int().min(1).max(1800).default(300) }),
      run: async ({ command, timeoutSec }) => (await exec(command, timeoutSec)).text,
    }),
    defineTool({
      name: "install_package",
      description: "Install dependencies with the project's package manager.",
      input: z.object({ packages: z.array(z.string().regex(/^(@?[\w.-]+\/)?[\w.-]+(@[\w.^~<>=*-]+)?$/)).min(1).max(30), dev: z.boolean().default(false), manager: z.enum(["npm", "pnpm", "pip"]).default("npm") }),
      run: async ({ packages, dev, manager }) => {
        const list = packages.map(shellQuote).join(" ");
        const cmd = manager === "pip" ? `pip install ${list}` : manager === "pnpm" ? `pnpm add ${dev ? "-D " : ""}${list}` : `npm install ${dev ? "--save-dev " : ""}${list}`;
        return (await exec(cmd, 600)).text;
      },
    }),
    defineTool({
      name: "run_tests",
      description: "Run the project's unit/integration tests (forge.json test command).",
      input: z.object({}),
      run: async () => (await exec(manifestCmd("test"), 900)).text,
    }),
    defineTool({
      name: "run_e2e",
      description: "Run the Playwright acceptance tests (forge.json e2e command).",
      input: z.object({}),
      run: async () => (await exec(manifestCmd("e2e"), 1200)).text,
    }),
    defineTool({
      name: "take_screenshot",
      description: "Screenshot the running preview at a viewport width (375, 768 or 1440).",
      input: z.object({ path: z.string().max(400).default("/"), viewport: z.union([z.literal(375), z.literal(768), z.literal(1440)]).default(1440) }),
      run: async ({ path, viewport }) => {
        const base = rt.previewUrl();
        if (!base || !deps.browser) throw new Error("No running preview or browser available");
        const shot = await deps.browser.screenshot(new URL(path, base).toString(), viewport);
        deps.events.emit({ type: "screenshot", projectId: rt.projectId, taskId: rt.taskId, url: shot.url, viewport });
        return `Screenshot saved: ${shot.url}`;
      },
    }),
    defineTool({
      name: "record_video",
      description: "Record a short video of the preview (scrolling through the page).",
      input: z.object({ seconds: z.number().int().min(2).max(30).default(8) }),
      run: async ({ seconds }) => {
        const base = rt.previewUrl();
        if (!base || !deps.browser?.recordVideo) throw new Error("Video recording unavailable");
        return `Video saved: ${(await deps.browser.recordVideo(base, seconds)).url}`;
      },
    }),
    defineTool({
      name: "read_logs",
      description: "Read the tail of the dev server log.",
      input: z.object({ lines: z.number().int().min(10).max(2000).default(200) }),
      run: async ({ lines }) => (await exec(`tail -n ${lines} /tmp/forge-dev.log 2>/dev/null || echo "(no dev server log)"`, 30)).stdout,
    }),
    defineTool({
      name: "db_query",
      description: "Run SQL against the project's database. Read-only unless write=true.",
      input: z.object({ sql: z.string().min(1).max(20_000), write: z.boolean().default(false) }),
      run: async ({ sql, write }) => {
        if (!deps.projectDb) throw new Error("Project database not available");
        const r = await deps.projectDb.query(rt.projectId, sql, { readOnly: !write });
        return clip(JSON.stringify({ rowCount: r.rowCount, rows: r.rows.slice(0, 100) }, null, 2));
      },
    }),
    defineTool({
      name: "db_migrate",
      description: "Apply database migrations (forge.json migrate script or `npm run db:migrate`).",
      input: z.object({}),
      run: async () => (await exec("npm run db:migrate --if-present", 600)).text,
    }),
    defineTool({
      name: "web_search_docs",
      description: "Search library/framework documentation.",
      input: z.object({ query: z.string().min(2).max(300) }),
      run: async ({ query }) => {
        if (!deps.docs) throw new Error("Docs search unavailable");
        const hits = await deps.docs.search(query);
        return hits.map((h) => `${h.title} — ${h.url}\n${h.snippet}`).join("\n\n") || "No results";
      },
    }),
    defineTool({
      name: "generate_image",
      description: "Generate images in the project's brand style; returns artifact URLs usable in the app.",
      input: z.object({ prompt: z.string().min(3).max(2000), n: z.number().int().min(1).max(8).default(1) }),
      run: async ({ prompt, n }) => {
        if (!deps.media) throw new Error("Media engine unavailable");
        return { images: await deps.media.generateImage({ projectId: rt.projectId, prompt, n }) };
      },
    }),
    defineTool({
      name: "generate_video",
      description: "Generate a short video clip.",
      input: z.object({ prompt: z.string().min(3).max(2000), durationSec: z.number().int().min(2).max(20).default(5) }),
      run: async ({ prompt, durationSec }) => {
        if (!deps.media) throw new Error("Media engine unavailable");
        return deps.media.generateVideo({ projectId: rt.projectId, prompt, durationSec });
      },
    }),
    defineTool({
      name: "create_slides",
      description: "Create a slide deck in the project.",
      input: z.object({ prompt: z.string().min(3).max(4000), slideCount: z.number().int().min(1).max(40).default(10) }),
      run: async ({ prompt, slideCount }) => {
        if (!deps.slides) throw new Error("Slides engine unavailable");
        return deps.slides.createDeck({ projectId: rt.projectId, prompt, slideCount });
      },
    }),
    defineTool({
      name: "use_integration",
      description: "Call a connected integration tool (OpenAPI operation, connector action or MCP tool). Use tool='list' to see what is available.",
      input: z.object({ tool: z.string().min(1).max(200), input: z.record(z.unknown()).default({}) }),
      run: async ({ tool, input }) => {
        if (!deps.integrations) throw new Error("No integrations connected");
        if (tool === "list") return { tools: await deps.integrations.listTools(rt.projectId) };
        return { result: await deps.integrations.call(rt.projectId, tool, input) };
      },
    }),
    defineTool({
      name: "ask_user",
      description: "Ask the user ONE question when a decision is ambiguous and expensive to redo. Otherwise make a sensible assumption.",
      input: z.object({ question: z.string().min(5).max(500), options: z.array(z.string().max(100)).max(5).optional() }),
      run: async ({ question, options }) => {
        deps.events.emit({ type: "clarify.question", projectId: rt.projectId, taskId: rt.taskId, question, options });
        const answer = deps.askUser ? await deps.askUser.ask(question, options) : null;
        return answer ? `User answered: ${answer}` : "No answer available right now; proceed with the most reasonable assumption and state it in your summary.";
      },
    }),
  ];
  return tools;
}
