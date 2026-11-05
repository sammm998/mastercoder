import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import type { ForgeEvent } from "@forge/shared";
import { mergeEvents, toChatItems, latest, stripAnsi, toolResults } from "../src/lib/events";
import { colorFor, initials, minimalSplice, peersFromAwareness, remoteCursorCss, PEER_COLORS } from "../src/lib/collab";
import { buildTree, validPath } from "../src/features/editor/file-tree";
import { addSlide, isDeck, moveSlide, removeSlide, themeFrom, updateSlide, viewOf, type RawDeck } from "../src/features/slides/deck";
import { attachmentPath, isFigmaUrl, isTextFile, promptWithAttachments } from "../src/lib/attachments";
import { downsample, floatTo16BitPCM, TranscriptMessage } from "../src/lib/audio";
import { toHex, validLength } from "../src/features/preview/color";
import { projectNameFrom } from "../src/app/app/templates";
import { blockersFrom } from "../src/features/deploy/DeployPanel";
import { specTasks, summarizeTasks } from "../src/features/chat/EventCard";
import { readExtraction, timestamp, transcriptSegments } from "../src/features/meetings/extraction";
import { fieldKind, orderedKeys } from "../src/features/agents/DefinitionForm";
import { describeLogEntry } from "../src/features/agents/run-log";
import { editsFromDraft } from "../src/features/preview/VisualEditPanel";
import { lineFromSelector } from "../src/features/project/CommentsPanel";
import { assignable, atLeast } from "../src/lib/roles";
import { preferenceCookie, readConsent, readCookie } from "../src/lib/consent";

let n = 0;
const ev = <T extends ForgeEvent["type"]>(type: T, extra: Record<string, unknown> = {}, at?: string) =>
  ({ id: `evt_${++n}`, projectId: "prj_1", taskId: "tsk_1", at: at ?? new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), type, ...extra }) as unknown as Extract<ForgeEvent, { type: T }>;

describe("event stream", () => {
  it("merges history and live events without duplicates, in time order", () => {
    const a = ev("message", { role: "assistant", text: "a" });
    const b = ev("message", { role: "assistant", text: "b" });
    const c = ev("message", { role: "assistant", text: "c" });
    expect(mergeEvents([a, c], [b, c]).map((e) => e.id)).toEqual([a.id, b.id, c.id]);
    expect(mergeEvents([a], [])).toEqual([a]);
    const many = Array.from({ length: 30 }, () => ev("usage", { costUsd: 0, tokensIn: 0, tokensOut: 0 }));
    expect(mergeEvents([], many, 10)).toHaveLength(10);
  });

  it("collapses streaming deltas and replaces them with the final message", () => {
    const items = toChatItems([ev("message.delta", { text: "Hel" }), ev("message.delta", { text: "lo" }), ev("tool.call", { tool: "write_file", input: {}, callId: "c1" }), ev("message.delta", { text: "Do" }), ev("message", { role: "assistant", text: "Done." })]);
    expect(items.map((i) => i.text ?? i.event?.type)).toEqual(["Hello", "tool.call", "Done."]);
  });

  it("hides noisy events from chat and finds the latest preview", () => {
    const evs = [ev("presence", { userId: "u", name: "A" }), ev("terminal.output", { stream: "stdout", text: "x" }), ev("preview.ready", { url: "http://a" }), ev("preview.ready", { url: "http://b" })];
    expect(toChatItems(evs)).toHaveLength(2);
    expect(latest(evs, "preview.ready")?.url).toBe("http://b");
    expect(toolResults([ev("tool.result", { callId: "c1", ok: true, summary: "ok" })]).get("c1")?.ok).toBe(true);
  });

  it("strips ANSI colour codes", () => {
    expect(stripAnsi("\u001b[32m✓ passed\u001b[0m")).toBe("✓ passed");
  });

  it("summarises tasks for the final card", () => {
    const s = summarizeTasks([ev("gate.result", { gate: "lint", passed: true, details: "" }), ev("gate.result", { gate: "unit", passed: false, details: "" }), ev("design.score", { score: 7.5, notes: "" }), ev("design.score", { score: 8.6, notes: "" }), ev("screenshot", { url: "u", viewport: 375 })]).get("tsk_1")!;
    expect(s).toEqual({ gates: { passed: 1, total: 2 }, score: 8.6, shots: [{ url: "u", viewport: 375 }] });
  });

  it("reads task lists from specs of different shapes", () => {
    expect(specTasks({ tasks: ["a", { title: "b" }] })).toEqual(["a", "b"]);
    expect(specTasks({ steps: [{ name: "x" }] })).toEqual(["x"]);
    expect(specTasks(null)).toEqual([]);
  });
});

