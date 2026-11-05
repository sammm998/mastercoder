import { describe, it, expect } from "vitest";

describe("build pipeline", () => {
  // The worker degrades to "build pipeline unavailable" if this module fails to load, so guard it here.
  it("build-wiring loads (all agent-core, design and gates sources compile)", async () => {
    const mod = await import("../src/build-wiring.js");
    expect(typeof mod.wireBuild).toBe("function");
  }, 60_000);
});
