import { describe, expect, it } from "vitest";
import { classifyPreview, isSafeWebUrl } from "../src/lib/preview.js";
import { qrMatrix, qrPath } from "../src/lib/qr.js";
import { meetingView } from "../src/lib/meeting.js";
import { extractMagicToken, isValidEmail } from "../src/lib/auth.js";
import { formatBytes, formatDuration, formatUsd, formatUsdRange } from "../src/lib/format.js";

describe("preview classification", () => {
  it("opens exp:// links in Expo Go", () => {
    expect(classifyPreview("exp://10.0.0.2:8081", "nextjs")).toEqual({ kind: "expo", expoUrl: "exp://10.0.0.2:8081", sourceUrl: "exp://10.0.0.2:8081" });
  });
  it("converts http(s) URLs of Expo projects", () => {
    expect(classifyPreview("https://p-8081.sandbox.forge.dev/", "expo")).toMatchObject({ kind: "expo", expoUrl: "exps://p-8081.sandbox.forge.dev" });
    expect(classifyPreview("http://10.0.0.2:8081/?platform=ios", "expo")).toMatchObject({ expoUrl: "exp://10.0.0.2:8081?platform=ios" });
  });
  it("uses a WebView for web projects and rejects unsafe schemes", () => {
    expect(classifyPreview("https://p-3000.sandbox.forge.dev", "nextjs")).toEqual({ kind: "web", url: "https://p-3000.sandbox.forge.dev/" });
    expect(classifyPreview("javascript:alert(1)")).toBeNull();
    expect(classifyPreview("not a url")).toBeNull();
    expect(classifyPreview(null)).toBeNull();
    expect(isSafeWebUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeWebUrl("https://x.dev")).toBe(true);
  });
});

describe("QR", () => {
  it("produces a square matrix with finder patterns", () => {
    const m = qrMatrix("exp://10.0.0.2:8081");
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect(m.every((r) => r.length === m.length)).toBe(true);
    // Top-left finder pattern: 7 dark modules in the first row.
    expect(m[0]!.slice(0, 7).every(Boolean)).toBe(true);
    const { d, size } = qrPath(m);
    expect(size).toBe(m.length + 8);
    expect(d.startsWith("M4 4h7")).toBe(true);
  });
});

describe("meeting view", () => {
  it("reads common extraction/spec shapes", () => {
    const v = meetingView({
      status: "ready",
      extraction: {
        summary: "Kickoff for the booking app",
        requirements: ["Users can book", { text: "Admin can cancel", priority: "must" }, { nothing: 1 }],
        decisions: [{ text: "Use Swish" }],
        actionItems: [{ text: "Send designs", owner: "Anna" }],
      },
      spec: { title: "Booking", buildPrompt: "Build a booking app", features: ["Calendar", { name: "Payments" }] },
    });
    expect(v.summary).toBe("Kickoff for the booking app");
    expect(v.requirements).toEqual([{ text: "Users can book" }, { text: "Admin can cancel", priority: "must" }]);
    expect(v.decisions).toEqual(["Use Swish"]);
    expect(v.actionItems).toEqual([{ text: "Send designs", owner: "Anna" }]);
    expect(v.spec).toMatchObject({ title: "Booking", buildPrompt: "Build a booking app", features: ["Calendar", "Payments"] });
    expect(v.canApprove).toBe(true);
  });
  it("handles a meeting still processing", () => {
    const v = meetingView({ status: "processing", extraction: null, spec: null });
    expect(v).toMatchObject({ summary: null, requirements: [], canApprove: false });
  });
});

describe("auth helpers", () => {
  it("extracts magic-link tokens from links or bare tokens", () => {
    expect(extractMagicToken("https://app.forge.dev/auth/magic?token=abcDEF123_-xyz")).toBe("abcDEF123_-xyz");
    expect(extractMagicToken("forge://auth/magic?token=abc%2Bdef0123456")).toBe("abc+def0123456");
    expect(extractMagicToken("  abcdefghijklmnop  ")).toBe("abcdefghijklmnop");
    expect(extractMagicToken("short")).toBeNull();
    expect(extractMagicToken("")).toBeNull();
  });
  it("validates emails", () => {
    expect(isValidEmail("a@b.se")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
  });
});

describe("format", () => {
  it("formats money and durations per locale", () => {
    expect(formatUsd(1.5, "en")).toBe("$1.50");
    expect(formatUsd(1.5, "sv").replace(/\s/g, " ")).toMatch(/1,50 US\$|1,50 \$/);
    expect(formatUsdRange(0.2, 0.2, "en")).toBe("$0.20");
    expect(formatUsdRange(0.2, 1, "en")).toBe("$0.20 – $1.00");
    expect(formatDuration(7_000)).toBe("0:07");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
    expect(formatBytes(5 * 1024 * 1024, "en")).toBe("5 MB");
  });
});
