import { describe, expect, it } from "vitest";
import { EventBus, MemoryUsageSink, isForgeError } from "@forge/shared";
import { MockLLMProvider } from "@forge/llm";
import { ErrorIngest, createProjectToken, fingerprint, handleErrorIngestRequest, mockSuggestFix, normalizeMessage, parseStack, verifyProjectToken } from "../src/index.js";

const V8 = `TypeError: Cannot read properties of undefined (reading 'name')
    at renderUser (/app/.next/server/chunks/src/app/users/page.tsx:12:31)
    at Array.map (<anonymous>)
    at UsersPage (/app/src/app/users/page.tsx:20:5)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at render (/app/node_modules/react-dom/cjs/react-dom-server.js:100:1)`;

const SOURCE = ["import { db } from '@/db/client';", "", "type U = { profile?: { name: string } };", "", "function renderUser(u: U) {", "  return (", "    <li>", "      <span>", "", "", "", "        {u.profile.name}", "      </span>", "    </li>", "  );", "}"].join("\n");

describe("stack parsing and fingerprints", () => {
  it("parses V8, Gecko and Python frames and marks in-app code", () => {
    const v8 = parseStack(V8);
    expect(v8[0]).toMatchObject({ function: "renderUser", file: "src/app/users/page.tsx", line: 12, inApp: true });
    expect(v8.find((f) => f.file.includes("react-dom"))?.inApp).toBe(false);
    expect(parseStack("handle@https://site.eu/_next/static/chunks/app/page-abc.js:1:200")[0]?.function).toBe("handle");
    const py = parseStack('Traceback (most recent call last):\n  File "/srv/app/main.py", line 10, in outer\n  File "/srv/app/services.py", line 3, in inner\nKeyError: x');
    expect(py[0]).toMatchObject({ file: "app/services.py", line: 3, function: "inner" });
  });

  it("groups the same bug across ids, numbers and line shifts", () => {
    const a = fingerprint({ type: "TypeError", message: "User 123 not found (id 9f2c1e4a-1111-4222-8333-944455556666)", stack: V8 });
    const b = fingerprint({ type: "TypeError", message: "User 987 not found (id 0a2c1e4a-1111-4222-8333-944455556666)", stack: V8.replace(":12:31", ":14:2") });
    expect(a).toBe(b);
    expect(fingerprint({ type: "RangeError", message: "User 1 not found", stack: V8 })).not.toBe(a);
    expect(normalizeMessage("Cannot read properties of undefined (reading 'name')")).toContain("'name'");
  });
});

