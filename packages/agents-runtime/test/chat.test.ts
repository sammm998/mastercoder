import { describe, it, expect } from "vitest";
import { chatMessages, ChatInputSchema } from "../src/runner.js";

describe("agent chat", () => {
  it("turns the conversation into alternating messages ending with the new user message", () => {
    const input = ChatInputSchema.parse({
      message: "And tomorrow?",
      history: [
        { role: "assistant", text: "Hi! (greeting before any user turn is dropped)" },
        { role: "user", text: "Weather in Malmö?" },
        { role: "assistant", text: "Sunny, 12°C." },
      ],
    });
    const m = chatMessages(input, "2026-11-06T10:00:00Z");
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
    expect(m[2]!.content).toMatch(/^And tomorrow\?/);
  });
  it("merges consecutive turns from the same side", () => {
    const m = chatMessages(ChatInputSchema.parse({ message: "c", history: [{ role: "user", text: "a" }, { role: "user", text: "b" }] }), "t");
    expect(m).toHaveLength(1);
    expect(m[0]!.content).toMatch(/a\n\nb\n\nc/);
  });
});
