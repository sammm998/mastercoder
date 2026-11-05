import { describe, expect, it } from "vitest";
import { MemoryUsageSink } from "@forge/shared";
import { MockLLMProvider } from "@forge/llm";
import {
  LLMChatProvider,
  MemorySpendTracker,
  MockGatewayImageProvider,
  MockGatewaySttProvider,
  MockGatewayTtsProvider,
  createProjectToken,
  handleGatewayRequest,
  verifyProjectToken,
  type GatewayDeps,
} from "../src/index.js";

const SECRET = "test-secret-test-secret-test-secret-123";
const token = createProjectToken({ projectId: "prj_1", workspaceId: "ws_1", scope: ["ai"] }, SECRET);

function deps(over: Partial<GatewayDeps> = {}): GatewayDeps & { usage: MemoryUsageSink; spend: MemorySpendTracker } {
  return {
    verifyToken: (t) => verifyProjectToken(t, SECRET, "ai"),
    spend: new MemorySpendTracker({ prj_1: 1 }),
    usage: new MemoryUsageSink(),
    providers: { chat: new LLMChatProvider(new MockLLMProvider()), image: new MockGatewayImageProvider(), stt: new MockGatewaySttProvider(), tts: new MockGatewayTtsProvider() },
    ...over,
  } as GatewayDeps & { usage: MemoryUsageSink; spend: MemorySpendTracker };
}

function req(route: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://ai.forge.test/v1/${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("project tokens", () => {
  it("verify only untampered, unexpired, in-scope tokens", () => {
    expect(verifyProjectToken(token, SECRET)?.projectId).toBe("prj_1");
    expect(verifyProjectToken(token, "another-secret-another-secret-xxxxxx")).toBeNull();
    expect(verifyProjectToken(`${token.slice(0, -2)}xx`, SECRET)).toBeNull();
    expect(verifyProjectToken(token, SECRET, "ingest")).toBeNull();
    const expired = createProjectToken({ projectId: "p", exp: 100 }, SECRET);
    expect(verifyProjectToken(expired, SECRET, undefined, 200)).toBeNull();
    expect(verifyProjectToken("garbage", SECRET)).toBeNull();
    expect(() => createProjectToken({ projectId: "p" }, "short")).toThrow();
  });
});

describe("handleGatewayRequest", () => {
  it("chats through the LLM provider and meters usage with cost", async () => {
    const d = deps();
    const res = await handleGatewayRequest(req("chat", { messages: [{ role: "user", content: "Hej!" }], tier: "fast" }), d);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; costUsd: number; usage: { inputTokens: number } };
    expect(body.text).toContain("[mock reply]");
    expect(body.usage.inputTokens).toBeGreaterThan(0);
    expect(d.usage.records.map((r) => r.kind)).toEqual(["llm_input_tokens", "llm_output_tokens"]);
    expect(d.usage.records.every((r) => r.projectId === "prj_1" && r.workspaceId === "ws_1")).toBe(true);
    expect(d.usage.totalUsd()).toBeCloseTo(body.costUsd, 10);
    expect(d.spend.spentUsd("prj_1")).toBeCloseTo(body.costUsd, 10);
  });

  it("rejects missing/invalid tokens and browser calls", async () => {
    expect((await handleGatewayRequest(req("chat", {}, { authorization: "" }), deps())).status).toBe(401);
    expect((await handleGatewayRequest(req("chat", {}, { authorization: "Bearer fpt_x.y" }), deps())).status).toBe(401);
    const browser = await handleGatewayRequest(req("chat", { messages: [{ role: "user", content: "x" }] }, { origin: "https://evil.example" }), deps());
    expect(browser.status).toBe(403);
    expect(await browser.json()).toMatchObject({ error: "server_side_only" });
  });

  it("validates input with zod", async () => {
    const res = await handleGatewayRequest(req("chat", { messages: [] }), deps());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    const bad = new Request("https://ai.forge.test/v1/chat", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{not json" });
    expect((await handleGatewayRequest(bad, deps())).status).toBe(400);
    expect((await handleGatewayRequest(req("image", { prompt: "x", size: "9x9" }), deps())).status).toBe(400);
  });

  it("enforces the spending cap before calling the provider", async () => {
    const d = deps();
    d.spend.add("prj_1", 0.99999);
    const res = await handleGatewayRequest(req("chat", { messages: [{ role: "user", content: "x".repeat(10_000) }], maxTokens: 8000, tier: "smart" }), d);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "spend_cap", capUsd: 1 });
    expect(d.usage.records).toHaveLength(0);
  });

  it("routes image, speech-to-text and text-to-speech", async () => {
    const d = deps();
    const img = await handleGatewayRequest(req("image", { prompt: "a fox", n: 2 }), d);
    const imgBody = (await img.json()) as { images: Array<{ mediaType: string; data: string }> };
    expect(imgBody.images).toHaveLength(2);
    expect(Buffer.from(imgBody.images[0]?.data ?? "", "base64").toString()).toContain("[mock image]");

    const stt = await handleGatewayRequest(req("stt", { audio: Buffer.alloc(32_000).toString("base64"), mediaType: "audio/webm", language: "sv" }), d);
    expect(await stt.json()).toMatchObject({ durationSec: 2, language: "sv" });

    const tts = await handleGatewayRequest(req("tts", { text: "Hej världen" }), d);
    expect(tts.headers.get("content-type")).toBe("audio/wav");
    expect(tts.headers.get("x-forge-cost-usd")).toBe("0");
    const wav = Buffer.from(await tts.arrayBuffer());
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");

    expect(d.usage.records.map((r) => r.kind)).toEqual(["image_count", "transcription_minutes", "media_seconds"]);
  });

  it("returns 404/405/501 for unknown routes, wrong methods and unconfigured providers", async () => {
    expect((await handleGatewayRequest(req("video", {}), deps())).status).toBe(404);
    expect((await handleGatewayRequest(new Request("https://ai.forge.test/v1/chat"), deps())).status).toBe(405);
    expect((await handleGatewayRequest(req("tts", { text: "x" }), deps({ providers: {} }))).status).toBe(501);
  });

  it("maps provider failures to 502 without leaking details", async () => {
    const failing = deps({ providers: { chat: { name: "boom", chat: async () => Promise.reject(new Error("upstream key sk-123 invalid")) } } });
    const res = await handleGatewayRequest(req("chat", { messages: [{ role: "user", content: "x" }] }), failing);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("sk-123");
  });
});
