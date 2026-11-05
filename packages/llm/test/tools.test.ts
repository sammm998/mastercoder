import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTool, runTool, toToolDef } from "../src/index.js";

const add = defineTool({ name: "add", description: "Add", input: z.object({ a: z.number(), b: z.number() }), run: async ({ a, b }) => String(a + b) });

describe("tools", () => {
  it("converts to JSON schema", () => {
    const d = toToolDef(add);
    expect(d.inputSchema).toMatchObject({ type: "object", required: ["a", "b"] });
  });
  it("runs with validation and never throws", async () => {
    expect(await runTool([add], "add", { a: 1, b: 2 }, {})).toEqual({ ok: true, output: "3" });
    expect((await runTool([add], "add", { a: "x" }, {})).ok).toBe(false);
    expect((await runTool([add], "nope", {}, {})).output).toMatch(/Unknown tool/);
  });
});
