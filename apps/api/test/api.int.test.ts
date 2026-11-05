import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, tasks, users } from "@forge/db";
import { caller, ctxFor, signup, testDeps, uniq } from "./helpers.js";

let deps: Awaited<ReturnType<typeof testDeps>>;
beforeAll(async () => {
  deps = await testDeps();
});
afterAll(async () => deps.close());

describe("auth", () => {
  it("signs up, logs in, rejects bad password and bots", async () => {
    const email = `a${uniq()}@test.local`;
    const a = await signup(deps, email);
    expect(a.user.email).toBe(email);
    const anon = caller(ctxFor(deps, null, "10.9.9.9"));
    await expect(anon.auth.login({ email, password: "wrong-password-1" })).rejects.toThrow(/Invalid email or password/);
    const ok = await anon.auth.login({ email, password: "Correct-Horse-9" });
    expect(ok.token.length).toBeGreaterThan(20);
    await expect(anon.auth.signup({ email: `b${uniq()}@t.local`, password: "Correct-Horse-9", name: "", locale: "en", website: "spam.example" })).rejects.toThrow(/Bot check/);
    await expect(anon.auth.signup({ email: `c${uniq()}@t.local`, password: "short", name: "", locale: "en", elapsedMs: 5000 })).rejects.toThrow(/at least 10/);
  });

  it("rate limits credential endpoints per IP", async () => {
    const anon = caller(ctxFor(deps, null, "10.66.66.66"));
    const attempts = Array.from({ length: 12 }, () => anon.auth.login({ email: "nobody@test.local", password: "x" }).catch((e: Error) => e.message));
    const results = await Promise.all(attempts);
    expect(results.some((m) => /Too many attempts/.test(String(m)))).toBe(true);
  });

  it("magic link creates and signs in a verified user", async () => {
    const email = `m${uniq()}@test.local`;
    const anon = caller(ctxFor(deps, null, "10.1.2.3"));
    await anon.auth.requestMagicLink({ email, locale: "sv" });
    const msg = deps.email.sent.find((m) => m.to === email);
    expect(msg?.subject).toMatch(/inloggningslänk/);
    const token = decodeURIComponent(msg!.text.match(/token=([^\s]+)/)![1]!);
    const r = await anon.auth.verifyMagicLink({ token, locale: "sv" });
    expect(r.user.email).toBe(email);
    await expect(anon.auth.verifyMagicLink({ token, locale: "sv" })).rejects.toThrow(/invalid or has expired/);
  });
});