describe("ErrorIngest", () => {
  it("groups events, counts occurrences and reopens resolved groups", async () => {
    const ingest = new ErrorIngest();
    const e = { type: "TypeError", message: "Cannot read properties of undefined (reading 'name')", stack: V8 };
    const first = await ingest.ingest("prj", e);
    const second = await ingest.ingest("prj", { ...e, timestamp: "2030-01-01T00:00:00.000Z" });
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.group.count).toBe(2);
    expect(second.group.lastSeen).toBe("2030-01-01T00:00:00.000Z");
    await ingest.setStatus(first.group.id, "resolved");
    expect((await ingest.ingest("prj", e)).group.status).toBe("open");
    expect(await ingest.listGroups("other")).toEqual([]);
    await expect(ingest.ingest("prj", { message: "" })).rejects.toThrow();
  });

  it("suggests a fix via appkit.suggest_fix, meters it, and requires approval before applying", async () => {
    const usage = new MemoryUsageSink();
    const events = new EventBus();
    const llm = new MockLLMProvider();
    const ingest = new ErrorIngest({ llm, usage, events, model: "claude-sonnet-5-5" });
    const { group } = await ingest.ingest("prj", { type: "TypeError", message: "Cannot read properties of undefined (reading 'name')", stack: V8 });
    const files = new Map([["src/app/users/page.tsx", SOURCE]]);
    const io = { readFile: async (p: string) => files.get(p) ?? null, writeFile: async (p: string, c: string) => void files.set(p, c) };

    const fix = await ingest.suggestFix(group.id, io);
    expect(llm.calls[0]?.purpose).toBe("appkit.suggest_fix");
    expect(fix).toMatchObject({ status: "pending_approval", isMock: true, groupId: group.id });
    expect(fix.summary).toMatch(/^\[mock\]/);
    expect(fix.patches).toEqual([{ path: "src/app/users/page.tsx", search: "        {u.profile.name}", replace: "        {u.profile?.name}" }]);
    expect(usage.records.length).toBeGreaterThan(0);
    expect(usage.records.every((r) => r.projectId === "prj" && r.costUsd >= 0)).toBe(true);
    expect(events.ofType("approval.required")[0]).toMatchObject({ approvalId: fix.id, action: "appkit.apply_fix" });

    const blocked = await ingest.applyFix(fix.id, io).catch((e: unknown) => e);
    expect(isForgeError(blocked) && blocked.code).toBe("APPROVAL_REQUIRED");
    expect(files.get("src/app/users/page.tsx")).toContain("u.profile.name");

    await ingest.approveFix(fix.id, "user_1");
    expect(await ingest.applyFix(fix.id, io)).toEqual({ changed: ["src/app/users/page.tsx"] });
    expect(files.get("src/app/users/page.tsx")).toContain("u.profile?.name");
    await expect(ingest.approveFix(fix.id, "user_1")).rejects.toThrow(/is applied/);
  });

  it("refuses to apply a fix when the file changed since", async () => {
    const ingest = new ErrorIngest({ llm: new MockLLMProvider() });
    const { group } = await ingest.ingest("prj", { type: "TypeError", message: "Cannot read properties of undefined (reading 'name')", stack: V8 });
    const files = new Map([["src/app/users/page.tsx", SOURCE]]);
    const io = { readFile: async (p: string) => files.get(p) ?? null, writeFile: async (p: string, c: string) => void files.set(p, c) };
    const fix = await ingest.suggestFix(group.id, io);
    await ingest.approveFix(fix.id, "u");
    files.set("src/app/users/page.tsx", "rewritten");
    await expect(ingest.applyFix(fix.id, io)).rejects.toThrow(/does not match/);
  });

  it("can be rejected", async () => {
    const ingest = new ErrorIngest({ llm: new MockLLMProvider() });
    const { group } = await ingest.ingest("prj", { message: "fetch failed" });
    const fix = await ingest.suggestFix(group.id);
    expect(fix.patches).toEqual([]);
    expect((await ingest.rejectFix(fix.id, "u")).status).toBe("rejected");
  });
});

describe("mock suggest_fix rules", () => {
  it("covers not-a-function, network and unknown errors", () => {
    const nf = mockSuggestFix({ error: { type: "TypeError", message: "props.onSave is not a function" }, sources: [{ path: "src/a.tsx", line: 3, code: "  props.onSave(data);" }] });
    expect(nf.patches[0]?.replace).toBe("  props.onSave?.(data);");
    expect(mockSuggestFix({ error: { type: "Error", message: "connect ECONNREFUSED 127.0.0.1:5432" }, sources: [] }).patches).toEqual([]);
    expect(mockSuggestFix({ error: { type: "WeirdError", message: "???" }, sources: [] }).confidence).toBe(0);
  });
});

describe("handleErrorIngestRequest", () => {
  const SECRET = "ingest-secret-ingest-secret-ingest-secret";
  const key = createProjectToken({ projectId: "prj", scope: ["ingest"] }, SECRET);
  const verifyToken = (t: string) => verifyProjectToken(t, SECRET, "ingest");

  it("accepts single events and batches from browsers with the ingest key", async () => {
    const ingest = new ErrorIngest();
    const one = await handleErrorIngestRequest(new Request("https://errors.forge.test/v1/events", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ message: "boom" }) }), { ingest, verifyToken });
    expect(one.status).toBe(202);
    expect(one.headers.get("access-control-allow-origin")).toBe("*");
    const batch = await handleErrorIngestRequest(new Request(`https://errors.forge.test/v1/events?key=${key}`, { method: "POST", body: JSON.stringify([{ message: "a" }, { message: "a" }]) }), { ingest, verifyToken });
    expect(await batch.json()).toMatchObject({ accepted: 2 });
    expect((await ingest.listGroups("prj"))[0]?.count).toBe(2);
  });

  it("rejects bad keys and invalid events", async () => {
    const ingest = new ErrorIngest();
    expect((await handleErrorIngestRequest(new Request("https://e.test/", { method: "POST", body: "{}" }), { ingest, verifyToken })).status).toBe(401);
    expect((await handleErrorIngestRequest(new Request("https://e.test/", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ message: 5 }) }), { ingest, verifyToken })).status).toBe(400);
    expect((await handleErrorIngestRequest(new Request("https://e.test/", { method: "OPTIONS" }), { ingest, verifyToken })).status).toBe(204);
  });
});
