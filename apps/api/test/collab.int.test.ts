import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";
import { and, eq, projectFiles } from "@forge/db";
import { buildServer } from "../src/server.js";
import { signup, testDeps, uniq } from "./helpers.js";

let deps: Awaited<ReturnType<typeof testDeps>>;
let base = "";
let close: () => Promise<void>;

beforeAll(async () => {
  deps = await testDeps();
  const { app } = await buildServer(deps);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  base = typeof addr === "object" && addr ? `ws://127.0.0.1:${addr.port}` : "";
  close = async () => {
    await app.close();
    await deps.close();
  };
});
afterAll(async () => close());

const until = async (fn: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timeout");
};

describe("realtime collaboration (Yjs)", () => {
  it("two clients edit the same file live and the result is persisted", async () => {
    const a = await signup(deps, `co${uniq()}@test.local`);
    const { id: projectId } = await a.c.project.create({ workspaceId: a.workspaceId, name: "Collab" });
    await a.c.project.writeFile({ projectId, path: "src/App.tsx", content: "hello" });

    const mk = () => {
      const doc = new Y.Doc();
      const p = new WebsocketProvider(`${base}/ws/collab`, projectId, doc, {
        WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
        params: { doc: "src/App.tsx", token: a.token },
      });
      return { doc, p, text: doc.getText("content") };
    };
    const c1 = mk();
    const c2 = mk();
    await until(() => c1.p.synced && c2.p.synced);
    expect(c1.text.toString()).toBe("hello");
    c1.text.insert(5, " world");
    await until(() => c2.text.toString() === "hello world");
    c2.text.insert(0, ">> ");
    await until(() => c1.text.toString() === ">> hello world");

    c1.p.awareness.setLocalStateField("user", { name: "Ada" });
    await until(() => [...c2.p.awareness.getStates().values()].some((s) => (s as { user?: { name: string } }).user?.name === "Ada"));

    c1.p.destroy();
    c2.p.destroy();
    await until(async () => {
      const [f] = await deps.db.select().from(projectFiles).where(and(eq(projectFiles.projectId, projectId), eq(projectFiles.path, "src/App.tsx")));
      return f?.content === ">> hello world";
    });
  });

  it("rejects unauthenticated collaborators", async () => {
    const a = await signup(deps, `co2${uniq()}@test.local`);
    const { id: projectId } = await a.c.project.create({ workspaceId: a.workspaceId, name: "Private" });
    const ws = new WebSocket(`${base}/ws/collab/${projectId}?doc=a.ts`);
    const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
    expect(code).toBe(4403);
  });
});