describe("workspaces, projects, RBAC", () => {
  it("isolates tenants and enforces roles", async () => {
    const a = await signup(deps, `owner${uniq()}@test.local`);
    const b = await signup(deps, `ed${uniq()}@test.local`);
    const v = await signup(deps, `view${uniq()}@test.local`);
    const { id: projectId } = await a.c.project.create({ workspaceId: a.workspaceId, name: "Demo" });
    await a.c.project.writeFile({ projectId, path: "src/App.tsx", content: "export const x = 1;" });

    await expect(b.c.project.readFile({ projectId, path: "src/App.tsx" })).rejects.toThrow(/not found/i);
    await expect(b.c.project.list({ workspaceId: a.workspaceId })).rejects.toThrow(/not found/i);

    await a.c.workspace.invite({ workspaceId: a.workspaceId, email: b.user.email, role: "editor" });
    await a.c.workspace.invite({ workspaceId: a.workspaceId, email: v.user.email, role: "viewer" });
    const tok = (to: string) => decodeURIComponent(deps.email.sent.filter((m) => m.to === to).at(-1)!.text.match(/token=([^\s]+)/)![1]!);
    await expect(v.c.workspace.acceptInvite({ token: tok(b.user.email) })).rejects.toThrow(/different email/);
    await b.c.workspace.acceptInvite({ token: tok(b.user.email) });
    await v.c.workspace.acceptInvite({ token: tok(v.user.email) });

    await b.c.project.writeFile({ projectId, path: "src/App.tsx", content: "export const x = 2;" });
    expect((await v.c.project.readFile({ projectId, path: "src/App.tsx" })).content).toBe("export const x = 2;");
    await expect(v.c.project.writeFile({ projectId, path: "src/App.tsx", content: "hack" })).rejects.toThrow(/Requires project.write/);
    await expect(b.c.workspace.invite({ workspaceId: a.workspaceId, email: "x@test.local", role: "admin" })).rejects.toThrow(/Requires members.manage/);
    await expect(a.c.project.writeFile({ projectId, path: "../etc/passwd", content: "x" })).rejects.toThrow();

    const log = await a.c.workspace.auditLog({ workspaceId: a.workspaceId, limit: 50 });
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["project.create", "workspace.invite", "workspace.join"]));
  });

  it("public projects can be remixed", async () => {
    const a = await signup(deps, `pub${uniq()}@test.local`);
    const b = await signup(deps, `rmx${uniq()}@test.local`);
    const { id } = await a.c.project.create({ workspaceId: a.workspaceId, name: "Open" });
    await a.c.project.writeFile({ projectId: id, path: "index.html", content: "<h1>hi</h1>" });
    await expect(b.c.project.remix({ projectId: id, workspaceId: b.workspaceId })).rejects.toThrow(/not found/i);
    await a.c.project.setPublic({ projectId: id, isPublic: true });
    const r = await b.c.project.remix({ projectId: id, workspaceId: b.workspaceId });
    expect((await b.c.project.readFile({ projectId: r.id, path: "index.html" })).content).toBe("<h1>hi</h1>");
    expect((await caller(ctxFor(deps, null)).project.gallery({ limit: 100 })).some((p) => p.id === id)).toBe(true);
  });
});

describe("tasks", () => {
  it("classifies, estimates, enqueues and asks one clarifying question when needed", async () => {
    const a = await signup(deps, `task${uniq()}@test.local`);
    const { id: projectId } = await a.c.project.create({ workspaceId: a.workspaceId, name: "T" });
    const t = await a.c.task.create({ projectId, prompt: "Build a todo app", source: "typed", planMode: false });
    expect(t.status).toBe("queued");
    expect(deps.queue.jobs.some((j) => (j.payload as { taskId: string }).taskId === t.id)).toBe(true);
    const ev = await a.c.project.events({ projectId, limit: 50 });
    expect(ev.map((e) => e.type)).toEqual(expect.arrayContaining(["intent.classified", "cost.estimate"]));

    const q = await a.c.task.create({ projectId, prompt: "Make something", source: "voice", planMode: false });
    expect(q.status).toBe("awaiting_clarification");
    expect(q.question).toBe("What should it do?");
    await a.c.task.answerClarification({ taskId: q.id, answer: "A habit tracker" });
    const [row] = await deps.db.select().from(tasks).where(eq(tasks.id, q.id));
    expect(row?.status).toBe("queued");
    expect(row?.prompt).toContain("habit tracker");
  });
});

describe("gdpr", () => {
  it("exports data and deletes the account", async () => {
    const a = await signup(deps, `gdpr${uniq()}@test.local`);
    await a.c.project.create({ workspaceId: a.workspaceId, name: "Mine" });
    const exp = await a.c.gdpr.exportMyData();
    const data = JSON.parse(Buffer.from(await deps.store.get(exp.key)).toString());
    expect(data.user.email).toBe(a.user.email);
    expect(data.user.passwordHash).toBeUndefined();
    expect(data.projects).toHaveLength(1);
    await expect(a.c.gdpr.deleteMyAccount({ confirmEmail: "other@test.local" })).rejects.toThrow(/does not match/);
    const del = await a.c.gdpr.deleteMyAccount({ confirmEmail: a.user.email });
    expect(del.deletedWorkspaces).toEqual([a.workspaceId]);
    const [u] = await deps.db.select().from(users).where(eq(users.id, a.user.id));
    expect(u?.deletedAt).not.toBeNull();
    expect(u?.email).toMatch(/forge\.invalid$/);
  });
});
