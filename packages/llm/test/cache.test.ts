import { describe, it, expect } from "vitest";
import { withHistoryCache } from "../src/adapters/anthropic.js";

describe("incremental prompt caching", () => {
  it("marks the last cacheable block of the last message, leaving earlier turns untouched", () => {
    const msgs = [
      { role: "user" as const, content: "build it" },
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name: "write_file", input: {} }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t1", content: "ok" }] },
    ];
    const out = withHistoryCache(msgs);
    expect(out[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "ok", cache_control: { type: "ephemeral" } }]);
    expect(out[0]).toBe(msgs[0]);
    expect(msgs[2]!.content[0]).not.toHaveProperty("cache_control");
  });
  it("turns a plain string last message into a cached text block", () => {
    expect(withHistoryCache([{ role: "user", content: "hi" }])[0]!.content).toEqual([{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }]);
  });
});