describe("collaboration helpers", () => {
  it("computes a minimal splice that a Y.Text can apply", () => {
    const before = "const a = 1;\nconst b = 2;\n";
    const after = "const a = 1;\nconst b = 3;\nconst c = 4;\n";
    const s = minimalSplice(before, after)!;
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, before);
    text.delete(s.index, s.remove);
    text.insert(s.index, s.insert);
    expect(text.toString()).toBe(after);
    expect(s.index).toBe(before.indexOf("2"));
    expect(minimalSplice("same", "same")).toBeNull();
    expect(minimalSplice("aaa", "aa")).toEqual({ index: 2, remove: 1, insert: "" });
  });

  it("assigns stable colours and initials", () => {
    expect(colorFor("Ada Lovelace")).toBe(colorFor("Ada Lovelace"));
    expect(PEER_COLORS).toContain(colorFor("Grace"));
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("grace@forge.test")).toBe("GT");
    expect(initials("")).toBe("?");
  });

  it("builds a peer list (self first) and cursor CSS for remote peers only", () => {
    const states = new Map<number, Record<string, unknown>>([
      [7, { user: { name: "Grace", color: "#2b9e8b" } }],
      [3, { user: { name: "Ada", color: "#ff6a2b" } }],
      [9, {}],
    ]);
    const peers = peersFromAwareness(states, 3);
    expect(peers.map((p) => [p.name, p.self])).toEqual([
      ["Ada", true],
      ["Grace", false],
    ]);
    const css = remoteCursorCss(peers);
    expect(css).toContain(".yRemoteSelectionHead-7");
    expect(css).not.toContain("-3{");
    expect(remoteCursorCss([{ clientId: 1, name: 'x"}body{display:none', color: "#000", self: false }])).not.toContain('x"}');
  });
});

describe("file tree", () => {
  it("nests folders first, alphabetically", () => {
    const t = buildTree(["src/b.ts", "README.md", "src/a/x.ts", "package.json"]);
    expect(t.map((n) => n.name)).toEqual(["src", "package.json", "README.md"]);
    expect(t[0]!.children!.map((n) => n.name)).toEqual(["a", "b.ts"]);
  });

  it("validates paths like the API", () => {
    expect(validPath("src/App.tsx")).toBe(true);
    expect(validPath("../etc/passwd")).toBe(false);
    expect(validPath("/abs")).toBe(false);
    expect(validPath("dir/")).toBe(false);
  });
});

