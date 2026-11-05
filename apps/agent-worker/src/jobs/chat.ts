import { desc, eq, projects, projectFiles, tasks, type Db } from "@forge/db";
import { getModels, textOf, type LLMProvider } from "@forge/llm";
import type { BuildJob, EventSink } from "@forge/shared";

export const CHAT_SYSTEM = `You are Scoutr, the assistant inside an app builder. The user is chatting (not asking for a build).
Answer questions about their project, explain what was built, suggest next steps, and help them phrase build requests.
Be concise and friendly, answer in the user's language, and never claim to have changed code in chat mode —
if they want a change, tell them to switch to Build mode.`;

/** Chat mode: answer with project context; nothing is built. */
export async function runChat(job: BuildJob, d: { db: Db; llm: LLMProvider; events: EventSink }): Promise<string> {
  const [project] = await d.db.select().from(projects).where(eq(projects.id, job.projectId));
  const files = await d.db.select({ path: projectFiles.path }).from(projectFiles).where(eq(projectFiles.projectId, job.projectId));
  const recent = await d.db.select({ prompt: tasks.prompt, status: tasks.status, intents: tasks.intents }).from(tasks).where(eq(tasks.projectId, job.projectId)).orderBy(desc(tasks.createdAt)).limit(8);
  const context = [
    `Project: ${project?.name ?? "?"} (template: ${project?.template ?? "none yet"})`,
    `Files (${files.length}): ${files.slice(0, 60).map((f) => f.path).join(", ") || "none"}`,
    `Recent requests:\n${recent.filter((r) => r.prompt !== job.prompt).map((r) => `- [${r.status}] ${r.prompt.slice(0, 160)}`).join("\n") || "- none"}`,
  ].join("\n");
  const r = await d.llm.complete({
    purpose: "assistant.chat",
    model: getModels().fast,
    system: CHAT_SYSTEM,
    messages: [{ role: "user", content: `## Project context\n${context}\n\n## Message\n${job.prompt}` }],
    maxTokens: 2000,
    effort: "low",
  });
  const text = textOf(r).trim() || "…";
  d.events.emit({ type: "team.message", projectId: job.projectId, taskId: job.taskId, from: "chatti", to: "user", status: "done", step: "chat", key: "team.chat.reply", params: {}, text });
  d.events.emit({ type: "message", projectId: job.projectId, taskId: job.taskId, role: "assistant", text });
  return text;
}
