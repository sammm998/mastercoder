import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EventBus, MemoryUsageSink, type IntentKind, type PromptSource } from "@forge/shared";
import { MockLLMProvider } from "@forge/llm";
import { classify, classifyByRules, detectLanguage, estimate } from "../src/index.js";
import { LABELLED } from "./labelled.js";

const llm = new MockLLMProvider();
const set = (ks: IntentKind[]) => [...ks].sort().join(",");

const BENCH = readFileSync(fileURLToPath(new URL("../../../evals/benchmark.md", import.meta.url)), "utf8")
  .split("\n")
  .filter((l) => /^\| \d\d \|/.test(l))
  .map((l) => l.split("|").map((c) => c.trim()))
  .map((c) => ({ id: `${c[1]}-${c[2]}`, prompt: c[3]!, expected: c[4]!.split(",").map((s) => s.trim()) as IntentKind[] }));

function sourceOf(prompt: string): PromptSource {
  return /^\(Voice/i.test(prompt) ? "voice" : /^\(Recorded/i.test(prompt) ? "meeting" : "typed";
}

describe("labelled prompts (mock mode)", () => {
  it("has >= 50 prompts in Swedish and English", () => {
    expect(LABELLED.length).toBeGreaterThanOrEqual(50);
    expect(LABELLED.filter((l) => l.lang === "sv").length).toBeGreaterThanOrEqual(25);
    expect(LABELLED.filter((l) => l.lang === "en").length).toBeGreaterThanOrEqual(25);
  });

  it("classifies >= 90% with the exact intent set, and detects the language", async () => {
    const misses: string[] = [];
    let langOk = 0;
    for (const l of LABELLED) {
      const r = await classify(l.prompt, { llm });
      if (set(r.intents.map((i) => i.kind)) !== set(l.expected)) misses.push(`${l.prompt} -> ${set(r.intents.map((i) => i.kind))} (expected ${set(l.expected)})`);
      if (r.language === l.lang) langOk++;
      expect(r.engine).toBe("mock-rules");
    }
    const accuracy = 1 - misses.length / LABELLED.length;
    expect(accuracy, `exact-set accuracy ${(accuracy * 100).toFixed(1)}%; misses:\n${misses.join("\n")}`).toBeGreaterThanOrEqual(0.9);
    expect(langOk / LABELLED.length).toBeGreaterThanOrEqual(0.95);
  });
});

describe("benchmark prompts (evals/benchmark.md)", () => {
  it("parses all 20 rows", () => expect(BENCH).toHaveLength(20));
  it.each(BENCH)("$id -> $expected", async ({ prompt, expected }) => {
    const r = await classify(prompt, { llm, source: sourceOf(prompt) });
    expect(set(r.intents.map((i) => i.kind))).toBe(set(expected));
    expect(r.needsClarification).toBe(false);
    expect(r.question).toBeUndefined();
    expect(r.estimate.highUsd).toBeGreaterThan(0);
  });

  it("produces the hints and quantities downstream packages need", async () => {
    const by = async (n: string) => {
      const b = BENCH.find((x) => x.id.startsWith(n))!;
      return classify(b.prompt, { llm, source: sourceOf(b.prompt) });
    };
    const hint = (r: Awaited<ReturnType<typeof by>>, k: IntentKind) => r.intents.find((i) => i.kind === k)?.hint;
    expect(hint(await by("08"), "mobile")).toBe("expo");
    expect(hint(await by("09"), "backend")).toBe("fastapi");
    const gen = await by("11");
    expect(hint(gen, "video")).toBe("generative");
    expect(gen.estimate.breakdown.some((p) => p.label === "video: 10 s generation")).toBe(true);
    const rem = await by("12");
    expect(hint(rem, "video")).toBe("remotion");
    expect(rem.estimate.breakdown.some((p) => /render 20 s/.test(p.label))).toBe(true);
    expect((await by("13")).estimate.breakdown.some((p) => p.label.startsWith("slides: 10 slides"))).toBe(true);
    expect((await by("10")).estimate.breakdown.some((p) => p.label === "image: 4 images")).toBe(true);
    const weekly = await by("15");
    expect(hint(weekly, "agent")).toBe("cron");
    expect(hint(weekly, "integration")).toBe("hubspot");
    expect(hint(await by("17"), "integration")).toBe("openapi");
    expect((await by("20")).language).toBe("sv");
    expect(hint(await by("16"), "agent")).toBe("chat");
  });
});

describe("multi-label", () => {
  it("splits one prompt into several deliverables", async () => {
    const r = await classify("Build a landing page for Nordlys with a hero video, and make a 12-slide pitch deck for investors.", { llm });
    expect(set(r.intents.map((i) => i.kind))).toBe("slides,video,website");
    const sv = await classify("Bygg en landningssida, en hero-video och ett pitchdeck för vårt bryggeri.", { llm });
    expect(set(sv.intents.map((i) => i.kind))).toBe("slides,video,website");
    expect(sv.language).toBe("sv");
    expect(r.estimate.breakdown.some((p) => p.label.startsWith("slides: 12 slides"))).toBe(true);
    expect(r.estimate.highUsd).toBeCloseTo(estimate({ intents: r.intents, complexity: r.complexity, slides: 12 }).highUsd, 4);
  });
});

describe("clarification rule: ambiguous AND expensive -> exactly one question", () => {
  it("asks when nothing concrete is requested (expensive default)", async () => {
    const r = await classify("Bygg något åt min frisörsalong", { llm });
    expect(r.ambiguous).toBe(true);
    expect(r.needsClarification).toBe(true);
    expect(r.question).toBe("Vad vill du att jag ska bygga?");
    expect(r.question!.match(/\?/g)).toHaveLength(1);
    expect(r.options).toEqual(["Webbplats", "Webbapp", "Mobilapp"]);
  });

  it("asks when the user names conflicting alternatives", async () => {
    const r = await classify("I want an app or maybe just a website for my bakery, not sure.", { llm });
    expect(r.needsClarification).toBe(true);
    expect(r.question).toMatch(/^Should this be a (web app|website) or a (web app|website)\?$/);
    expect(r.options).toHaveLength(2);
    const sv = await classify("Vi vill ha en hemsida eller en app för vår förening", { llm });
    expect(sv.needsClarification).toBe(true);
    expect(sv.question).toMatch(/^Ska det bli .* eller .*\?$/);
  });

  it("asks for an underspecified expensive build", async () => {
    const r = await classify("Make an app", { llm });
    expect(r.needsClarification).toBe(true);
    expect(r.question).toBe("What should the web app do, and who is it for?");
    expect(r.options!.length).toBeGreaterThan(1);
  });

  it("does not ask when ambiguous but cheap to redo", async () => {
    for (const p of ["Gör en bild", "Make a logo", "Write a document"]) {
      const r = await classify(p, { llm });
      expect(r.ambiguous, p).toBe(true);
      expect(r.estimate.highUsd, p).toBeLessThan(1.5);
      expect(r.needsClarification, p).toBe(false);
      expect(r.question, p).toBeUndefined();
    }
  });

  it("does not ask when clear, even if expensive", async () => {
    const r = await classify("Build a complex multi-tenant SaaS CRM with roles, Stripe billing, realtime chat, analytics dashboards and audit logs.", { llm });
    expect(r.complexity).toBe("complex");
    expect(r.estimate.highUsd).toBeGreaterThan(5);
    expect(r.needsClarification).toBe(false);
  });

  it("threshold is configurable (option and env)", async () => {
    expect((await classify("Make an app", { llm, clarifyAboveUsd: 100 })).needsClarification).toBe(false);
    expect((await classify("Make a logo", { llm, clarifyAboveUsd: 0.01 })).needsClarification).toBe(true);
    process.env.INTENT_CLARIFY_ABOVE_USD = "100";
    try {
      expect((await classify("Make an app", { llm })).needsClarification).toBe(false);
    } finally {
      delete process.env.INTENT_CLARIFY_ABOVE_USD;
    }
  });

  it("answers pure questions without clarification", async () => {
    for (const p of ["How do I add a custom domain?", "Vad kostar Pro-planen?", "Can I export my project to GitHub?"]) {
      const r = await classify(p, { llm });
      expect(r.intents.map((i) => i.kind), p).toEqual(["question"]);
      expect(r.needsClarification).toBe(false);
    }
    expect((await classify("Can you build me a CRM for my agency?", { llm })).intents.map((i) => i.kind)).toEqual(["app"]);
    expect((await classify("Kan du göra en logga åt mig?", { llm })).intents.map((i) => i.kind)).toEqual(["image"]);
  });
});

describe("LLM path", () => {
  it("uses MODEL_FAST, purpose intent.classify and post-processes model output deterministically", async () => {
    const model = new MockLLMProvider().on("intent.classify", () =>
      JSON.stringify({ language: "en", intents: [{ kind: "app", confidence: 0.55, summary: "app" }, { kind: "website", confidence: 0.5, summary: "site" }], ambiguous: false, complexity: "normal", quantities: {} }),
    );
    const r = await classify("Something for my shop", { llm: model, source: "api" });
    expect(model.calls[0]!.purpose).toBe("intent.classify");
    expect(model.calls[0]!.model).toBe(process.env.MODEL_FAST || "claude-haiku-5-5");
    expect(JSON.parse(model.calls[0]!.messages[0]!.content as string)).toMatchObject({ prompt: "Something for my shop", source: "api" });
    // low confidence + conflicting build targets + expensive -> one question even though the model said not ambiguous
    expect(r.ambiguous).toBe(true);
    expect(r.needsClarification).toBe(true);
    expect(r.question).toBe("What is the most important thing for me to build first?");
    expect(r.options).toEqual(["Web app", "Website"]);
    expect(r.engine).toBe("mock-rules");
  });

  it("keeps only the first question if the model returns several", async () => {
    const model = new MockLLMProvider().on("intent.classify", () =>
      JSON.stringify({ language: "en", intents: [{ kind: "app", confidence: 0.3, summary: "x" }], ambiguous: true, question: "What should it do? And for whom?", options: ["A", "B"], complexity: "normal", quantities: {} }),
    );
    const r = await classify("x", { llm: model });
    expect(r.question).toBe("What should it do?");
    expect(r.options).toEqual(["A", "B"]);
  });

  it("falls back to rules when the model output stays invalid", async () => {
    const model = new MockLLMProvider().on("intent.classify", () => "I think it's an app!");
    const r = await classify("Build a booking system for my gym", { llm: model });
    expect(r.engine).toBe("rules-fallback");
    expect(r.intents.map((i) => i.kind)).toEqual(["app"]);
    expect(model.calls).toHaveLength(2); // structured() retried once
  });

  it("meters the call and emits events", async () => {
    const usage = new MemoryUsageSink();
    const bus = new EventBus();
    await classify("Make a website or an app for my band", { llm, usage, events: bus, projectId: "prj_1", taskId: "tsk_1", meter: { workspaceId: "ws_1" } });
    expect(usage.records.length).toBeGreaterThan(0);
    expect(usage.records.every((r) => r.workspaceId === "ws_1" && r.taskId === "tsk_1")).toBe(true);
    expect(bus.history.map((e) => e.type)).toEqual(["intent.classified", "cost.estimate", "clarify.question"]);
  });

  it("validates input", async () => {
    await expect(classify("   ", { llm })).rejects.toMatchObject({ code: "BAD_INPUT" });
    await expect(classify("hi", { llm, source: "fax" as PromptSource })).rejects.toThrow();
  });
});

describe("rules helpers", () => {
  it("detects language and uses attachments (meeting transcripts)", () => {
    expect(detectLanguage("Bygg en app åt mig")).toBe("sv");
    expect(detectLanguage("Build me an app")).toBe("en");
    const r = classifyByRules("Build what we discussed.", { source: "meeting", attachments: [{ name: "mote.txt", text: "Vi behöver ett bokningssystem för salongen och en enkel hemsida." }] });
    expect(set(r.intents.map((i) => i.kind))).toBe("app,website");
    expect(r.ambiguous).toBe(false);
  });

  it("does not treat feature mentions as deliverables", () => {
    expect(classifyByRules("Build an app where users upload documents and photos.").intents.map((i) => i.kind)).toEqual(["app"]);
    expect(classifyByRules("Build a mobile-friendly website for my gym.").intents.map((i) => i.kind)).toEqual(["website"]);
    expect(classifyByRules("Build an app for scheduling video calls with clients.").intents.map((i) => i.kind)).toEqual(["app"]);
    expect(classifyByRules("Build a WhatsApp-style chat app.").intents.map((i) => i.kind)).toContain("app");
  });
});