describe("deck editing", () => {
  const deck: RawDeck = { title: "Pitch", theme: { palette: { bg: "#000000", text: "#ffffff", accent: "#ff0000" } }, slides: [{ id: "s1", layout: "title", title: "Hello", custom: 1 }, { id: "s2", layout: "content", title: "Why", bullets: ["a", "b"] }] };

  it("recognises decks and reads slides tolerantly", () => {
    expect(isDeck(deck)).toBe(true);
    expect(isDeck({ sections: [] })).toBe(false);
    expect(viewOf(deck.slides[1]!)).toMatchObject({ layout: "content", title: "Why", bullets: ["a", "b"], notes: "" });
  });

  it("edits text while preserving unknown fields", () => {
    const d = updateSlide(deck, 0, { title: "Hej", body: "" });
    expect(d.slides[0]).toEqual({ id: "s1", layout: "title", title: "Hej", custom: 1 });
    expect(updateSlide(deck, 1, { bullets: ["x", " ", "y"] }).slides[1]!.bullets).toEqual(["x", "y"]);
  });

  it("reorders, adds and removes slides", () => {
    expect(moveSlide(deck, 0, 1).slides.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(moveSlide(deck, 0, -1)).toBe(deck);
    const added = addSlide(deck, 0, "New");
    expect(added.slides).toHaveLength(3);
    expect(added.slides[1]).toMatchObject({ layout: "title", title: "New" });
    expect(typeof added.slides[1]!.id).toBe("string");
    expect(removeSlide(removeSlide(deck, 0), 0).slides).toHaveLength(1);
  });

  it("derives a theme from the deck or project tokens", () => {
    expect(themeFrom(null, deck)).toMatchObject({ bg: "#000000", text: "#ffffff", accent: "#ff0000" });
    expect(themeFrom({ colors: { primary: "#123456" }, typography: { display: { family: "Fraunces" } } }, null)).toMatchObject({ accent: "#123456", display: '"Fraunces", var(--font-display)' });
  });
});

describe("attachments", () => {
  it("classifies files and builds safe paths", () => {
    expect(isTextFile({ type: "text/csv", name: "a.csv" })).toBe(true);
    expect(isTextFile({ type: "", name: "notes.md" })).toBe(true);
    expect(isTextFile({ type: "image/png", name: "shot.png" })).toBe(false);
    expect(attachmentPath("../My Shot (1).png", 36, true)).toBe("attachments/10-My-Shot-1.png.dataurl");
    expect(attachmentPath("räksmörgås.txt", 1, false)).toMatch(/^attachments\/1-[\w.-]+\.txt$/);
  });

  it("accepts only figma.com links and references attachments in the prompt", () => {
    expect(isFigmaUrl("https://www.figma.com/design/abc")).toBe(true);
    expect(isFigmaUrl("https://figma.com.evil.io/x")).toBe(false);
    expect(isFigmaUrl("http://www.figma.com/x")).toBe(false);
    const p = promptWithAttachments("Build it", [{ path: "attachments/a.png.dataurl", name: "a.png", type: "image/png", binary: true }], "https://www.figma.com/file/1");
    expect(p).toContain("attachments/a.png.dataurl (image/png, base64 data URL");
    expect(p).toContain("Figma design: https://www.figma.com/file/1");
  });
});

describe("audio", () => {
  it("downsamples 48 kHz to 16 kHz by averaging", () => {
    const input = Float32Array.from({ length: 48 }, (_, i) => (i % 3 === 0 ? 0.3 : 0));
    const out = downsample(input, 48_000, 16_000);
    expect(out).toHaveLength(16);
    expect(out[0]).toBeCloseTo(0.1);
    expect(downsample(input, 16_000, 16_000)).toBe(input);
    expect(() => downsample(input, 8000, 16_000)).toThrow();
  });

  it("converts to clamped 16-bit PCM", () => {
    expect(Array.from(floatTo16BitPCM(Float32Array.from([0, 1, -1, 2, -2, 0.5])))).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });

  it("parses transcript messages from the speech gateway", () => {
    expect(TranscriptMessage.parse(JSON.stringify({ type: "transcript.partial", text: "hej" }))).toEqual({ type: "transcript.partial", text: "hej" });
    expect(TranscriptMessage.parse("not json")).toBeNull();
    expect(TranscriptMessage.parse(JSON.stringify({ type: "other" }))).toBeNull();
  });
});

describe("visual edit panel", () => {
  const base = { text: "Hi", color: "", background: "", padding: "", fontSize: "", addClasses: "", removeClasses: "", src: "", alt: "", href: "" };
  it("turns form changes into visual edits", () => {
    expect(editsFromDraft(base, base)).toEqual([]);
    expect(editsFromDraft(base, { ...base, text: "Hello", color: "#ff0000", addClasses: "p-4  rounded", removeClasses: "m-2" })).toEqual([
      { kind: "text", value: "Hello" },
      { kind: "style", prop: "color", value: "#ff0000" },
      { kind: "class", add: ["p-4", "rounded"], remove: ["m-2"] },
    ]);
    expect(editsFromDraft({ ...base, padding: "8px" }, { ...base, padding: "" })).toEqual([{ kind: "style", prop: "padding", value: null }]);
  });

  it("parses colours and lengths", () => {
    expect(toHex("rgb(255, 106, 43)")).toBe("#ff6a2b");
    expect(toHex("#abc")).toBe("#aabbcc");
    expect(toHex("rgba(0, 0, 0, 0)")).toBeNull();
    expect(toHex("hotpink")).toBeNull();
    expect(validLength("16px 24px")).toBe(true);
    expect(validLength("1rem")).toBe(true);
    expect(validLength("16px; color: red")).toBe(false);
  });
});

describe("misc helpers", () => {
  it("names projects from prompts", () => {
    expect(projectNameFrom("a booking site for my ceramics studio, with Swish payments and a waitlist")).toBe("A booking site for my ceramics studio, with");
    expect(projectNameFrom("  ")).toBe("Untitled");
  });

  it("finds deploy blockers from a gate report or live events", () => {
    expect(blockersFrom({ results: [{ gate: "semgrep", passed: false, details: "SQLi", fix: "Use params" }, { gate: "lint", passed: true, details: "" }, { gate: "e2e", passed: false, skipped: true, details: "" }] }, []).map((b) => b.gate)).toEqual(["semgrep"]);
    expect(blockersFrom(null, [ev("gate.result", { gate: "auth", passed: false, details: "open route" }), ev("gate.result", { gate: "auth", passed: true, details: "" })])).toEqual([]);
  });

  it("reads meeting transcripts and extractions of different shapes", () => {
    expect(transcriptSegments([{ speaker: 0, text: "Hej", start: 65 }])).toEqual([{ speaker: "Speaker 1", text: "Hej", startSec: 65 }]);
    expect(transcriptSegments({ segments: [{ text: "a", startMs: 2000 }] })[0]!.startSec).toBe(2);
    expect(transcriptSegments("plain")).toHaveLength(1);
    expect(readExtraction({ summary: "S", decisions: ["d"], questions: [{ text: "q?" }] })).toMatchObject({ summary: "S", decisions: ["d"], openQuestions: ["q?"] });
    expect(timestamp(125)).toBe("02:05");
  });

  it("chooses editors for agent definition fields", () => {
    expect(fieldKind("instructions", "x")).toBe("longtext");
    expect(fieldKind("name", "short")).toBe("text");
    expect(fieldKind("tools", ["a"])).toBe("list");
    expect(fieldKind("trigger", { type: "cron" })).toBe("json");
    expect(fieldKind("costCapUsd", 2)).toBe("number");
    expect(orderedKeys({ zeta: 1, tools: [], instructions: "" })).toEqual(["instructions", "tools", "zeta"]);
    expect(describeLogEntry({ type: "tool", tool: "gmail.send", costUsd: 0.01, input: { to: "x" } })).toMatchObject({ title: "tool · gmail.send", costUsd: 0.01 });
  });

  it("parses comment line selectors and role rules", () => {
    expect(lineFromSelector("line:12")).toBe(12);
    expect(lineFromSelector('[data-forge-src="a:1:1"]')).toBeNull();
    expect(assignable("admin")).toEqual(["editor", "viewer"]);
    expect(assignable("owner")).toEqual(["owner", "admin", "editor", "viewer"]);
    expect(atLeast("editor", "admin")).toBe(false);
    expect(atLeast("owner", "admin")).toBe(true);
    expect(atLeast(null, "viewer")).toBe(false);
  });

  it("only persists preference cookies with consent", () => {
    expect(readCookie("forge_consent", "a=1; forge_consent=all")).toBe("all");
    expect(readConsent("forge_consent=nope")).toBeUndefined();
    expect(preferenceCookie("forge_locale", "sv", "all")).toContain("max-age=31536000");
    expect(preferenceCookie("forge_locale", "sv", "essential")).not.toContain("max-age");
    expect(preferenceCookie("forge_locale", "sv", undefined)).not.toContain("max-age");
  });
});
